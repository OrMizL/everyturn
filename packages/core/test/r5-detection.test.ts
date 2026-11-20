import { describe, expect, it } from "vitest";
import { buildPosterModel, buildReport, isCounted, poster, renderPosterSvg, snippetSafety, activationOf, type PosterFindings, type RawSource } from "../src/index";

const src = (logicalPath: string, text: string, scope: RawSource["scope"] = "project"): RawSource => ({ logicalPath, text, scope });
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
const texts = (svg: string) => [...svg.matchAll(/<text [^>]*>(.*?)<\/text>/g)].map((m) => decode(m[1]!.replace(/<[^>]+>/g, "")));
/** Findings for two memory files that load together (CLAUDE.md and CLAUDE.local.md). */
const pair = (a: string, b: string) => buildReport([src("CLAUDE.md", `- ${a}\n`), src("CLAUDE.local.md", `- ${b}\n`)], { dataset: "sample" }).findings.filter((f) => f.kind === "conflict");

describe("an imported file is judged under the agent the finding applies to", () => {
  it("CLAUDE.md @AGENTS.md + 'Never run tests.' vs AGENTS.md 'Run tests.' stays high and counted when AGENTS.override.md exists", () => {
    const files = [src("CLAUDE.md", "@AGENTS.md\n- Never run tests.\n"), src("AGENTS.md", "- Run tests.\n"), src("AGENTS.override.md", "- Be brief.\n")];
    const report = buildReport(files, { dataset: "sample" });
    expect(report.sources.find((s) => s.logicalPath === "AGENTS.md")!.activation).toBe("inactive"); // Codex: shadowed
    const [f] = report.findings.filter((x) => x.kind === "conflict");
    expect(f).toBeDefined();
    expect(f!.applicability).toBe("Both load at repo root.");
    expect(f!.confidence).toBe("high");
    expect(isCounted(f!)).toBe(true);
    // Same result without the override file: counted as before.
    const plain = buildReport(files.slice(0, 2), { dataset: "sample" }).findings.find((x) => x.kind === "conflict")!;
    expect([plain.confidence, isCounted(plain)]).toEqual(["high", true]);
  });
  it("a conditional rule is still low", () => {
    const r = buildReport([src("CLAUDE.md", "- Never run tests.\n"), src(".claude/rules/a.md", "---\npaths:\n  - web/**\n---\n- Run tests.\n")], { dataset: "sample" });
    expect(r.findings.find((f) => f.kind === "conflict")!.confidence).toBe("low");
  });
});

describe("curated-pair false positives are not counted", () => {
  it.each([
    ["Avoid unnecessary comments.", "Add comments explaining complex logic."],
    ["Do not only use named exports.", "Use named exports."],
  ])("%s vs %s", (a, b) => {
    for (const f of pair(a, b)) expect(isCounted(f)).toBe(false);
    expect(pair(a, b).filter((f) => f.confidence !== "low")).toEqual([]);
  });
  it("unqualified comments and exports still conflict", () => {
    expect(pair("Never add comments.", "Add comments.").some(isCounted)).toBe(true);
    expect(pair("Never use named exports.", "Use named exports.").some(isCounted)).toBe(true);
    expect(pair("Add comments above every non-obvious function.", "Don't add comments to code.").some(isCounted)).toBe(true);
  });
});

describe("guards do not hide real directives", () => {
  it.each([
    ["No longer use default exports.", "Use default exports."],
    ["Never use default exports (previously recommended).", "Use default exports."],
    ['Follow "never add comments" exactly.', "Add comments."],
  ])("%s vs %s is a counted conflict", (a, b) => {
    expect(pair(a, b).some(isCounted)).toBe(true);
  });
  it("the earlier false-positive guards still hold", () => {
    for (const [a, b] of [
      ["We used to never add comments.", "Add comments."],
      ['Never write "never add comments" in code.', "Add comments."],
      ["Should we never add comments?", "Add comments."],
      ["We previously used default exports.", "Use default exports."],
      ["Do not remove comments.", "Add comments to public functions."],
    ] as const) expect(pair(a, b).filter(isCounted), `${a} / ${b}`).toEqual([]);
  });
});

describe("a topic's own context word is not a narrower scope", () => {
  it.each([
    ["Never use yarn.", "Use yarn for installs."],
    ["Use tabs, not spaces.", "Use spaces for indentation."],
  ])("%s vs %s is medium", (a, b) => {
    expect(pair(a, b).some((f) => f.confidence === "medium" && isCounted(f))).toBe(true);
  });
  it("a real narrower scope is still low", () => {
    expect(pair("Never add comments.", "Add comments for React components.").filter(isCounted)).toEqual([]);
  });
});

describe("flow-map frontmatter", () => {
  const rule = (fm: string) => activationOf("claude-rule", "project", ".claude/rules/a.md", `---\n${fm}\n---\n- x\n`);
  const cursor = (fm: string) => activationOf("cursor-rule", "project", ".cursor/rules/a.mdc", `---\n${fm}\n---\n- x\n`);
  it("{\"paths\": [...]} is conditional and {\"alwaysApply\": true} is always", () => {
    expect(rule('{"paths": ["web/**"]}')).toBe("conditional");
    expect(rule('{"paths":["a","b"], "description": "x"}')).toBe("conditional");
    expect(rule("{description: x}")).toBe("always");
    expect(cursor('{"alwaysApply": true}')).toBe("always");
    expect(cursor('{"alwaysApply": false}')).toBe("conditional");
    expect(cursor('{"globs": "*.ts", "alwaysApply": false}')).toBe("conditional");
  });
});

describe("flow-map frontmatter with a trailing comment", () => {
  const rule = (fm: string) => activationOf("claude-rule", "project", ".claude/rules/a.md", `---\n${fm}\n---\n- x\n`);
  const cursor = (fm: string) => activationOf("cursor-rule", "project", ".cursor/rules/a.mdc", `---\n${fm}\n---\n- x\n`);
  it("the comment does not change the activation", () => {
    expect(rule('{"paths": ["a"]} # c')).toBe("conditional");
    expect(rule('{"paths": ["a"]}   # only for a')).toBe("conditional");
    expect(rule("{paths: [a, b]} # c")).toBe("conditional");
    expect(cursor("{alwaysApply: true} # c")).toBe("always");
    expect(cursor('{"alwaysApply": true}\t# c')).toBe("always");
    expect(cursor("{alwaysApply: false} # c")).toBe("conditional");
    expect(cursor('{"globs": "*.ts", "alwaysApply": false} # c')).toBe("conditional");
  });
  it("comments inside a multi-line flow map, a '#' inside quotes or without a space before it", () => {
    expect(rule('{\n  "paths": ["a"], # the scope\n  "description": "x"\n} # end')).toBe("conditional");
    expect(cursor("{\n  # first\n  alwaysApply: true # yes\n}")).toBe("always");
    expect(rule('{"description": "use # for headings", "paths": ["a"]} # c')).toBe("conditional");
    expect(rule("{description: a#b} # c")).toBe("always");
  });
  it("block frontmatter with comments still works", () => {
    expect(rule("paths: # scope\n  - web/** # web only")).toBe("conditional");
  });
});

describe("real mode keeps digits and hyphens readable", () => {
  it("does not withhold '2-space indentation', still withholds a private-looking name", () => {
    expect(snippetSafety("Use 2-space indentation.", undefined, { dataset: "real" })).toBe("ok");
    expect(snippetSafety("Use acme-billing-core for it.", undefined, { dataset: "real" })).toBe("unsure");
  });
});

describe("poster card, strip and row labels", () => {
  const conflict = (n: number): PosterFindings["conflicts"] => Array.from({ length: n }, (_, i) => ({
    a: { text: "Never add comments.", ref: { path: "CLAUDE.md", line: i + 1 } }, b: { text: "Add comments.", ref: { path: "AGENTS.md", line: i + 1 } }, confidence: "medium" as const, note: "Both load at repo root.",
  }));
  const dup = (refs: number, groups: number): PosterFindings["duplicates"] => Array.from({ length: groups }, () => ({
    text: "Run npm test.", refs: Array.from({ length: refs }, (_, i) => ({ path: `apps/package-${i}/AGENTS.md`, line: i + 1 })),
  }));
  const model = (f: PosterFindings) => buildPosterModel(buildReport([src("CLAUDE.md", "- a\n")], { dataset: "sample" }), { findings: f });
  const all = (f: PosterFindings) => texts(renderPosterSvg(model(f)));

  it("N=1 shows no '1 of 1 shown' anywhere", () => {
    const t = all({ conflicts: conflict(1), duplicates: dup(2, 1) });
    expect(t.some((x) => /1 of 1 shown/.test(x))).toBe(false);
    expect(t.some((x) => /1 of \d+ shown/.test(x))).toBe(false);
  });
  it("N>1 says '1 of N shown' for conflicts and for duplicate groups", () => {
    const t = all({ conflicts: conflict(3), duplicates: dup(2, 4) });
    expect(t.some((x) => x.startsWith("1 of 3 shown"))).toBe(true);
    expect(t).toContain("1 of 4 shown");
  });
  it("the duplicate strip says '+N more files' (not '+N more') and keeps 16 px from the '1 of M shown' note", () => {
    const svg = renderPosterSvg(model({ conflicts: conflict(1), duplicates: dup(12, 10) }));
    const t = texts(svg);
    const more = t.find((x) => /^\+\d+ more files$/.test(x));
    expect(more).toBeDefined();
    expect(t.some((x) => /^\+\d+ more$/.test(x))).toBe(false);
    // geometry: x positions of the "+N more files" label and the right-aligned note
    const xOf = (label: string) => Number(new RegExp(`<text x="([0-9.]+)"[^>]*>${label.replace(/[+]/g, "\\+")}</text>`).exec(svg)![1]);
    const noteEnd = Number(/<text x="([0-9.]+)" y="[0-9.]+" text-anchor="end"[^>]*>1 of 10 shown<\/text>/.exec(svg)![1]);
    const noteStart = noteEnd - "1 of 10 shown".length * poster.ruleMeta * poster.monoAdvance;
    expect(xOf(more!) + more!.length * poster.ruleMeta * poster.monoAdvance + 16).toBeLessThanOrEqual(noteStart + 0.01);
  });
  it("overrides-only: the header says none found and the card says how many overrides were left out", () => {
    const f: PosterFindings = { conflicts: [], duplicates: [], overrides: [{ ...conflict(1)[0]!, setting: true, override: true }] };
    const t = all(f);
    expect(t).toContain("No conflicts or duplicates found");
    expect(t.some((x) => x.startsWith("+1 likely intentional override"))).toBe(false);
    expect(t).toContain("No possible conflicts or duplicates found by the heuristics.");
    expect(t).toContain("1 likely intentional override listed, not counted.");
  });
  it("nested CLAUDE.md files collapse into the not-counted row ('not memory' for one under .claude/skills); an @import makes one a counted row", () => {
    const files = [src("CLAUDE.md", "- a\n"), src(".claude/skills/x/CLAUDE.md", "- b\n", "nested"), src("apps/web/CLAUDE.md", "- c\n", "nested")];
    const plain = buildPosterModel(buildReport(files, { dataset: "sample" })).rows;
    expect(plain.map((x) => x.meta)).toEqual(["CLAUDE.md", "1 nested · 1 not memory · not in the total"]);
    // Imported by the root CLAUDE.md, the file is always loaded: it is counted and says "@import".
    const imported = buildPosterModel(buildReport([src("CLAUDE.md", "- a\n@apps/web/CLAUDE.md\n"), files[1]!, files[2]!], { dataset: "sample" })).rows;
    expect(imported.find((x) => x.meta.includes("apps/web/CLAUDE.md"))?.meta).toMatch(/ · @import$/);
    expect(imported.at(-1)!.meta).toBe("1 not memory · not in the total");
  });
});

