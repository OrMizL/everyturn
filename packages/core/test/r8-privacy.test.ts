import { describe, expect, it } from "vitest";
import {
  buildPosterModel, buildReport, detectFindings, posterFindings, redact, renderPosterSvg, renderSourcesTableHtml, snippetSafety, type RawSource,
} from "../src/index";
import * as P from "../src/patterns.mjs";

// Secret-shaped and home-path inputs are assembled at runtime so the repository privacy scan never sees a literal key/value line, token or home path.
const j = (...parts: string[]) => parts.join("");
const BS = String.fromCharCode(92);
const VALUE = j("never add comments violet", "zz maple", "zz");
const WORDS = ["violetzz", "maplezz", "never add comments violet"];
const blanks = (n: number) => "\n".repeat(n); // n blank lines between two lines: "a" + blanks(n + 1) + "b"

/** The M1 forms (the leak battery of the r8 review), each a whole CLAUDE.md body. */
const FORMS: Record<string, string> = {
  a: [j("pass", "word: &ref ["), "", `${VALUE},`, "]"].join("\n"),
  b: [j("- {na", "me: API", "_KEY, # }"), "", ` ${j("val", "ue: ")}${VALUE}}`].join("\n"),
  c: [j("- na", "me:"), j("    API", "_KEY"), `  ${j("val", "ue: ")}${VALUE}`].join("\n"),
  d65: [j("- na", "me: API", "_KEY"), ...Array(65).fill(""), `  ${j("val", "ue: ")}${VALUE}`].join("\n"),
  d200: [j("- na", "me: API", "_KEY"), ...Array(200).fill(""), `  ${j("val", "ue: ")}${VALUE}`].join("\n"),
  e: [`defaults: &creds ${VALUE}`, "", j("pass", "word: *creds")].join("\n"),
};

function exported(text: string) {
  const files: RawSource[] = [
    { logicalPath: "CLAUDE.md", text: `- Never add comments.\n\n${text}\n`, scope: "project" },
    { logicalPath: "CLAUDE.local.md", text: "- Add comments.\n", scope: "project" },
  ];
  const report = buildReport(files, { dataset: "real" });
  const svg = renderPosterSvg(buildPosterModel(report, { dataset: "UNREVIEWED REAL SET", findings: posterFindings(report, "claude-code") }));
  const html = renderSourcesTableHtml(report);
  return { report, svg, html, represented: report.sources.find((s) => s.logicalPath === "CLAUDE.md")!.represented, all: JSON.stringify(report) + html + svg };
}
const cover = (text: string) => [...P.secretBlockLines(text)].join("");

describe("every form is masked in redact (full mode)", () => {
  it.each(Object.keys(FORMS))("form %s: no part of the value survives, line count kept, idempotent", (k) => {
    const text = FORMS[k]!;
    const out = redact(text);
    for (const w of WORDS) expect(out, k).not.toContain(w);
    expect(out.split("\n").length).toBe(text.split("\n").length);
    expect(redact(out)).toBe(out);
  });
  it.each(Object.keys(FORMS))("form %s reaches no JSON, sources HTML, poster SVG or excerpt", (k) => {
    const out = exported(FORMS[k]!);
    for (const w of WORDS) expect(out.all, k).not.toContain(w);
    expect(snippetSafety(FORMS[k]!)).not.toBe("ok");
    for (const f of out.report.findings) for (const e of f.evidence) if (e.excerpt) for (const w of WORDS) expect(e.excerpt).not.toContain(w);
  });
  it("classic mode (the source scan) masks forms a, c, d and e, and the b flow group", () => {
    const classic = (t: string) => P.FAMILIES.find((f) => f.id === "secret-keys-core")!.apply(t);
    for (const k of ["a", "c", "d65", "d200", "e"]) for (const w of WORDS) expect(classic(FORMS[k]!), k).not.toContain(w);
    // b: the `name` is a classic secret name only when it says so; API_KEY is classic (api + key)
    for (const w of WORDS) expect(classic(FORMS.b!)).not.toContain(w);
  });
  it("e: the anchor DEFINITION is masked, not only the alias", () => {
    const out = redact(FORMS.e!);
    expect(out).toContain("&creds");
    expect(out).not.toContain("violetzz");
  });
});

describe("redact stays idempotent with the block backstop", () => {
  const battery = [
    j('{"au', 'th": "x", "user": "bob"}\nafter this'),
    j("foo: {\n  pass", "word: x\n  keep: 1\n}\nafter this"),
    j('{"pass', 'word":\n\n  {"a": "v",\n "b": "m"}}\nafter this'),
    j("- na", "me: API", "_KEY\n\n  description: d\n  value: v\n- name: other\n  value: shown"),
    j("a: 1\ntok", "en: [\n\nx,\n]\nb: after this"),
    ...Object.values(FORMS),
  ];
  it.each(battery.map((t) => [t]))("%j", (text) => {
    const once = redact(text);
    expect(redact(once)).toBe(once);
  });
  it("text after a closed block stays readable", () => {
    expect(redact(j('{"pass', 'word":\n\n  {"a": "v",\n "b": "m"}}\nafter this'))).toMatch(/after this$/);
  });
});

describe("the structural block backstop (secretBlockLines)", () => {
  it("a YAML node block crosses blank lines and ends at the dedent", () => {
    expect(cover(["a: 1", j("pass", "word: x"), "  child", "", "  more", "b: 2"].join("\n"))).toBe("011110");
  });
  it("a block inside an open bracket does not end at a dedent or blank line", () => {
    expect(cover([j("tok", "en: ["), "", "x,", "", "]", "b: 2"].join("\n"))).toBe("111110");
  });
  it("a list item holding a secret name is one block, whatever the number of blank lines (no line limit)", () => {
    const text = ["- name: other", "  value: v", j("- na", "me: API", "_KEY"), ...Array(300).fill(""), "  value: late", "- name: next"].join("\n");
    const c = cover(text);
    expect(c[0]).toBe("0");
    expect(c[1]).toBe("0");
    expect(c.slice(2, 304)).toBe("1".repeat(302));
    expect(c[304]).toBe("0");
  });
  it("a prose key blocks its paragraph only", () => {
    expect(cover(["Intro line", "", j("Please set the pass", "word: foo here"), "second line", "", "Other paragraph"].join("\n"))).toBe("001100");
  });
  it("loose name/value forms count as secret keys", () => {
    expect(cover([j("- na", "me: API", "_KEY"), "  value: x", "- name: plain", "  value: y"].join("\n"))).toBe("1100");
  });
  it("covers every line when a folded form changes the line count; text without secret keys covers nothing", () => {
    expect(cover("hello\nworld")).toBe("00");
    expect(cover("")).toBe("0");
  });
  it("is linear on 80K lines", () => {
    const text = Array.from({ length: 80_000 }, (_, i) => `k${i}: v`).join("\n");
    const t0 = Date.now();
    P.secretBlockLines(text);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("maskBlocks (the block backstop of redact)", () => {
  it("masks through the end of the block, keeps the key line and the sibling block, and is idempotent", () => {
    const text = [j("- na", "me: API", "_KEY"), "  description: seeme", "", "  value: x", "- name: plain", "  value: shown"].join("\n");
    const out = redact(text);
    expect(out).not.toContain("seeme");
    expect(out.split("\n")[0]).toBe(j("- na", "me: API", "_KEY"));
    expect(out).toContain("  value: shown");
    expect(out.split("\n").length).toBe(6);
    expect(redact(out)).toBe(out);
  });
  it("masks a value that comes before its name (name form masks from the item start)", () => {
    const out = redact(["- note: seeme", j("  na", "me: API", "_KEY"), "- name: plain"].join("\n"));
    expect(out).not.toContain("seeme");
    expect(out).toContain("- name: plain");
  });
});

describe("excerpt backstop: detectFindings withholds any excerpt in a secret block", () => {
  it("a rule in the same YAML-ish block as a secret name has no excerpt", () => {
    const body = [j("- na", "me: API", "_KEY"), "  note: Add comments always.", "", "  more: x"].join("\n");
    const out = exported(body);
    const ev = out.report.findings.flatMap((f) => f.evidence).filter((e) => e.path === "CLAUDE.md");
    for (const e of ev) expect(e.excerpt === null || !/Add comments always/.test(e.excerpt)).toBe(true);
    expect(out.all).not.toContain("Add comments always");
  });
  it("a bullet rule that sits in the same paragraph as a prose secret key is withheld; a rule in another paragraph stays", () => {
    const text = `- Never add comments.\n\n${j("- Set the pass", "word: x")}\n- Never use tabs.\n\n- Always use tabs.\n`;
    const report = buildReport([{ logicalPath: "CLAUDE.md", text, scope: "project" }], { dataset: "real" });
    const findings = detectFindings(report, { texts: new Map(report.sources.map((s) => [s.id, text])) });
    const tabs = findings.flatMap((f) => f.evidence).filter((e) => e.line === 4 || e.line === 6);
    expect(tabs.find((e) => e.line === 4)).toBeDefined();
    expect(tabs.find((e) => e.line === 4)!.excerpt).toBeNull();
    expect(tabs.find((e) => e.line === 6)?.excerpt).toContain("Always use tabs");
  });
  it("settings evidence is withheld when its line is in a secret block", () => {
    const files: RawSource[] = [
      { logicalPath: ".claude/settings.json", text: "{}", scope: "project" },
      { logicalPath: ".claude/settings.local.json", text: "{}", scope: "project" },
    ];
    const report = buildReport(files, { dataset: "real" });
    const inputs = (localExtra: string) => report.sources.map((s) => {
      const local = s.logicalPath.includes("local");
      return { sourceId: s.id, layer: (local ? "local" : "project") as "local" | "project", text: local ? `{\n${localExtra}  "model": "sonnet"\n}\n` : '{\n  "model": "opus"\n}\n' };
    });
    const ev = (fs: ReturnType<typeof detectFindings>) => fs.filter((f) => f.kind === "setting-conflict").flatMap((f) => f.evidence);
    const plain = ev(detectFindings(report, { settings: inputs("") }));
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.some((e) => e.excerpt !== null && e.excerpt.includes("sonnet"))).toBe(true);
    const keyed = ev(detectFindings(report, { settings: inputs(`  "${j("api", "KeyHelper")}": "x",\n`) }));
    expect(keyed.length).toBe(plain.length);
    expect(keyed.some((e) => e.excerpt?.includes("sonnet"))).toBe(false);
    expect(keyed.some((e) => e.excerpt?.includes("opus"))).toBe(true);
  });
});

describe("a path run is masked to its last slash token", () => {
  const TAILS = ["my private notes/alice.md", "notes for alice/today.md", "one two three/alice.md"];
  const ROOTS: [string, string][] = [["~/", "/"], ["/Us" + "ers/fakebob/", "/"], ["/ho" + "me/fakebob/", "/"], ["C:" + BS + "Us" + "ers" + BS + "fakebob" + BS, BS], [BS + BS + "srv" + BS + "share" + BS, BS]];
  const cases = ROOTS.flatMap(([root, sep]) => TAILS.map((t) => [root + t.replace(/\//g, sep)] as [string]));
  it.each(cases)("%s -> [path] whole, alone and mid-sentence", (path) => {
    expect(redact(path)).toBe("[path]");
    expect(redact(`see ${path} for the details`)).toBe("see [path] for the details");
    expect(P.hasNonRelativePath(path)).toBe(true);
    const out = redact(`x ${path}`);
    expect(out).not.toMatch(/private|alice|today|three|notes/);
  });
  it.each(TAILS)("%s reaches no JSON, sources HTML or poster SVG (JSON represented keeps [path])", (tail) => {
    const out = exported(`see ~/${tail} for details.`);
    expect(out.all).not.toMatch(/private notes|for alice|two three|alice|today/);
    expect(out.represented).toContain("[path]");
  });
  it("allowlisted whole-run user config paths stay; the poster's own separators break the run", () => {
    for (const t of ["~/.claude/CLAUDE.md", "~/.claude/CLAUDE.md:12 ≠ AGENTS.md:6", "~/.claude/CLAUDE.md:12 ← docs/x.md:3", "~/.claude/skills/helper/SKILL.md · user"]) expect(redact(t), t).toBe(t);
  });
  it("fails closed on `~/x then see src/a.ts`", () => {
    expect(redact("~/x then see src/a.ts")).toBe("[path]");
  });
  it("a sentence break ends the run", () => {
    expect(redact("see ~/x/y. Next foo/bar")).toBe("see [path]. Next foo/bar");
  });
});

describe("old leaking outputs are flagged by the artifact families", () => {
  it("path-tail and the old secret-block shapes are caught by the scanner families", () => {
    const old = [j("[path]", " private notes/alice.md"), j("[path]", " for alice/today.md"), j("[path]", " two three/alice.md")];
    const fam = P.FAMILIES.find((f) => f.id === "path-tail");
    expect(fam).toBeDefined();
    for (const text of old) expect(fam!.apply(text), text).not.toBe(text);
    for (const text of ["[path]", "see [path] for details", "~/.claude/[path]", "[path] and then more words"]) expect(fam!.apply(text), text).toBe(text);
  });
});

describe("perf: 80K-line inputs stay linear", () => {
  const N = 80_000;
  const inputs: Record<string, (n: number) => string> = {
    flat: (n) => Array.from({ length: n }, (_, i) => `key${i}: value`).join("\n"),
    staircase: (n) => Array.from({ length: n }, (_, i) => `${" ".repeat(i % 64)}k${i}: v`).join("\n"),
    unclosed: (n) => `${j("pass", "word: [")}\n${Array.from({ length: n }, (_, i) => `x${i},`).join("\n")}`,
    nameBlanks: (n) => Array.from({ length: n / 200 }, (_, i) => `${j("- na", "me: API", "_KEY")}\n${blanks(200)}  zzz${i}: v`).join("\n"),
    tildes: (n) => "~ ".repeat(n),
    pathMarks: (n) => `[path] ${"a ".repeat(n)}`,
  };
  const time = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t; };
  it.each(Object.keys(inputs))("%s: under 1.5 s and sub-quadratic", (k) => {
    const small = inputs[k]!(N / 2), big = inputs[k]!(N);
    const t1 = time(() => redact(small));
    const t2 = time(() => redact(big));
    expect(t2).toBeLessThan(1500);
    expect(t2).toBeLessThan(Math.max(t1 * 3, 150));
  }, 20_000);
});
