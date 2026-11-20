import { describe, expect, it } from "vitest";
import {
  analyze, buildPosterModel, buildReport, compileDenylist, extractRules, normalizeToolPattern, posterFindings, renderPosterSvg, type Finding, type RawSource,
} from "../src/index";

const raw = (logicalPath: string, text: string, scope: RawSource["scope"] = "project"): RawSource => ({ logicalPath, text, scope });
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
const texts = (svg: string) => [...svg.matchAll(/<text [^>]*>(.*?)<\/text>/g)].map((m) => decode(m[1]!.replace(/<[^>]+>/g, "")));
/** Two files that load together at the repo root (both Claude memory files). */
const pair = (a: string, b: string, options: Parameters<typeof buildReport>[1] = { dataset: "sample" }) => buildReport([raw("CLAUDE.md", `- ${a}\n`), raw("CLAUDE.local.md", `- ${b}\n`)], options);
const counted = (f: Finding) => f.confidence !== "low" && !f.crossAgent && f.agents.length > 0 && !f.intentionalOverride;

describe("medium/high false positives never reach the headline", () => {
  const cases: [string, string, string][] = [
    ["a question", "Should we never use default exports?", "Use default exports."],
    ["a question about a tool", "Should we never use Jest?", "Use Jest."],
    ["unless asked", "Never use default exports unless asked.", "Use default exports."],
    ["unless approved", "Never use default exports unless approved.", "Use default exports."],
    ["do not only", "Do not only run tests.", "Run tests."],
    ["do not just", "Don't just run tests.", "Run tests."],
    ["remove vs add", "Do not remove comments.", "Add comments."],
    ["delete vs add", "Never delete comments.", "Add comments to public functions."],
    ["double negation (choice path)", "Never avoid named exports.", "Use named exports."],
    ["double negation with skip", "Do not skip default exports.", "Use default exports."],
    ["quoted bad example", "The old guide said \"never use default exports\".", "Use default exports."],
    ["curly-quoted bad example", "Bad: “never add comments” is a myth.", "Add comments."],
    ["past tense", "We used to never use default exports.", "Use default exports."],
    ["previously", "Previously we never committed.", "Commit often."],
    ["line length", "Limit line length to 80 characters.", "Limit line length to 100 characters."],
  ];
  it.each(cases)("%s: nothing counted, nothing on the poster badge", (_label, a, b) => {
    const r = pair(a, b);
    expect(r.findings.filter(counted).filter((f) => f.kind === "conflict")).toEqual([]);
    expect(r.findingCounts.headline.conflicts).toBe(0);
    const svg = renderPosterSvg(buildPosterModel(r, { findings: posterFindings(r, "claude-code") }));
    expect(texts(svg).some((t) => /POSSIBLE CONFLICT/.test(t))).toBe(false);
  });
  it("the same pairs without the false-positive wording still conflict (the guards are not blanket)", () => {
    expect(pair("Never use default exports.", "Use default exports.").findingCounts.headline.conflicts).toBe(1);
    expect(pair("Don't add comments.", "Add comments.").findingCounts.headline.conflicts).toBe(1);
    expect(pair("Never use named exports.", "Use named exports.").findingCounts.headline.conflicts).toBe(1);
    expect(pair("Do not run tests.", "Run tests.").findingCounts.headline.conflicts).toBe(1);
  });
  it("marks non-directives on the analysis and gives them no clauses", () => {
    const a = (text: string) => analyze(extractRules("s", `- ${text}\n`)[0]!);
    expect(a("Should we never use X?").nondirective).toBe("question");
    expect(a("We used to never use X.").nondirective).toBe("history");
    expect(a("The guide says: \"never use X anywhere\".").nondirective).toBe("example");
    expect(a("Never use X.").nondirective).toBeUndefined();
    expect(a("Use \"named exports\" everywhere.").nondirective).toBeUndefined();
    expect(a("Do not only run tests.").clauses[0]!.polarity).toBe("weak");
    expect(a("Never use X unless asked.").conditional).toBe(true);
  });
  it("swapped objects: a conflict (run vs skip tests) and NOT also a near-duplicate at 1.0", () => {
    const r = pair("Run tests; skip lint.", "Run lint; skip tests.");
    const kinds = r.findings.map((f) => `${f.kind}:${f.confidence}`);
    expect(kinds).toEqual(["conflict:high"]);
    expect(r.findings.some((f) => f.kind === "near-duplicate")).toBe(false);
    // Genuine near-duplicates of mixed polarity (same objects, same polarities) still count.
    const same = pair("Run the tests thoroughly; skip the lint entirely before every release.", "Run your tests thoroughly; skip any lint entirely before every release.");
    expect(same.findings.map((f) => f.kind)).toEqual(["near-duplicate"]);
  });
  it("the poster only promotes findings that pass the headline predicate (low, cross-agent and overrides never)", () => {
    const r = buildReport([
      raw("CLAUDE.md", "- Don't add comments to code.\n- Never use default exports unless asked.\n"),
      raw("AGENTS.md", "- Add a comment above every function.\n- Use default exports.\n"),
      raw(".claude/settings.json", '{ "model": "opus" }'), raw(".claude/settings.local.json", '{ "model": "sonnet" }'),
    ], { dataset: "sample" });
    // AGENTS.md is imported by nobody here: every CLAUDE.md-vs-AGENTS.md pair is cross-agent, low, uncounted.
    expect(r.findings.filter((f) => f.kind === "conflict").every((f) => f.crossAgent && f.confidence === "low")).toBe(true);
    const pf = posterFindings(r, "claude-code")!;
    expect(pf.conflicts).toEqual([]);
    expect(pf.overrides).toHaveLength(1);
    expect(r.findingCounts.headline).toEqual({ conflicts: 0, duplicates: 0, overrides: 1 });
  });
  it("a code span is compared literally", () => {
    const r = pair("Never run `make deploy`.", "Run `make deploy`.");
    expect(r.findings.map((f) => [f.kind, f.confidence, f.rule])).toEqual([["conflict", "high", "polarity"]]);
    expect(pair("Never run `make deploy`.", "Run `make test`.").findings).toEqual([]);
  });
  it("a numeric line-length conflict is low, an indentation one stays medium", () => {
    expect(pair("Limit line length to 80 characters.", "Limit line length to 100 characters.").findings.map((f) => [f.rule, f.confidence])).toEqual([["numeric:line-length", "low"]]);
    expect(pair("Use 2-space indentation.", "Use 4-space indentation.").findings.map((f) => [f.rule, f.confidence])).toEqual([["numeric:indent", "medium"]]);
  });
});

describe("raw text is compared in memory, only what is shown is redacted", () => {
  it("two different denylisted names do not collapse into one [redacted] and invent a conflict", () => {
    const denylist = compileDenylist(["amberteam", "blueteam"]);
    const r = pair("Run tests for amberteam.", "Skip tests for blueteam.", { denylist, dataset: "sample" });
    expect(r.findings).toEqual([]);
    // Without a denylist there is no finding either, so the result no longer depends on it.
    expect(pair("Run tests for amberteam.", "Skip tests for blueteam.").findings).toEqual([]);
  });
  it("a real conflict about the same denylisted name is still found, with its text withheld", () => {
    const denylist = compileDenylist(["amberteam"]);
    const r = pair("Run tests for amberteam.", "Skip tests for amberteam.", { denylist, dataset: "sample" });
    expect(r.findings.map((f) => f.kind)).toEqual(["conflict"]);
    expect(JSON.stringify(r)).not.toMatch(/amberteam/i);
    expect(r.findings[0]!.evidence.map((e) => e.excerpt)).toEqual([null, null]);
  });
  it("secrets in rule text are matched raw but never exported", () => {
    const canary = ["gh", "p_abcdefghijklmnopqrstuv12"].join("");
    const r = pair(`Never add comments, see ${canary}.`, "Add comments.");
    expect(JSON.stringify(r)).not.toContain(canary);
  });
});

describe("permission arguments are not case-folded", () => {
  const settings = (deny: string[], allow: string[]) => buildReport([
    raw("CLAUDE.md", "- x\n"), raw(".claude/settings.json", JSON.stringify({ permissions: { deny } })), raw(".claude/settings.local.json", JSON.stringify({ permissions: { allow } })),
  ], { dataset: "sample" });
  it("Read(./public/**) deny vs Read(./Public/**) allow is no conflict", () => {
    expect(settings(["Read(./public/**)"], ["Read(./Public/**)"]).findings).toEqual([]);
    expect(settings(["Bash(Git push:*)"], ["Bash(git push *)"]).findings).toEqual([]);
  });
  it("the same argument still conflicts, and the tool name is compared case-insensitively", () => {
    expect(settings(["Read(./public/**)"], ["Read(./public/**)"]).findingCounts.headline.conflicts).toBe(1);
    expect(settings(["read(./public/**)"], ["Read(./public/**)"]).findingCounts.headline.conflicts).toBe(1);
    expect(settings(["Bash(git push:*)"], ["Bash(git push *)"]).findingCounts.headline.conflicts).toBe(1);
    expect(normalizeToolPattern("Read(./Public/**)")).toBe("read(./Public/**)");
  });
});

describe("the poster picks a showable finding over a fully withheld one", () => {
  it("highlights the showable medium conflict ahead of a fully withheld high one", () => {
    const r = buildReport([
      raw("CLAUDE.md", "- Always run the Acme Gateway tests.\n- Don't add comments to code.\n"),
      raw("CLAUDE.local.md", "- Never run the Acme Gateway tests.\n- Add a comment above every function.\n"),
    ], { dataset: "real" });
    const conflicts = r.findings.filter((f) => f.kind === "conflict");
    expect(conflicts.map((f) => f.confidence)).toEqual(["high", "medium"]); // detection order: the withheld one is first
    expect(conflicts[0]!.evidence.every((e) => e.excerpt === null)).toBe(true);
    const pf = posterFindings(r, "claude-code")!;
    expect(pf.conflicts).toHaveLength(2);
    expect(pf.conflicts[0]!.a.withheld).toBeUndefined();
    expect(pf.conflicts[0]!.confidence).toBe("medium");
    const svg = texts(renderPosterSvg(buildPosterModel(r, { findings: pf })));
    expect(svg).toContain("1 of 2 shown · medium confidence · heuristic");
    expect(svg).not.toContain("text withheld (privacy)");
  });
});

describe("cross-agent findings fill agents[] and stay low and uncounted", () => {
  const files = [raw("CLAUDE.md", "- Don't add comments to code.\n- Always run `npm test` before committing.\n"), raw("AGENTS.md", "- Add a comment above every function.\n- Always run `npm test` before committing.\n")];
  it("lists the agents involved, flags crossAgent, and never counts them", () => {
    const r = buildReport(files, { dataset: "sample" });
    const conflict = r.findings.find((f) => f.kind === "conflict")!;
    expect(conflict).toMatchObject({ confidence: "low", crossAgent: true, agents: ["claude-code", "codex"] });
    const dup = r.findings.find((f) => f.kind === "duplicate")!;
    expect(dup).toMatchObject({ crossAgent: true, agents: ["claude-code", "codex"] });
    expect(r.findingCounts.headline).toEqual({ conflicts: 0, duplicates: 0, overrides: 0 });
    const pf = posterFindings(r, "claude-code")!;
    expect([pf.conflicts.length, pf.duplicates.length]).toEqual([0, 0]);
    expect(posterFindings(r, "codex")!.conflicts).toHaveLength(0);
  });
  it("an explicit @import between the files promotes them to the same agent profile", () => {
    const r = buildReport([{ ...files[0]!, text: `See @AGENTS.md for shared rules.\n${files[0]!.text}` }, files[1]!], { dataset: "sample" });
    const conflict = r.findings.find((f) => f.kind === "conflict")!;
    expect(conflict.crossAgent).toBeUndefined();
    expect(conflict.agents).toEqual(["claude-code"]);
    expect(conflict.confidence).toBe("medium");
    expect(r.findingCounts.headline.conflicts).toBe(1);
    expect(r.findingCounts.headline.duplicates).toBe(1);
  });
});

describe("uncounted rows sort after counted rows", () => {
  it("a large config row and a large nested file never sit among the counted rows", () => {
    const settings = JSON.stringify({ model: "opus", permissions: { allow: Array.from({ length: 30 }, (_, i) => `Bash(cmd${i}:*)`) }, env: { A: "1", B: "2" } });
    const r = buildReport([
      raw("CLAUDE.md", "- Be kind.\n"), raw("CLAUDE.local.md", "- Be brief and kind to everyone.\n"),
      raw("apps/web/CLAUDE.md", `- ${"Keep the web app tidy. ".repeat(30)}\n`, "nested"), raw(".claude/settings.json", settings),
    ], { dataset: "sample" });
    const tokens = (p: string) => r.sources.find((s) => s.logicalPath === p)!.estTokens;
    expect(tokens(".claude/settings.json")).toBeGreaterThan(tokens("CLAUDE.md"));
    expect(tokens("apps/web/CLAUDE.md")).toBeGreaterThan(tokens("CLAUDE.local.md"));
    const model = buildPosterModel(r);
    // The two big uncounted files collapse into one muted row after the counted rows, carrying their summed tokens.
    expect(model.rows.map((x) => x.counted)).toEqual([true, true, false]);
    const [a, b, c] = model.rows;
    expect(a!.tokens).toBeGreaterThanOrEqual(b!.tokens);
    expect(c).toMatchObject({ kind: "not-counted", tokens: tokens(".claude/settings.json") + tokens("apps/web/CLAUDE.md"), meta: "1 nested · 1 config (settings, MCP) · not in the total" });
  });
});
