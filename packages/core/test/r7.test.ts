import { describe, expect, it } from "vitest";
import {
  buildPosterModel, buildReport, compileDenylist, headFrontmatterCloses, frontmatterCloses, parseFrontmatter, posterFindings, redact, renderPosterSvg, renderSourcesTableHtml,
  snippetSafety, type RawSource,
} from "../src/index";
import { FAMILIES, hasNonRelativePath, looseSecretKey } from "../src/patterns.mjs";

// Secret-shaped and home-path inputs are assembled at runtime so the repository privacy scan never sees a literal key/value line, token or home path.
const j = (...parts: string[]) => parts.join("");
const BS = String.fromCharCode(92);
const rep = (ch: string, n: number) => ch.repeat(n);

/** Everything a run exports for one CLAUDE.md that also holds a comments conflict (so the poster has a card to draw). */
function exported(text: string, inline = false) {
  const files: RawSource[] = [
    { logicalPath: "CLAUDE.md", text: inline ? `- Never add comments, ${text}\n` : `- Never add comments.\n\n${text}\n`, scope: "project" },
    { logicalPath: "CLAUDE.local.md", text: "- Add comments.\n", scope: "project" },
  ];
  const report = buildReport(files, { dataset: "real" });
  const svg = renderPosterSvg(buildPosterModel(report, { dataset: "UNREVIEWED REAL SET", findings: posterFindings(report, "claude-code") }));
  const html = renderSourcesTableHtml(report);
  return { report, svg, html, represented: report.sources.find((s) => s.logicalPath === "CLAUDE.md")!.represented, all: JSON.stringify(report) + html + svg };
}

describe("a path with a space in a folder name is masked whole", () => {
  const CASES: [string, string][] = [
    ["Notes in ~/Fake Alice/private.md here", "Notes in [path] here"],
    [`@"~/Fake Alice/private.md"`, `@"[path]"`],
    ["'~/Fake Alice/p.md'", "'[path]'"],
    ["~/Google Drive/Tax 2026/x.md", "[path]"],
    ["Notes in ~/Fake Alice", "Notes in [path]"],
    ["`~/Fake Alice/Mobile Documents/x.md` too", "`[path]` too"],
    [j("see ~/Fake", BS, " Alice/x.md here"), "see [path] here"],
    [j("In /Us", "ers/Alice Smith/notes.md and C:", BS, "Users", BS, "Alice Smith", BS, "x.md ok"), "In [path] ok"], // both paths and the word between them are one run
    [j("D:", BS, "Data", BS, "My Docs", BS, "x.md end"), "[path] end"],
    ["in /opt/Fake Alice/Reports 2026/x.md now", "in [path] now"],
    ["a \"~/never closed and more text", 'a "[path]'], // no closing quote: fail closed to the end of the line
  ];
  it.each(CASES)("%s", (input, expected) => {
    const out = redact(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/Alice|Google|Tax|Mobile|Reports|My Docs|Smith/);
    expect(redact(out)).toBe(out); // idempotent
    expect(hasNonRelativePath(input)).toBe(true);
  });
  it("keeps prose, allowlisted logical paths and slash commands", () => {
    for (const text of ["~ 394 tokens", "`~/.claude/settings.json` ok", "~/.claude/skills/helper/SKILL.md · user", "run `/review` now", "See the README for details. Next Steps"]) expect(redact(text)).toBe(text);
    expect(redact("see ~/.claude/rules for details")).toBe("see ~/.claude/[path] for details");
    expect(redact("See ~/x/y. Next Foo/bar")).toBe("See [path]. Next Foo/bar"); // the full stop ends the path
  });
  it.each([
    "Notes in ~/Fake Alice/private.md here", `@"~/Fake Alice/private.md"`, "'~/Fake Alice/p.md'", "~/Google Drive/Tax 2026/x.md",
  ])("%s reaches no JSON, sources HTML, poster SVG, snippet or alt text", (path) => {
    const out = exported(`see ${path} for details.`, true);
    expect(out.all).not.toMatch(/Alice|Google Drive|Tax 2026/);
    expect(out.represented).toContain("[path]");
    expect(snippetSafety(path)).toBe("unsure");
    const f = out.report.findings.find((x) => x.kind === "conflict")!;
    expect(f.evidence.some((e) => e.excerpt === null || !/Alice|Google|Tax/.test(e.excerpt))).toBe(true);
  });
  it("does not go quadratic on a long line of path starts", () => {
    const text = rep("~/a b ", 30_000);
    const t0 = Date.now();
    redact(text);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("name/value pairs across blank lines, collections and split flow pairs", () => {
  const VALUE = j("never add comments violet", "zz maple", "zz");
  const NAME = (rest: string) => j("- na", "me: API", "_KEY", rest); // `- name: <secret name>`, then the rest
  const VAL = (v: string) => j("  val", "ue: ", v);
  it("the blank-line pair paired with 'Add comments.' leaves the value in no export", () => {
    const text = `${NAME("")}\n\n${VAL(VALUE)}`;
    expect(redact(text)).toBe(`${NAME("")}\n\n${VAL("[secret]")}`);
    const out = exported(text);
    for (const w of ["violetzz", "maplezz", "never add comments violet"]) expect(out.all).not.toContain(w);
    expect(out.report.sources.find((s) => s.logicalPath === "CLAUDE.md")!.represented).toContain(VAL("[secret]").trim());
  });
  it("comment lines and several blank lines between the two fields, either order", () => {
    // a comment line inside the item is part of the block and is masked too.
    expect(redact(`${NAME("")}\n  # note\n\n\n${VAL("violetzz")}`)).toBe(`${NAME("")}\n  [secret]\n\n\n${VAL("[secret]")}`);
    expect(redact(`- ${VAL("violetzz").trim()}\n\n# c\n  ${NAME("").slice(2)}`)).toBe(`- ${VAL("[secret]").trim()}\n\n[secret]\n  ${NAME("").slice(2)}`);
  });
  it("a blank line does not join two list items", () => {
    expect(redact(`- name: PLAIN\n\n${NAME("")}\n${VAL("x")}`)).toBe(`- name: PLAIN\n\n${NAME("")}\n${VAL("[secret]")}`);
    const plain = j("- na", "me: LOG_LEVEL\n\n  val", "ue: debug");
    expect(redact(plain)).toBe(plain);
  });
  it.each([
    [j('{"pass', 'word":\n{\n  "a": "violetzz", "b": "maplezz"\n}\n}\nafter')],
    [j('{"pass', 'word":\n\n  {"a": "violetzz",\n "b": "maplezz"}}\nafter')], // (r8: closed; an unclosed outer brace now runs to the end of the text)
    [j("tok", "en: [violetzz,\n maplezz]\nafter")],
    [j("sec", "ret:\n[\n  violetzz,\n  maplezz\n]\nafter")],
    [j("sec", 'ret: {"a": "multi\nline violetzz", "b": "maplezz"}\nafter')],
  ])("mask until the matching close: %s", (text) => {
    const out = redact(text);
    expect(out).not.toMatch(/violetzz|maplezz|multi|line /);
    expect(out.endsWith("after")).toBe(true);
    expect(redact(out)).toBe(out);
    expect(exported(text).all).not.toMatch(/violetzz|maplezz/);
  });
  it.each([
    j("- {name: API", "_KEY,\n   value: violet", "zz}\n- keep this"),
    j("- {value: violet", "zz,\n   name: API", "_KEY}\n- keep this"),
    j("env: [\n  {name: API", "_KEY,\n   # c\n   value: 'violet", "zz'}\n]\nkeep this"),
    j('{"name": "API_', 'KEY",\n "value":\n "violet', 'zz"}\nkeep this'),
  ])("a flow pair split across lines is detected: %s", (text) => {
    const out = redact(text);
    expect(out).not.toContain("violetzz");
    expect(out.endsWith("keep this")).toBe(true);
    expect(exported(text).all).not.toContain("violetzz");
  });
  it("a flow pair whose name is not secret keeps its value", () => {
    expect(redact("- {name: LOG_LEVEL,\n   value: debug}")).toBe("- {name: LOG_LEVEL,\n   value: debug}");
  });
  it("an apostrophe in a word does not swallow the rest of the document", () => {
    expect(redact(j("tok", "en: [don't know,\n x]\nafter this"))).toContain("after this");
  });
});

describe("the poster's own user-config paths are allowlisted, truncated forms included", () => {
  it.each([
    "~/.claude/skills/release-notes/SKILL.md · user", "~/.claude/settings.json", "~/.codex/AGENTS.md", "~/.claude/skills/…/SKILL.md · user",
    "~/.claude/…/settings.json", "~/…/SKILL.md", "…/skills/release-notes/SKILL.md", "…/settings.json", "…settings.json", "~/.agents/skills/…/SKILL.md",
  ])("%s survives the redactor unchanged", (text) => {
    expect(redact(text)).toBe(text);
    for (const f of FAMILIES) expect(f.apply(text), f.id).toBe(text);
  });
  it("other paths in the same shapes are still masked", () => {
    expect(redact(j("/ho", "me/ali", "ce/.claude/settings.json"))).toBe("[path]");
    expect(redact("…/skills/release-notes/notes.md")).toContain("[path]");
    expect(redact("~/.claude/rules/alice.md")).toBe("~/.claude/[path]");
  });
});

describe("a user skill's directory is shown only when it is the skill's own name", () => {
  const skill = (dir: string, name: string, root = "~/.claude"): RawSource => ({
    logicalPath: `${root}/skills/${dir}/SKILL.md`, text: `---\nname: ${name}\ndescription: Does a thing.\n---\n# Body\n`, scope: "user",
  });
  const pathOf = (raw: RawSource, opts = {}) => buildReport([raw], { dataset: "real", ...opts }).sources[0]!.logicalPath;
  it("masks a directory that differs from the frontmatter name", () => {
    expect(pathOf(skill("fakealice", "helper"))).toBe("~/.claude/skills/[name]/SKILL.md");
    expect(pathOf(skill("fakealice", "helper", "~/.codex"))).toBe("~/.codex/skills/[name]/SKILL.md");
    expect(pathOf(skill("fakealice", "helper", "~/.agents"))).toBe("~/.agents/skills/[name]/SKILL.md");
  });
  it("keeps it when it equals the name", () => {
    expect(pathOf(skill("release-notes", "release-notes"))).toBe("~/.claude/skills/release-notes/SKILL.md");
  });
  it("masks it when the name itself fails the denylist or redaction", () => {
    const deny = compileDenylist(["acme"]);
    const report = buildReport([skill("acme-notes", "acme-notes")], { dataset: "real", denylist: deny });
    expect(JSON.stringify(report)).not.toMatch(/acme/i);
    expect(report.sources[0]!.logicalPath).toBe("~/.claude/skills/[name]/SKILL.md");
    expect(pathOf(skill("ghp_" + rep("a", 24), "ghp_" + rep("a", 24)))).toBe("~/.claude/skills/[name]/SKILL.md");
  });
  it("never shows a directory in a warning, and leaves project skills (repo-relative) alone", () => {
    const broken: RawSource = { logicalPath: "~/.claude/skills/fakealice/SKILL.md", text: "no frontmatter", scope: "user" };
    const report = buildReport([broken], { dataset: "real", warnings: ["~/.claude/skills/fakealice/SKILL.md: over 262144 bytes, skipped"] });
    expect(JSON.stringify(report.warnings)).not.toContain("fakealice");
    expect(report.warnings.some((w) => w.includes("[name]/SKILL.md"))).toBe(true);
    const project: RawSource = { logicalPath: ".claude/skills/db-migrations/SKILL.md", text: "---\nname: other\ndescription: x\n---\n", scope: "project" };
    expect(buildReport([project], { dataset: "real" }).sources[0]!.logicalPath).toBe(".claude/skills/db-migrations/SKILL.md");
  });
  it("reaches the JSON, sources HTML and poster without the directory", () => {
    const report = buildReport([skill("fakealice", "helper"), { logicalPath: "CLAUDE.md", text: "- Never add comments.\n", scope: "project" }, { logicalPath: "CLAUDE.local.md", text: "- Add comments.\n", scope: "project" }], { dataset: "real" });
    const svg = renderPosterSvg(buildPosterModel(report, { dataset: "UNREVIEWED REAL SET", findings: posterFindings(report, "claude-code") }));
    expect(JSON.stringify(report) + renderSourcesTableHtml(report) + svg).not.toContain("fakealice");
  });
});

describe("inventory suppression hides no directive", () => {
  const conflicts = (a: string, b: string) => buildReport([{ logicalPath: "CLAUDE.md", text: a, scope: "project" }, { logicalPath: "CLAUDE.local.md", text: b, scope: "project" }], { dataset: "sample" })
    .findings.filter((f) => f.kind === "conflict");
  it.each([
    ["- `pkg`: Execute tests with vitest.\n", "- Use jest for tests.\n"],
    ["- `pkg`: Switch to vitest.\n", "- Use jest for tests.\n"],
    ["- Most packages: Adopt vitest.\n", "- Use jest for tests.\n"],
    ["- `pkg`: Indent with 2 spaces.\n", "- `pkg`: Indent with 4 spaces.\n"],
  ])("%s vs %s is a conflict", (a, b) => {
    expect(conflicts(a, b).length).toBeGreaterThan(0);
  });
  it("descriptive inventories still give none", () => {
    expect(conflicts("- Most packages: **vitest** for unit tests.\n", "- `date-helpers`: **jest** for unit tests.\n")).toEqual([]);
    expect(conflicts("- `@acme/utils`: **jest**\n", "- `@acme/ui`: **vitest**\n")).toEqual([]);
  });
  it("area-labelled frameworks ('Frontend: vitest' vs 'Backend: jest') are low confidence", () => {
    const f = conflicts("- Frontend: vitest\n", "- Backend: jest\n");
    expect(f.every((x) => x.confidence === "low")).toBe(true);
    expect(conflicts("- Tests: **vitest**.\n", "- Tests: **jest**.\n").some((x) => x.confidence === "medium")).toBe(true);
  });
});

describe("ordinary configuration words are not source secret literals", () => {
  const literal = FAMILIES.find((f) => f.id === "secret-literals")!;
  const flagged = (text: string) => literal.apply(text) !== text;
  it.each([
    j("const c = { au", 'th: "oauth2" };'), j("hm", 'ac: "sha256"'), j("coo", 'kie: "lax"'), j("coo", 'kie: "strict"'), j("au", 'th: "basic"'), j("au", 'th: "bearer"'), j("j", 'wt: "hs256"'),
    j("au", 'th: "rs256"'), j("au", 'th: "none"'), j("sess", 'ion: "cookie"'), j("au", 'th: "required"'), j("au", 'th: "optional"'), j("au", 'th: "header"'), j("au", 'th: "query"'), j("hm", "ac: sha512"),
  ])("%s passes", (text) => expect(flagged(text), text).toBe(false));
  it.each([
    j("au", 'th: "', "k3Jf9sLq2XzWp8Vn4RtYb6Hd", '"'), j("coo", 'kie: "', "aB3dE5gH7jK9mN1pQ3sT5vX7", '"'), j("hm", "ac: ", "q8W3e7R2t5Y9u1I4o6P0a3S5"), j("au", 'th: "abc123token"'), j("j", 'wt: "abcdefgh"'),
  ])("%s is still flagged", (text) => expect(flagged(text), text).toBe(true));
});

describe("the OCR loose matcher checks every component", () => {
  it.each([
    j("GITHUB_T0KEN", "_VALUE: x"), j("SESS", "lON_ID: x"), j("AP1_K3Y", "_NAME: abc"), j("my_pa55", "word_hint: x"), j("Authoriz", "ation_mode: x"), j("COOK", "IE_JAR: a"),
  ])("%s is a key", (text) => expect(looseSecretKey(text), text).toBe(true));
  it.each([
    j("coo", 'kie: "[secret]"'), j("coo", "kie: '[secret]'"), j("GITHUB_TO", "KEN: [secret]"), j("tok", "en: [redacted]"), j("est_", "tokens: 394"), "Author: Someone", "keyboard: us", "monkey: x", "hotkey: y", "passed: 645",
    "Largest source CLAUDE.md, about 120 tokens.",
  ])("%s is not", (text) => expect(looseSecretKey(text), text).toBe(false));
  it("is linear on a long run", () => {
    const t0 = Date.now();
    looseSecretKey(rep("a_", 200_000) + ": x");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("frontmatter and head fences", () => {
  it("a flow map with an escaped quote and a trailing comment is conditional, not always", () => {
    const fm = parseFrontmatter('---\n{"description":"say \\" # literally","paths":["src/**"]} # scope\n---\n');
    expect(fm.get("paths")?.items).toEqual(["src/**"]);
    expect(fm.get("description")?.value).toContain("literally");
  });
  it("a head ending exactly in the fence does not close; one with its newline inside does", () => {
    expect(frontmatterCloses("---\nname: x\n---")).toBe(true);
    expect(headFrontmatterCloses("---\nname: x\n---")).toBe(false);
    expect(headFrontmatterCloses("---\nname: x\n---\n")).toBe(true);
    expect(headFrontmatterCloses("---\nname: x\n...\r\n")).toBe(true);
    expect(headFrontmatterCloses("---\nname: x\n---NOT")).toBe(false);
  });
});
