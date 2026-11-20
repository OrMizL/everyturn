import { describe, expect, it } from "vitest";
import {
  analyze, buildPosterModel, buildReport, compileDenylist, detectFindings, extractImports, extractRules, MAX_IMPORT_DEPTH, normalizeRule, posterFindings,
  renderPosterSvg, renderSourcesTableHtml, resolveImport, snippetSafety, type RawSource,
} from "../src/index";

const j = (...parts: string[]) => parts.join("");
const raw = (logicalPath: string, text: string, scope: RawSource["scope"] = "project"): RawSource => ({ logicalPath, text, scope });
const report = (...files: [string, string][]) => buildReport(files.map(([p, t]) => raw(p, t)), { dataset: "sample" });
const kinds = (r: ReturnType<typeof report>) => r.findings.map((f) => f.kind);
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
const texts = (svg: string) => [...svg.matchAll(/<text [^>]*>(.*?)<\/text>/g)].map((m) => decode(m[1]!.replace(/<[^>]+>/g, "")));

describe("normalization", () => {
  const norm = (s: string) => normalizeRule(s).norm;
  it("folds curly quotes, BOM, zero-width, bidi, soft hyphen and CRLF before matching", () => {
    expect(norm("Don’t skip tests")).toBe(norm("Don't skip tests"));
    expect(norm("﻿Ne​ver⁠ sk­ip‮ tests\r\n")).toBe("never skip tests");
    expect(norm("“Never” skip tests")).toBe("never skip tests");
    expect(norm("ｎｅｖｅｒ skip tests")).toBe("never skip tests"); // NFKC
  });
  it("expands contractions before punctuation is stripped", () => {
    expect(norm("Don't")).toBe("do not");
    expect(norm("You won't need it")).toBe("you will not need it");
    expect(norm("It can't fail")).toBe("it cannot fail");
    expect(norm("shouldn’t")).toBe("should not");
  });
  it("protects code spans, identifiers and values from case folding", () => {
    expect(normalizeRule("Set `NODE_ENV` to production in CI_RUNNER and use 2-space indentation").words)
      .toEqual(["set", "`NODE_ENV`", "to", "production", "in", "CI_RUNNER", "and", "use", "2-space", "indentation"]);
  });
  it("keeps negation, modality, numbers and tool names as tokens, and drops stopwords", () => {
    expect(normalizeRule("You must never use the `npm` cache for 3 builds").tokens).toEqual(["must", "never", "use", "`npm`", "cache", "3", "build"]);
  });
  it("hidden characters cannot flip a never", () => {
    const hidden = analyze(extractRules("s", "- Ne​ver skip tests.\n")[0]!);
    expect(hidden.clauses[0]!.polarity).toBe("pos");
  });
});

describe("rule extraction", () => {
  const text = "﻿---\ntitle: x\n---\n# Top\n## Workflow\n- Always run tests.\n\n```\n- Never run this\n```\n1. Keep PRs small.\n   Continue here.\n\nBe nice to people.\nNever force-push. Always rebase.\n> Never quote this\n";
  it("skips frontmatter and fences, keeps 1-based lines and headings", () => {
    const rules = extractRules("s1", text);
    expect(rules.map((r) => [r.line, r.text])).toEqual([
      [6, "Always run tests."], [11, "Keep PRs small."], [11, "Continue here."], [14, "Be nice to people."], [15, "Never force-push."], [15, "Always rebase."],
    ]);
    expect(rules[0]!.heading).toBe("Top > Workflow");
  });
  it("ignores non-directive prose and blockquotes", () => {
    expect(extractRules("s", "Be nice to people.\nThis repo is a monorepo.\n> Never quote this\n").map((r) => r.text)).toEqual(["Be nice to people."]);
  });
});

describe("polarity", () => {
  const pol = (t: string) => analyze(extractRules("s", `- ${t}\n`)[0]!).clauses[0]!.polarity;
  it.each([
    ["Run tests.", "pos"], ["Never skip tests.", "pos"], ["Don't avoid tests.", "pos"], ["Do not forget to run tests.", "pos"],
    ["Skip tests.", "neg"], ["Don't run tests.", "neg"], ["No comments.", "neg"], ["You must not push.", "neg"], ["Prefer not to mock.", "neg"],
    ["Don't always run tests.", "weak"], ["Ignore the cache.", "neg"], ["Refrain from logging.", "neg"], ["Stop retrying.", "neg"],
  ])("%s -> %s", (t, p) => expect(pol(t)).toBe(p));
  it("starts a new clause at unless/except/without and marks the rule conditional", () => {
    const a = analyze(extractRules("s", "- Skip e2e unless CI is red.\n")[0]!);
    expect(a.conditional).toBe(true);
    expect(a.clauses).toHaveLength(1);
    // "unless asked" is as conditional as "unless approved" (both low confidence), never a high conflict.
    expect(analyze(extractRules("s", "- Skip e2e unless asked.\n")[0]!).conditional).toBe(true);
  });
});

describe("findings", () => {
  it("groups exact duplicates across distinct files and reports in-file repeats separately", () => {
    const r = report(["CLAUDE.md", "- Keep pull requests small.\n- Keep pull requests small.\n"], ["CLAUDE.local.md", "- Keep pull requests small.\n"], ["AGENTS.md", "- Keep   Pull Requests small!\n"]);
    const dup = r.findings.filter((f) => f.kind === "duplicate");
    expect(dup).toHaveLength(1);
    expect(dup[0]!.evidence.map((e) => e.path)).toEqual(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]);
    expect(dup[0]!.confidence).toBe("high");
    const rep = r.findings.filter((f) => f.kind === "repeated-in-file");
    expect(rep).toHaveLength(1);
    expect(rep[0]!.evidence.map((e) => e.line)).toEqual([1, 2]);
    expect(r.findingCounts.repeatedInFile).toBe(1);
    expect(r.findingCounts.headline.duplicates).toBe(0 + 1);
  });
  it("records score and threshold for near-duplicates and applies the six-token floor", () => {
    const six = report(["CLAUDE.md", "- Write a regression test for every bug fix.\n"], ["CLAUDE.local.md", "- Write a regression test for every bug fix first.\n"]);
    const f = six.findings.find((x) => x.kind === "near-duplicate")!;
    expect(f.score).toBeCloseTo(0.857, 3);
    expect(f.threshold).toBe(0.85);
    // 5 tokens + 1 = 5/6 = 0.833: below the floor.
    expect(kinds(report(["CLAUDE.md", "- Write a regression test for bugs.\n"], ["CLAUDE.local.md", "- Write a regression test for bugs first.\n"]))).not.toContain("near-duplicate");
  });
  it("a polarity-opposed near-match is a conflict candidate, never a near-duplicate", () => {
    const r = report(["CLAUDE.md", "- Run tests before every commit.\n"], ["CLAUDE.local.md", "- Don't run tests before every commit.\n"]);
    expect(kinds(r)).toEqual(["conflict"]);
    expect(r.findings[0]).toMatchObject({ confidence: "high", rule: "polarity", applicability: "Both load at repo root.", precedence: "No clear precedence; which one wins is unknown." });
  });
  it("different agents get a note and never reach the headline counts", () => {
    const r = report(["CLAUDE.md", "- Use tabs for indentation.\n"], ["AGENTS.md", "- Use 4-space indentation.\n"]);
    expect(r.findings[0]!.applicability).toBe("Different agents: Claude Code vs Codex.");
    expect(r.findings[0]!.confidence).toBe("low");
    expect(r.findingCounts.headline.conflicts).toBe(0);
  });
  it("conditional language and narrower scope lower confidence to low", () => {
    expect(report(["CLAUDE.md", "- Run the full suite when changing shared code.\n"], ["CLAUDE.local.md", "- Skip the full suite when changing docs.\n"]).findings.every((f) => f.confidence === "low")).toBe(true);
    expect(report(["CLAUDE.md", "- Prefer named exports over default exports.\n"], ["CLAUDE.local.md", "- Prefer default exports for React components.\n"]).findings[0]!.confidence).toBe("low");
  });
  it("nested files say where they apply, and separate directories are low", () => {
    const nested = buildReport([raw("CLAUDE.md", "- Use tabs for indentation.\n"), raw("apps/web/CLAUDE.md", "- Use 2-space indentation.\n", "nested")]);
    expect(nested.findings[0]!.applicability).toBe("Applies when working in apps/web.");
    const apart = buildReport([raw("apps/web/CLAUDE.md", "- Use tabs for indentation.\n", "nested"), raw("apps/api/CLAUDE.md", "- Use 2-space indentation.\n", "nested")]);
    expect(apart.findings[0]!.confidence).toBe("low");
  });
  it("setting conflicts: model override, permission allow vs deny, overlap stays low", () => {
    const r = buildReport([
      raw(".claude/settings.json", '{\n "model": "opus",\n "permissions": { "deny": ["Bash(git push:*)", "Bash(git:*)"] }\n}'),
      raw(".claude/settings.local.json", '{\n "model": "sonnet",\n "permissions": { "allow": ["Bash(git push *)"] }\n}'),
    ], { dataset: "sample" });
    const model = r.findings.find((f) => f.rule === "setting:model")!;
    expect(model.intentionalOverride).toBe(true);
    expect(model.precedence).toContain(".claude/settings.local.json likely wins");
    expect(model.precedence).toContain("Likely intentional override");
    expect(model.evidence.map((e) => [e.path, e.line, e.excerpt])).toEqual([[".claude/settings.json", 2, '"model": "opus"'], [".claude/settings.local.json", 2, '"model": "sonnet"']]);
    const perm = r.findings.find((f) => f.rule === "setting:permissions")!;
    expect(perm.confidence).toBe("high");
    expect(perm.precedence).toContain("deny");
    expect(r.findings.find((f) => f.rule === "setting:permissions-overlap")!.confidence).toBe("low");
  });
  it("unknown model names are shown as [custom] and withheld", () => {
    const r = buildReport([raw(".claude/settings.json", '{ "model": "acme-private-ft" }'), raw(".claude/settings.local.json", '{ "model": "opus" }')], { dataset: "sample" });
    const f = r.findings.find((x) => x.rule === "setting:model")!;
    expect(JSON.stringify(f)).not.toContain("acme-private-ft");
  });
  it("is deterministic and orders by kind, confidence, then position", () => {
    const files: RawSource[] = [raw("CLAUDE.md", "- Use tabs for indentation.\n- Always run tests.\n"), raw("CLAUDE.local.md", "- Use 2-space indentation.\n- Always run tests.\n")];
    const a = JSON.stringify(buildReport(files, { dataset: "sample" }).findings);
    expect(JSON.stringify(buildReport([...files].reverse(), { dataset: "sample" }).findings)).toBe(a);
  });
  it("--findings off style: no findings, counts say unchecked", () => {
    const r = buildReport([raw("CLAUDE.md", "- Use tabs.\n- Use tabs.\n")], { findings: false });
    expect(r.findings).toEqual([]);
    expect(r.findingCounts.checked).toBe(false);
  });
  it("detectFindings runs on a plain report", () => {
    const r = report(["CLAUDE.md", "- Always use semicolons.\n"], ["CLAUDE.local.md", "- Never use semicolons.\n"]);
    expect(detectFindings(r, { dataset: "sample" }).map((f) => f.kind)).toEqual(["conflict"]);
  });
});

describe("snippetSafety", () => {
  const deny = compileDenylist(["zebracorp", "Quokka Labs"]);
  it("is ok for plain rule text", () => {
    expect(snippetSafety("Don't add comments to code; write self-explanatory names instead.", deny)).toBe("ok");
    expect(snippetSafety("Always run `npm test` before committing.", deny)).toBe("ok");
  });
  it.each(["[redacted]", "[secret]", "[email]", "[host]", "[path]", "open ~/notes"])("unsure for redaction token %s", (t) => {
    expect(snippetSafety(`Use ${t} here`, undefined, { dataset: "sample" })).toBe("unsure");
  });
  it("unsure for a word within one edit of a denylisted term (5+ chars)", () => {
    expect(snippetSafety("Ask the zebracrop team", deny)).toBe("unsure"); // substitution/transposition-ish near miss
    expect(snippetSafety("Ask the zebracor team", deny)).toBe("unsure"); // deletion
    expect(snippetSafety("Ask the zebraccorp team", deny)).toBe("unsure"); // insertion
    expect(snippetSafety("Ask the quokkalabz team", deny)).toBe("unsure"); // multi-word term, joined
  });
  it("unsure for a 4+ character prefix or suffix overlap with a term", () => {
    expect(snippetSafety("see the zebra notes", deny)).toBe("unsure"); // prefix fragment
    expect(snippetSafety("see the bracorp notes", deny)).toBe("unsure"); // suffix fragment
    expect(snippetSafety("see the quok group", deny)).toBe("unsure");
  });
  it("is ok when nothing is close to a term", () => {
    expect(snippetSafety("Keep a lion and a zoo out of the code", deny)).toBe("ok");
  });
  it("real datasets: handles, URL hosts, CamelCase and kebab names are unsure; sample datasets skip this", () => {
    for (const t of ["Ping @orbit-dev about it", "See https://wiki.example.test/page", "Use the BillingEngine class", "Deploy with acme-billing-service", "Ask Marlowe about it", "Run docs.internalwiki.dev checks"]) {
      expect(snippetSafety(t, undefined, { dataset: "real" }), t).toBe("unsure");
      expect(snippetSafety(t, undefined, { dataset: "sample" }), t).toBe("ok");
    }
    expect(snippetSafety("Use TypeScript and GitHub with self-explanatory names.", undefined, { dataset: "real" })).toBe("ok");
    expect(snippetSafety("Prefer named exports over default exports.", undefined, { dataset: "real" })).toBe("ok");
  });
});

describe("evidence privacy", () => {
  it("withholds the excerpt (path:line only) when a denylisted name survived nearby, in the JSON findings", () => {
    const deny = compileDenylist(["zebracorp"]);
    const r = buildReport([
      raw("CLAUDE.md", "- Never add comments for the zebracorp team.\n- Always add a comment above helpers.\n"),
      raw("CLAUDE.local.md", "- Add comments above every function written by zebracrop staff.\n"),
    ], { denylist: deny, dataset: "sample" });
    const f = r.findings.find((x) => x.kind === "conflict")!;
    expect(f.evidence.some((e) => e.excerpt === null)).toBe(true);
    expect(JSON.stringify(r)).not.toContain("zebracorp");
    for (const e of f.evidence) expect(e.line).toBeGreaterThan(0);
  });
});

describe("imports", () => {
  it("extracts @path imports outside code and requires a path-like token", () => {
    const text = ["See @AGENTS.md for rules.", j("Mail me", "@", "host.test or @handle"), "`@in-code.md`", "```", "@fenced.md", "```", "- Read @docs/style.md.", "Use ~/x and @~/.claude/rules/a.md too.", ""].join("\n");
    expect(extractImports(text)).toEqual([{ line: 1, spec: "AGENTS.md" }, { line: 7, spec: "docs/style.md" }, { line: 8, spec: "~/.claude/rules/a.md" }]);
  });
  it("resolves relative to the importing file and refuses unsafe targets", () => {
    expect(resolveImport("CLAUDE.md", "docs/a.md", false)).toEqual({ path: "docs/a.md" });
    expect(resolveImport("apps/web/CLAUDE.md", "../../AGENTS.md", false)).toEqual({ path: "AGENTS.md" });
    expect(resolveImport("CLAUDE.md", "../x.md", false)).toEqual({ skip: "outside" });
    expect(resolveImport("CLAUDE.md", "/etc/x.md", false)).toEqual({ skip: "absolute" });
    expect(resolveImport("CLAUDE.md", ".env", false)).toEqual({ skip: "env" });
    expect(resolveImport("CLAUDE.md", "config/.env.md", false)).toEqual({ skip: "env" });
    expect(resolveImport("CLAUDE.md", "node_modules/x/README.md", false)).toEqual({ skip: "outside" });
    expect(resolveImport("CLAUDE.md", "image.png", false)).toEqual({ skip: "type" });
    expect(resolveImport("CLAUDE.md", "~/.claude/rules/a.md", false)).toEqual({ skip: "user" });
    expect(resolveImport("CLAUDE.md", "~/.claude/rules/a.md", true)).toEqual({ path: "~/.claude/rules/a.md" });
    expect(resolveImport("CLAUDE.md", "~/.ssh/notes.md", true)).toEqual({ skip: "user" });
    expect(resolveImport("~/.claude/CLAUDE.md", "rules/a.md", true)).toEqual({ path: "~/.claude/rules/a.md" });
    expect(resolveImport("~/.claude/CLAUDE.md", "../x.md", true)).toEqual({ skip: "outside" });
  });
  it("counts an imported always-loaded file once, marks the Claude occurrence and makes it always-loaded", () => {
    const r = buildReport([
      raw("CLAUDE.md", "See @AGENTS.md and @docs/a.md.\n"), raw("AGENTS.md", "- Use tabs.\n"),
      { ...raw("docs/a.md", "- Be brief.\n"), viaImport: true }, raw("apps/web/CLAUDE.md", "See @../../docs/b.md\n", "nested"),
      { ...raw("docs/b.md", "- Nested only.\n"), viaImport: true }, { ...raw("docs/orphan.md", "- Nobody imports me.\n"), viaImport: true },
    ]);
    const by = (p: string) => r.sources.find((s) => s.logicalPath === p)!;
    expect(by("AGENTS.md")).toMatchObject({ agent: "codex", activation: "always", claudeActivation: "always" });
    expect(by("AGENTS.md").importedBy).toEqual([{ by: by("CLAUDE.md").id, line: 1 }]);
    expect(by("docs/a.md")).toMatchObject({ kind: "claude-import", agent: "claude-code", activation: "always" });
    expect(by("docs/b.md")).toMatchObject({ activation: "nested" });
    expect(r.sources.some((s) => s.logicalPath === "docs/orphan.md")).toBe(false);
    expect(r.totals.sources).toBe(5);
    expect(r.totals.estTokens).toBe(r.sources.reduce((n, s) => n + s.estTokens, 0)); // physical files once
    expect(r.byAgent.codex?.sources).toBe(1);
    const claude = buildPosterModel(r, { agent: "claude-code" });
    expect(claude.totals).toMatchObject({ sources: 3, listed: 2, inventorySources: 5 });
    expect(claude.rows.find((x) => x.meta.startsWith("AGENTS.md"))!.meta).toBe("AGENTS.md · @import");
    expect(buildPosterModel(r, { agent: "codex" }).totals.inventorySources).toBe(1);
  });
  it("follows imports to depth 8, warns when level 9 is cut, and survives cycles", () => {
    const chain: RawSource[] = [raw("CLAUDE.md", "@d1.md\n")];
    for (let i = 1; i <= 10; i++) chain.push({ ...raw(`d${i}.md`, i === 10 ? "@CLAUDE.md\n" : `@d${i + 1}.md\n`), viaImport: true });
    const r = buildReport(chain);
    expect(MAX_IMPORT_DEPTH).toBe(8);
    expect(r.sources.map((s) => s.logicalPath).sort()).toEqual(["CLAUDE.md", "d1.md", "d2.md", "d3.md", "d4.md", "d5.md", "d6.md", "d7.md", "d8.md"]);
    expect(r.warnings.filter((w) => w.includes("@import depth limit (8)"))).toEqual(["d8.md: @import depth limit (8) reached; deeper imports were not followed"]);
    // A chain that ends exactly at depth 8 is complete: no warning.
    const exact = buildReport([raw("CLAUDE.md", "@d1.md\n"), ...Array.from({ length: 8 }, (_, k): RawSource => ({ ...raw(`d${k + 1}.md`, k === 7 ? "end\n" : `@d${k + 2}.md\n`), viaImport: true }))]);
    expect(exact.sources).toHaveLength(9);
    expect(exact.warnings.filter((w) => w.includes("depth limit"))).toEqual([]);
    const cyc = buildReport([raw("CLAUDE.md", ["@a.md", ""].join("\n")), { ...raw("a.md", ["@CLAUDE.md", "@a.md", ""].join("\n")), viaImport: true }]);
    expect(cyc.sources).toHaveLength(2);
  });
});

describe("poster findings", () => {
  const demo = () => buildReport([
    raw("CLAUDE.md", "See @AGENTS.md for shared agent rules.\n- Always run `npm test` before committing.\n- Don't add comments to code; write self-explanatory names instead.\n"),
    raw("AGENTS.md", "- Always run `npm test` before committing.\n- Document as you go: add a comment above every non-obvious function.\n"),
    raw(".claude/settings.json", '{ "model": "opus" }'), raw(".claude/settings.local.json", '{ "model": "sonnet" }'),
    raw(".cursor/rules/a.mdc", "---\nalwaysApply: true\n---\n- Always run `npm test` before committing.\n"),
  ], { dataset: "sample" });

  it("highlights the comments conflict, counts the profile's medium+high findings, and shows the duplicate strip", () => {
    const r = demo();
    const pf = posterFindings(r, "claude-code")!;
    expect(pf.conflicts).toHaveLength(1); // the comments conflict; the model override is listed, not counted
    expect(pf.conflicts[0]).toMatchObject({ confidence: "medium", note: "Both load at repo root. No clear precedence; which one wins is unknown." });
    expect(pf.conflicts[0]!.a.ref).toEqual({ path: "CLAUDE.md", line: 3 });
    expect(pf.conflicts[0]!.b.ref).toEqual({ path: "AGENTS.md", line: 2 });
    expect(pf.overrides).toHaveLength(1);
    expect(pf.overrides![0]).toMatchObject({ setting: true, override: true });
    expect(r.findingCounts.headline).toEqual({ conflicts: 1, duplicates: 1, overrides: 1 });
    expect(pf.duplicates).toHaveLength(1);
    expect(pf.duplicates[0]!.refs.map((x) => x.path)).toEqual(["CLAUDE.md", "AGENTS.md"]); // the Cursor copy is another profile
    const model = buildPosterModel(r, { findings: pf });
    const all = texts(renderPosterSvg(model));
    expect(all).toContain("1 possible conflict · 1 duplicate");
    expect(all.some((t) => t.includes("likely intentional override"))).toBe(false); // the header no longer carries the override line
    expect(all.some((t) => t.includes("1 of"))).toBe(false); // "1 of N shown" counts counted findings only
    expect(all).toContain("DUPLICATE ×2");
    expect(all).toContain("POSSIBLE CONFLICT");
    expect(model.rows.filter((x) => x.flags.includes("conflict")).map((x) => x.meta.split(" ")[0])).toEqual(expect.arrayContaining(["CLAUDE.md", "AGENTS.md"]));
    expect(model.rows.some((x) => x.flags.includes("duplicate"))).toBe(true);
    // Another profile gets its own, smaller set.
    expect(posterFindings(r, "cursor")!.conflicts).toHaveLength(0);
  });
  it("a lone model override is listed with its own count, not as a conflict, and never picked for the card", () => {
    const r = buildReport([raw(".claude/settings.json", '{ "model": "opus" }'), raw(".claude/settings.local.json", '{ "model": "sonnet" }'), raw("CLAUDE.md", "- Be kind.\n")], { dataset: "sample" });
    expect(r.findings.filter((f) => f.kind === "setting-conflict")).toHaveLength(1);
    expect(r.findingCounts.headline).toEqual({ conflicts: 0, duplicates: 0, overrides: 1 });
    const pf = posterFindings(r, "claude-code")!;
    expect(pf.conflicts).toEqual([]);
    expect(pf.overrides).toHaveLength(1);
    const all = texts(renderPosterSvg(buildPosterModel(r, { findings: pf })));
    expect(all).toContain("No conflicts or duplicates found");
    expect(all.some((t) => t.startsWith("+1 likely intentional override"))).toBe(false);
    expect(all).toContain("1 likely intentional override listed, not counted."); // the card still says how many were left out
    expect(all.some((t) => /POSSIBLE CONFLICT|SETTING CONFLICT/.test(t))).toBe(false);
    expect(all).toContain("No possible conflicts or duplicates found by the heuristics.");
    expect(renderSourcesTableHtml(r)).toContain("1 likely intentional override");
  });
  it("allow vs deny of the same pattern still counts and is the card's setting conflict", () => {
    const r = buildReport([
      raw(".claude/settings.json", '{ "permissions": { "allow": ["Bash(git push:*)"] } }'),
      raw(".claude/settings.local.json", '{ "permissions": { "deny": ["Bash(git push *)"] } }'), raw("CLAUDE.md", "- Be kind.\n"),
    ], { dataset: "sample" });
    expect(r.findingCounts.headline).toMatchObject({ conflicts: 1, overrides: 0 });
    const svg = renderPosterSvg(buildPosterModel(r, { findings: posterFindings(r, "claude-code") }));
    expect(texts(svg)).toContain("SETTING CONFLICT");
    expect(texts(svg)).toContain("1 possible conflict");
  });
  it("says so, muted and without badges, when nothing is found", () => {
    const r = buildReport([raw("CLAUDE.md", "- Be kind.\n")], { dataset: "sample" });
    const svg = renderPosterSvg(buildPosterModel(r, { findings: posterFindings(r, "claude-code") }));
    expect(texts(svg)).toContain("No possible conflicts or duplicates found by the heuristics.");
    expect(texts(svg)).toContain("No conflicts or duplicates found");
    expect(texts(svg).some((t) => /POSSIBLE CONFLICT|DUPLICATE ×|^\d+ DUPLICATE/.test(t))).toBe(false);
  });
  it("with detection off the card says not checked", () => {
    const r = buildReport([raw("CLAUDE.md", "- Be kind.\n")], { findings: false });
    expect(posterFindings(r, "claude-code")).toBeUndefined();
    expect(texts(renderPosterSvg(buildPosterModel(r, { findings: posterFindings(r, "claude-code") })))).toContain("Not checked in this run (findings off).");
  });
  it("draws only path:line and 'text withheld (privacy)' when the snippet is unsure", () => {
    const r = buildReport([
      raw("CLAUDE.md", "- Don't add comments to the Acme Gateway code.\n"), raw("CLAUDE.local.md", "- Add a comment above every function.\n"),
    ], { dataset: "real" });
    const f = r.findings.find((x) => x.kind === "conflict")!;
    expect(f.evidence.map((e) => e.excerpt === null)).toEqual([true, false]);
    const svg = renderPosterSvg(buildPosterModel(r, { findings: posterFindings(r, "claude-code") }));
    const all = texts(svg);
    expect(all).toContain("text withheld (privacy)");
    expect(all.join("\n")).not.toContain("Gateway");
    expect(all).toContain("CLAUDE.md:1");
    expect(svg).toContain(`fill="#5A606B">text withheld (privacy)`); // muted
  });
  it("the sources HTML lists findings with evidence, or withheld notes", () => {
    const html = renderSourcesTableHtml(demo());
    expect(html).toContain("Findings");
    expect(html).toContain("CLAUDE.md:3");
    expect(html).toContain("Document as you go");
    const real = buildReport([raw("CLAUDE.md", "- Don't add comments to the Acme Gateway code.\n"), raw("CLAUDE.local.md", "- Add a comment above every function.\n")], { dataset: "real" });
    const h = renderSourcesTableHtml(real);
    expect(h).toContain("text withheld (privacy)");
    expect(h).not.toContain("Gateway");
  });
  it("keeps secret-shaped canaries out of evidence", () => {
    const canary = j("gh", "p_abcdefghijklmnopqrstuv12");
    const r = buildReport([raw("CLAUDE.md", `- Never add comments. ${j("tok", "en")}: ${canary}\n`), raw("CLAUDE.local.md", "- Add a comment above every function.\n")], { dataset: "sample" });
    expect(JSON.stringify(r)).not.toContain(canary);
  });
});
