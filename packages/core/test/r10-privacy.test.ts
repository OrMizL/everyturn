import { describe, expect, it } from "vitest";
import * as P from "../src/patterns.mjs";

// env-rooted home paths, triple-quoted values, folded/anchored YAML names and anchors defined elsewhere, whitespace runs
// inside paths, and the linear-time contract. Secret-shaped and home-path inputs are assembled at runtime (j) so the repository scan never sees
// a literal key/value line or home path; only the fake values `violetzz maplezz` and `alicefake` appear.
const j = (...parts: string[]) => parts.join("");
const BS = String.fromCharCode(92);
const VALUE = j("never add comments violet", "zz maple", "zz");
const WORDS = ["violetzz", "maplezz", "never add comments violet"];
const redact = (text: string) => P.redactGeneric(text);
const cover = (text: string) => [...P.secretBlockLines(text)].join("");
const lines = (text: string) => text.split("\n").length;
const classic = (text: string) => P.FAMILIES.find((f) => f.id === "secret-keys-core")!.apply(text);
const HOME = j("$HO", "ME");
const PW = j("pass", "word");

describe("env-rooted home paths are masked", () => {
  const cases: [string, string][] = [
    [j(HOME, "/fake alice/notes.md"), "[path]"],
    [j("${HO", "ME}/fake alice/x.md"), "[path]"],
    [j('"', HOME, '/.config/fakeapp/alice.json"'), '"[path]"'],
    [j("$env:USERPROFILE", BS, "alicefake", BS, "notes.md"), "[path]"],
    [j("${env:USERPROFILE}", BS, "alicefake", BS, "notes.md"), "[path]"],
    [j("%USERPROFILE%", BS, "alicefake", BS, "notes.md"), "[path]"],
    [j("%userprofile%", BS, "alicefake", BS, "notes.md"), "[path]"],
    [j("%HOMEPATH%", BS, "alicefake", BS, "notes.md"), "[path]"],
    [j("%HomePath%", BS, "alicefake", BS, "notes.md"), "[path]"],
    [j("%APPDATA%", BS, "alicefake", BS, "x.json"), "[path]"],
    [j("%LOCALAPPDATA%", BS, "alicefake", BS, "x.json"), "[path]"],
    [j("%localappdata%", BS, "alicefake", BS, "x.json"), "[path]"],
    [j(HOME, "/alicefake/notes.md"), "[path]"],
    [j(HOME, "/my private notes/alice.md"), "[path]"],
    [j("%USERPROFILE%", BS, "my private notes", BS, "alice.md"), "[path]"],
  ];
  it.each(cases)("%s", (input, expected) => {
    const out = redact(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/alice|notes\.md|fakeapp|private/);
    expect(P.hasNonRelativePath(input)).toBe(true);
    expect(redact(out)).toBe(out);
  });
  it("in a sentence the words after the run are kept", () => {
    expect(redact(j("- Never add comments; see ", HOME, "/fake alice/notes.md for details."))).toBe("- Never add comments; see [path] for details.");
    expect(redact(j("- Never add comments; see %USERPROFILE%", BS, "alicefake", BS, "notes.md for details."))).toBe("- Never add comments; see [path] for details.");
  });
  it("a bare $HOME with no slash stays; a root glued to a word is masked too (fails closed)", () => {
    expect(redact(j("cd ", HOME, " && ls"))).toBe(j("cd ", HOME, " && ls"));
    expect(redact(j("echo ", HOME))).toBe(j("echo ", HOME));
    expect(redact(j("x", HOME, "/a/b"))).not.toContain("a/b");
  });
  it("$HOME and $USERPROFILE are upper-case names: a template's lower-case ${home} is a variable, not the home directory", () => {
    const tpl = j("`${ho", "me}/a/b.md` and ${ho", "me}/AGENTS.md");
    expect(redact(tpl)).toBe(tpl);
    expect(redact(j("$user", "profile/a/b.md"))).toBe(j("$user", "profile/a/b.md"));
  });
});

describe("triple-quoted values", () => {
  const qs = ['"""', "'''"];
  const forms = qs.flatMap((q) => [
    [`${q} with blank line`, [j(PW, " = ", q), "", VALUE, q].join("\n")],
    [`${q} without blank line`, [j(PW, " = ", q), VALUE, q].join("\n")],
    [`${q} api_key (TOML)`, [j("api_", "key = ", q), "", VALUE, q].join("\n")],
    [`${q} value on the opener line`, [j(PW, " = ", q, VALUE), "", `more ${VALUE}`, q].join("\n")],
  ]) as [string, string][];
  it.each(forms)("%s: no part of the value survives, the line count is kept, idempotent", (_name, text) => {
    const out = redact(`a: 1\n${text}\nafter this`);
    for (const w of WORDS) expect(out).not.toContain(w);
    expect(lines(out)).toBe(lines(text) + 2);
    expect(out).toMatch(/after this$/);
    expect(redact(out)).toBe(out);
    for (const w of WORDS) expect(classic(`a: 1\n${text}\nafter this`)).not.toContain(w);
  });
  it.each(forms)("%s: secretBlockLines covers the lines through the closer and no more", (_name, text) => {
    const n = lines(text);
    expect(cover(`a: 1\n${text}\nafter this`)).toBe(`0${"1".repeat(n)}0`);
  });
  it("the text after the closer is still scanned: a secret key that follows the string is masked on its own", () => {
    const out = redact([j(PW, " = ", '"""'), VALUE, '"""', j("api_", "key = ", "violetzz2"), "after this"].join("\n"));
    expect(out).not.toContain("violetzz");
    expect(out).toMatch(/after this$/);
  });
  it("a single-line triple-quoted value is masked whole", () => {
    expect(redact(j(PW, " = ", '"""', VALUE, '"""'))).not.toContain("violetzz");
  });
});

describe("YAML names and values hidden behind anchors, tags and block scalars", () => {
  const NAME = j("- na", "me:");
  const API = j("API", "_KEY");
  const VAL = j("val", "ue: ");
  const blank = (n: number) => Array(n).fill("");
  const forms: Record<string, string> = {
    "folded name >-": [j(NAME, " >-"), `    ${API}`, `  ${VAL}${VALUE}`].join("\n"),
    "folded name >": [j(NAME, " >"), `    ${API}`, `  ${VAL}${VALUE}`].join("\n"),
    "literal name |": [j(NAME, " |"), `    ${API}`, `  ${VAL}${VALUE}`].join("\n"),
    "anchored name": [j(NAME, " &n ", API), `  ${VAL}${VALUE}`].join("\n"),
    "tagged name": [j(NAME, " !!str ", API), `  ${VAL}${VALUE}`].join("\n"),
    "anchored, tagged folded name": [j(NAME, " &n !!str >-"), `    ${API}`, `  ${VAL}${VALUE}`].join("\n"),
    "name is an alias": [j("x: &n ", API), j(NAME, " *n"), `  ${VAL}${VALUE}`].join("\n"),
    "name is an alias, anchor defined after": [j(NAME, " *n"), `  ${VAL}${VALUE}`, j("x: &n ", API)].join("\n"),
    "value before the folded name": [j("- ", VAL, VALUE), j("  na", "me: >-"), `    ${API}`].join("\n"),
    "anchor defined before the use": [`defaults: &ref ${VALUE}`, "", j(PW, ":"), "  *ref"].join("\n"),
    "anchor defined before the use, 70 blank lines": [`defaults: &ref ${VALUE}`, ...blank(70), j(PW, ":"), "  *ref"].join("\n"),
    "anchor defined after the use": [j(PW, ":"), "  *ref", "", `defaults: &ref ${VALUE}`].join("\n"),
    "anchor defined after the use, 70 blank lines": [j(PW, ":"), "  *ref", ...blank(70), `defaults: &ref ${VALUE}`].join("\n"),
    "anchor with children": [`defaults: &ref`, `  a: ${VALUE}`, `  b: ${VALUE}`, "", j(PW, ": *ref")].join("\n"),
    "anchored quote on the next line": [j(PW, ":"), '  &ref "', "", VALUE, '"'].join("\n"),
    "tagged quote on the next line": [j(PW, ":"), '  !!str "', "", VALUE, '"'].join("\n"),
    "anchored quote on the same line": [j(PW, ': &ref "'), "", VALUE, '"'].join("\n"),
    "anchored single quote on the next line": [j(PW, ":"), "  &ref '", "", VALUE, "'"].join("\n"),
    "tagged anchored block scalar on the next line": [j(PW, ":"), "  !!str &r |", `    ${VALUE}`, `    more ${VALUE}`].join("\n"),
    "anchored flow on the next line": [j(PW, ":"), "  &r [", "", `${VALUE},`, "]"].join("\n"),
    "explicit key": [j("? ", PW), `: ${VALUE}`].join("\n"),
  };
  const keys = Object.keys(forms);
  it.each(keys)("%s: no part of the value survives, the line count is kept, idempotent", (k) => {
    const text = `a: 1\n${forms[k]}\nafter: this`;
    const out = redact(text);
    for (const w of WORDS) expect(out, k).not.toContain(w);
    expect(lines(out)).toBe(lines(text));
    expect(out).toMatch(/after: this$/);
    expect(redact(out)).toBe(out);
  });
  it.each(keys)("%s: the whole item is one secret block", (k) => {
    const text = `a: 1\n${forms[k]}\nafter: this`;
    const cov = cover(text);
    expect(cov[0]).toBe("0");
    expect(cov.endsWith("0")).toBe(true);
    // every line that holds a word of the value is covered
    text.split("\n").forEach((l, i) => { if (/violetzz|maplezz|never add comments/.test(l)) expect(cov[i], `${k}: line ${i}`).toBe("1"); });
  });
  it.each(keys)("%s: classic mode (the source scan) masks it too", (k) => {
    for (const w of WORDS) expect(classic(`a: 1\n${forms[k]}\nafter: this`), k).not.toContain(w);
  });
  it("the anchor definition is masked wherever it is, and its alias stays", () => {
    expect(redact(forms["anchor defined after the use"]!)).toContain("&ref");
    expect(redact(forms["anchor defined before the use"]!)).toMatch(/defaults: &ref \[secret\]/);
  });
  it("an anchor that no secret key uses is left alone", () => {
    const text = [`defaults: &ref ${VALUE}`, "", "other: *ref"].join("\n");
    expect(redact(text)).toBe(text);
  });
  it("a sibling node under another parent is not secret", () => {
    const out = redact([j("- na", "me: API", "_KEY"), `  ${j("val", "ue: ")}${VALUE}`, "- name: other", "  value: shown"].join("\n"));
    expect(out).toContain("value: shown");
  });
});

describe("any whitespace run is one separator inside a path", () => {
  const seps = ["  ", "   ", "\t", " \t", " ", "　", "  "];
  const roots: [string, string][] = [
    ["~/", "/"],
    [j("/ho", "me/fakealice/"), "/"],
    [j("/Us", "ers/fakealice/"), "/"],
    [j("C:", BS, "Us", "ers", BS, "fakealice", BS), BS],
    [j("file:///ho", "me/fakealice/"), "/"],
  ];
  const cases = roots.flatMap(([root, sl]) => seps.map((sp) => [root, sp, sl] as const));
  it.each(cases)("root %s, separator %j", (root, sp, sl) => {
    const input = `${root}one${sp}two three${sl}violetzz.md`;
    expect(redact(input)).toBe("[path]");
    expect(P.hasNonRelativePath(input)).toBe(true);
    expect(redact(`see ${input} for details.`)).toBe("see [path] for details.");
  });
  it("a sentence end still ends the run, with one space or two", () => {
    expect(redact("see ~/x/y.  Next see src/a.ts")).toBe("see [path].  Next see src/a.ts");
    expect(redact("see ~/x/y. Next see src/a.ts")).toBe("see [path]. Next see src/a.ts");
  });
  it("the tool's own allowlisted names are unchanged when they are the whole run", () => {
    for (const s of ["~/.claude/CLAUDE.md:12 ≠ AGENTS.md:6", "~/.claude/CLAUDE.md:12 ← docs/x.md:3", "~/.claude/CLAUDE.md"]) expect(redact(s), s).toBe(s);
  });
  it("path-tail: two spaces, tabs and the JSON tab escape are one separator in the scanner family", () => {
    const tail = P.FAMILIES.find((f) => f.id === "path-tail")!;
    for (const s of ["[path]  two three/violetzz.md", "[path]\ttwo three/violetzz.md", "[path] \t two three/violetzz.md", j("[path]", BS, "ttwo three/violetzz.md")]) {
      expect(tail.apply(`see ${s} end`), s).toBe("see [path] end");
    }
    expect(tail.apply("[path]\ntwo three/violetzz.md")).toBe("[path]\ntwo three/violetzz.md");
  });
});

describe("state machine: one table of openers", () => {
  type Row = { name: string; text: string; keep?: string };
  const rows: Row[] = [
    { name: 'dq multi-line, blank inside', text: [j(PW, ': "'), "", VALUE, "", `x "after" y`, "ok: 1"].join("\n") },
    { name: "sq multi-line, blank inside", text: [j(PW, ": '"), "", VALUE, "", "x' tail words", "ok: 1"].join("\n"), keep: "tail words" },
    { name: "dq with escaped quote", text: [j(PW, ': "a \\"'), VALUE, '" tail words', "ok: 1"].join("\n"), keep: "tail words" },
    { name: "sq with doubled quote", text: [j(PW, ": 'a ''"), VALUE, "' tail words", "ok: 1"].join("\n"), keep: "tail words" },
    { name: 'triple dq', text: [j(PW, ' = """'), "", VALUE, '"""', "ok = 1"].join("\n") },
    { name: "triple sq", text: [j(PW, " = '''"), "", VALUE, "'''", "ok = 1"].join("\n") },
    { name: "literal block |", text: [j(PW, ": |"), `  ${VALUE}`, "", `  more ${VALUE}`, "ok: 1"].join("\n") },
    { name: "folded block >-", text: [j(PW, ": >-"), `  ${VALUE}`, "", `  more ${VALUE}`, "ok: 1"].join("\n") },
    { name: "block with indicator |2-", text: [j(PW, ": |2-"), `  ${VALUE}`, "ok: 1"].join("\n") },
    { name: "block with indicator >+1", text: [j(PW, ": >+1"), `  ${VALUE}`, "ok: 1"].join("\n") },
    { name: "tag then block", text: [j(PW, ": !!str |"), `  ${VALUE}`, "ok: 1"].join("\n") },
    { name: "anchor then tag then block", text: [j(PW, ": &a !!str >"), `  ${VALUE}`, "ok: 1"].join("\n") },
    { name: "flow seq across blank lines", text: [j(PW, ": ["), "", `${VALUE},`, "", "]", "ok: 1"].join("\n") },
    { name: "flow map across blank lines", text: [j(PW, ": {"), "", `a: ${VALUE},`, "", "}", "ok: 1"].join("\n") },
    { name: "flow with a quote that carries over", text: [j(PW, ': ["'), VALUE, '", "b"]', "ok: 1"].join("\n") },
    { name: "flow with a # inside a quote", text: [j(PW, ': ["# x", '), `${VALUE}]`, "ok: 1"].join("\n") },
    { name: "next-line value", text: [j(PW, ":"), `  ${VALUE}`, "ok: 1"].join("\n") },
    { name: "next-line value after a comment and blanks", text: [j(PW, ":"), "# note", "", `  ${VALUE}`, "ok: 1"].join("\n") },
    { name: "plain continuation lines", text: [j(PW, ": start"), `  ${VALUE}`, `  more ${VALUE}`, "ok: 1"].join("\n") },
    { name: "tag on the next line", text: [j(PW, ":"), "  !!str", `  ${VALUE}`, "ok: 1"].join("\n") },
  ];
  it.each(rows.map((r) => [r.name, r] as const))("%s", (_n, row) => {
    const out = redact(row.text);
    for (const w of WORDS) expect(out).not.toContain(w);
    expect(lines(out)).toBe(lines(row.text));
    expect(out.split("\n").pop()).toMatch(/^ok( = |: )1$/);
    if (row.keep) expect(out).toContain(row.keep); // what follows the closing quote on its line stays (it is scanned on its own)
    expect(redact(out)).toBe(out);
    for (const w of WORDS) expect(classic(row.text)).not.toContain(w);
  });
  it("an unclosed opener runs to the end of the text (fails closed)", () => {
    for (const open of ['"', "'", '"""', "'''", "[", "{"]) {
      const out = redact([j(PW, ": ", open), VALUE, "later: text"].join("\n"));
      expect(out, open).not.toContain("violetzz");
      expect(out, open).not.toContain("later: text");
      expect(lines(out)).toBe(3);
    }
  });
  it("a placeholder value is left alone", () => {
    for (const t of [j(PW, ": [secret]"), j(PW, ': "[secret]"'), j(PW, ":\n  [secret]\nok: 1")]) expect(redact(t)).toBe(t);
  });
  it("a closed quoted value keeps its quotes and trailing comma", () => {
    expect(redact(j('"', PW, '": "violetzz",'))).toBe(j('"', PW, '": "[secret]",'));
  });
});

// ---- performance ------------------------------------------------------------------------------------
const KIB256 = 256 * 1024;
const fill = (unit: string, size = KIB256) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
function yamlMix(size = KIB256) {
  const chunks: string[] = [];
  let len = 0;
  for (let i = 0; len < size; i++) {
    const c = [
      `d${i}: &a${i} ${VALUE}\n\n${PW}: *a${i}\n`,
      `- name: >-\n    X${i}\n  value: v\n`,
      `${PW} = """\n\nv ${i}\n"""\nafter ${i}\n`,
      `x${i}: &b${i} plain\ny${i}: *b${i}\n`,
      `${j("pass", "word")}:\n  &r${i} "\n\nvv ${i}\n"\n`,
      `k${i}: [\n`,
    ][i % 6]!;
    chunks.push(c);
    len += c.length;
  }
  return chunks.join("").slice(0, size);
}
const PERF: [string, (size: number) => string][] = [
  ["~/x then many words", (n) => `~/x ${fill("A ", n)}`],
  ["whitespace-heavy ~/a + ' \\t  '", (n) => `~/a${fill(" \t  ", n)}b/c`],
  ["whitespace-heavy (~/x + 50 spaces + Y)", (n) => fill(`~/x${" ".repeat(50)}Y `, n)],
  ["many ~/ roots", (n) => fill("~/a ", n)],
  ["many quoted ~/ roots on one line", (n) => fill("'~/a' ", n)],
  ["many $HOME roots", (n) => fill(j(HOME, "/a "), n)],
  ["many %APPDATA% roots", (n) => fill(j("%APPDATA%", BS, "a "), n)],
  ["many /home roots", (n) => fill(j("/ho", "me/a "), n)],
  ["YAML: anchors, aliases, folded names, triple quotes, unclosed [", yamlMix],
  ["many secret keys that open a bracket", (n) => fill(j(PW, ": [\n"), n)],
  ["- name: | staircase", (n) => { let s = ""; for (let i = 0; s.length < n; i++) s += `${" ".repeat(i % 40)}- name: |\n`; return s; }],
  ["many blank lines inside a triple-quoted value", (n) => `${j(PW, ' = """')}\n${"\n".repeat(n)}${VALUE}\n"""`],
  ["many anchors aliased by one key", (n) => `${j(PW, ":")}\n${fill("  *a\n", n / 2)}\n${fill("a: &a v\n", n / 2)}`],
];
describe("perf: 256 KiB adversarial inputs stay linear", () => {
  it.each(PERF.map((p) => [p[0], p[1]] as const))("%s", (name, make) => {
    const time = (size: number) => { const text = make(size); const t0 = performance.now(); P.redactGeneric(text); return performance.now() - t0; };
    time(16 * 1024); // warm up
    const full = time(KIB256);
    const half = time(KIB256 / 2);
    console.log(`[perf] ${name}: ${full.toFixed(0)} ms at 256 KiB (${half.toFixed(0)} ms at 128 KiB)`);
    expect(full, `${name}: ${full.toFixed(0)} ms`).toBeLessThan(500);
    expect(full, `${name}: doubling the size`).toBeLessThan(3 * half + 100);
  }, 120_000);
  it("the scanner's secretBlockLines and hasNonRelativePath are linear on the same inputs", () => {
    for (const [name, make] of PERF) {
      const text = make(KIB256);
      const t0 = performance.now();
      P.secretBlockLines(text);
      P.hasNonRelativePath(text);
      const ms = performance.now() - t0;
      console.log(`[perf] scan helpers ${name}: ${ms.toFixed(0)} ms`);
      expect(ms, name).toBeLessThan(1000);
    }
  }, 120_000);
});
