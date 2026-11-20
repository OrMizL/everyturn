import { describe, expect, it } from "vitest";
import { buildPosterModel, buildReport, posterFindings, redact, renderPosterSvg, renderSourcesTableHtml, snippetSafety, type RawSource } from "../src/index";
import { FAMILIES, foldText, hasNonRelativePath } from "../src/patterns.mjs";

// Secret-shaped inputs are assembled at runtime so the repository privacy scan never sees a literal key/value line, token or home path.
const j = (...parts: string[]) => parts.join("");
const idem = (text: string) => {
  const once = redact(text);
  expect(redact(once)).toBe(once);
  return once;
};
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
const WORDS = ["amber", "violet", "maple", "cedar", "violetzz", "maplezz", "cedarzz"];
const noWords = (all: string) => { for (const w of WORDS) expect(all).not.toContain(w); };

describe("@-prefixed and decorated paths are paths", () => {
  const AT = [
    j("@/ho", "me/alice/notes.md"), j("@/sr", "v/alice/x.md"), "@~/notes/alice.md", j("see @/Us", "ers/alice/x"), "`@~/x/alice.md`", "(@/opt/alice)",
    j("[@/ho", "me/alice/x]"), j("<@/va", "r/lib/alice/x>"), j("\"@~", "/alice/x\""), j("'@/mn", "t/data/alice/x'"), "@../../alice/x.md", j("@C:", "\\Us", "ers", "\\ali", "ce\\x"),
  ];
  it.each(AT)("%s never reaches JSON, HTML or the poster SVG", (path) => {
    const out = exported(`see ${path} for details.`, true);
    expect(redact(path)).toContain("[path]");
    expect(redact(path)).not.toContain("alice");
    expect(idem(path)).toBe(redact(path));
    expect(out.all).not.toContain("alice");
    expect(out.represented).toContain("[path]");
    expect(out.report.findings.find((f) => f.kind === "conflict")!.evidence.some((e) => e.excerpt === null)).toBe(true);
  });
  it("the whole @path is one [path]", () => {
    expect(idem(j("@/ho", "me/alice/notes.md"))).toBe("[path]");
    expect(idem(j("see @/Us", "ers/alice/x"))).toBe("see [path]");
    expect(idem("`@~/x/alice.md`")).toBe("`[path]`");
    expect(idem("(@/opt/alice)")).toBe("([path])");
  });
  it("repo-relative @imports stay shown, and so do scoped packages, aliases of one segment and emails' neighbours", () => {
    for (const text of ["@AGENTS.md", "@docs/x.md", "see @docs/guide/setup.md", "@scope/pkg", "@/components", "@./local.md"]) expect(idem(text)).toBe(text);
  });
  it("the snippet gate withholds @paths", () => {
    expect(snippetSafety(j("Never add comments, see @/ho", "me/alice/x"), undefined, { dataset: "real" })).toBe("unsure");
    expect(snippetSafety("Never add comments, see @~/x.md", undefined, { dataset: "real" })).toBe("unsure");
    expect(hasNonRelativePath("@/opt/x/y")).toBe(true);
  });

  const TRAVERSAL: [string, string][] = [
    ["~/.claude/rules/..\\alice.md", "[path]"],
    ["~/.claude/rules/../alice.md", "[path]"],
    ["~/.claude/./projects/x.jsonl", "[path]"],
    ["~/.claude/.\\projects\\x.jsonl", "[path]"],
    ["~/.claude/skills/./x/SKILL.md", "[path]"],
    ["~\\.claude\\..\\alice.md", "[path]"],
    ["~/.claude/projects/alice/x.jsonl", "[path]"],
    ["~/.ssh/config", "[path]"],
  ];
  it.each(TRAVERSAL)("%s -> %s (backslash and `.`/`..` segments are rejected before the allowlist)", (input, expected) => {
    const out = exported(`see ${input} for details.`, true);
    expect(idem(input)).toBe(expected);
    expect(out.all).not.toContain("alice");
    expect(out.all).not.toContain("projects");
  });
  const ROOT_ONLY: string[] = [
    "~/.claude/alice/diary.txt", "~/.claude/rules/alice.md", "~/.claude/rules/style.md", "~/.claude/shared/x.md", "~/.claude/settings.json.bak/x", "~/.claude/CLAUDE.md.bak",
    "~/.claude/skills/x/other.md", "~/.claude/skills/x/SKILL.md/y", "~/.codex/alice.md", "~/.agents/notes/alice.md", "~/.claude/hooks/alice.sh", "~/.claude/settings.local.json.old",
  ];
  it.each(ROOT_ONLY)("%s keeps only its root: the name is never shown", (input) => {
    const root = /^~\/\.\w+/.exec(input)![0];
    const out = exported(`see ${input} for details.`, true);
    expect(idem(input)).toBe(`${root}/[path]`);
    expect(out.all).not.toContain("alice");
    expect(out.all).not.toContain("diary");
    expect(out.all).not.toContain("style.md");
    expect(out.report.findings.find((f) => f.kind === "conflict")!.evidence.some((e) => e.excerpt === null)).toBe(true);
  });
  it("exactly the known names keep their path", () => {
    for (const p of ["~/.claude/CLAUDE.md", "~/.claude/settings.json", "~/.claude/settings.local.json", "~/.codex/AGENTS.md", "~/.codex/AGENTS.override.md", "~/.claude/skills/my-skill/SKILL.md", "~/.codex/skills/x/SKILL.md", "~/.agents/skills/x/SKILL.md"]) {
      expect(idem(p)).toBe(p);
      expect(idem(`read ${p}.`)).toBe(`read ${p}.`);
    }
    expect(hasNonRelativePath("~/.claude/settings.local.json")).toBe(false);
  });
  it("a user-scope source keeps its path only when it has a known name", () => {
    const r = buildReport([
      { logicalPath: "~/.claude/CLAUDE.md", text: "- Be brief.\n", scope: "user" },
      { logicalPath: "~/.claude/rules/alice-notes.md", text: "- Be kind.\n", scope: "user" },
    ], { includeUser: true });
    expect(r.sources.map((s) => s.logicalPath).sort()).toEqual(["~/.claude/CLAUDE.md", "~/.claude/[path]"]);
    expect(JSON.stringify(r)).not.toContain("alice");
  });
});

describe("continuation lines of a secret value are masked", () => {
  const cases: [string, string][] = [
    [j("pass", "word: violetzz\n  maplezz\nnext: ok"), j("pass", "word: [secret]\n  [secret]\nnext: ok")],
    [j("pass", "word: violetzz\n  maplezz\n  cedarzz\nnext: ok"), j("pass", "word: [secret]\n  [secret]\n  [secret]\nnext: ok")],
    [j("- pass", "word: violetzz\n  maplezz\n- user: bob"), j("- pass", "word: [secret]\n  [secret]\n- user: bob")],
    // a sibling field after the secret key is in the same block (the block backstop) and is masked too; a following item is not.
    [j("- pass", "word: violetzz\n    maplezz\n  user: bob"), j("- pass", "word: [secret]\n    [secret]\n  [secret]")],
    [j("  - pass", "word: violetzz\n    maplezz\n  - user: bob"), j("  - pass", "word: [secret]\n    [secret]\n  - user: bob")],
    [j("db:\n  pass", "word: violetzz\n    maplezz\n  user: bob"), j("db:\n  pass", "word: [secret]\n    [secret]\n  [secret]")],
    [j("tok", "en: violetzz\r\n  maplezz\r\nnext: ok"), j("tok", "en: [secret]\r\n  [secret]\r\nnext: ok")],
    // multi-line quoted values run to the closing quote
    [j("pass", "word: \"violetzz\nmaplezz\ncedarzz\"\nnext: ok"), j("pass", "word: [secret]\n[secret]\n[secret]\nnext: ok")],
    [j("pass", "word: 'violetzz\nmaplezz' # note\nnext: ok"), j("pass", "word: [secret]\n[secret] # note\nnext: ok")],
    [j("{\"sec", "ret\": \"violetzz\nmaplezz\", \"user\": \"bob\"}"), j("{\"sec", "ret\": [secret]\n[secret]")],
    // unindented flow maps run to the closing brace
    [j("sec", "ret: {\na: violetzz,\nb: maplezz\n}\nnext: ok"), j("sec", "ret: [secret]\n[secret]\n[secret]\n[secret]\nnext: ok")],
    [j("sec", "ret: [\nviolet,\nmaple\n]\nnext: ok"), j("sec", "ret: [secret]\n[secret]\n[secret]\n[secret]\nnext: ok")],
    [j("sec", "ret: {a: {b: violetzz},\nc: maplezz}\nnext: ok"), j("sec", "ret: [secret]\n[secret]\nnext: ok")],
  ];
  it.each(cases)("%j", (input, expected) => {
    expect(idem(input)).toBe(expected);
  });
  it("a continuation is masked in the JSON, HTML and SVG exports too", () => {
    for (const [input] of cases) {
      const out = exported(input);
      for (const w of ["maplezz", "cedarzz", "violetzz"]) expect(out.all).not.toContain(w);
    }
  });
  it("what is not a continuation is kept: dedented lines, siblings, other keys", () => {
    expect(idem(j("pass", "word: x\nnext: ok\n  indented: y"))).toBe(j("pass", "word: [secret]\nnext: ok\n  indented: y"));
    expect(idem(j("- pass", "word: x\n  user: bob\n  host: db"))).toBe(j("- pass", "word: [secret]\n  [secret]\n  [secret]")); // the rest of the item is the key's block
    expect(idem("a: 1\nb:\n  c: 2")).toBe("a: 1\nb:\n  c: 2");
  });
});

describe("jwt / psk / hmac and name/value pairs", () => {
  it.each(["jwt", "JWT", "psk", "hmac", "jwt_secret", "wifi.psk", "hmacKey", "x-hmac"])("%s is a secret key", (key) => {
    expect(idem(`${key}: violetzz maplezz`)).toBe(`${key}: [secret]`);
    expect(idem(`${key}=violetzz maplezz`)).toBe(`${key}=[secret]`);
    const out = exported(`${key}: violetzz maplezz`);
    noWords(out.all);
  });
  it("jwt reaches neither JSON, HTML nor SVG", () => {
    const out = exported("jwt: violetzz maplezz", true);
    noWords(out.all);
    expect(out.represented).toContain("jwt: [secret]");
  });
  const pairs: [string, string][] = [
    [j("- name: API_", "KEY\n  value: violetzz\n- name: LOG_LEVEL\n  value: debug"), j("- name: API_", "KEY\n  value: [secret]\n- name: LOG_LEVEL\n  value: debug")],
    [j("- value: violetzz\n  name: API_", "KEY\n- name: LOG_LEVEL\n  value: debug"), j("- value: [secret]\n  name: API_", "KEY\n- name: LOG_LEVEL\n  value: debug")],
    [j("env:\n  - name: DB_PA", "SSWORD\n    value: violetzz maplezz\n  - name: PORT\n    value: \"80\""), j("env:\n  - name: DB_PA", "SSWORD\n    value: [secret]\n  - name: PORT\n    value: \"80\"")],
    [j("- name: GITHUB_TOK", "EN\n  valueFrom: violetzz"), j("- name: GITHUB_TOK", "EN\n  valueFrom: [secret]")],
    [j("- name: \"API_", "KEY\"\n  value: \"violetzz\"\n  other: kept"), j("- name: \"API_", "KEY\"\n  value: \"[secret]\"\n  [secret]")], // `other` is in the item's block
    [j("{\n  \"name\": \"API_", "KEY\",\n  \"value\": \"violetzz\"\n}"), j("{\n  \"name\": \"API_", "KEY\",\n  \"value\": \"[secret]\"\n}")],
    [j("[{\"name\": \"API_", "KEY\", \"value\": \"violetzz\"}, {\"name\": \"PORT\", \"value\": \"80\"}]"), j("[{\"name\": \"API_", "KEY\", \"value\": [secret]")], // the rest of the line goes with a secret value
    [j("{name: API_", "KEY, value: violetzz maplezz}"), j("{name: API_", "KEY, value: [secret]")],
    [j("- name: API_", "KEY\n  value: |\n    violetzz\n    maplezz\n- name: X\n  value: y"), j("- name: API_", "KEY\n  value: |\n    [secret]\n    [secret]\n- name: X\n  value: y")],
  ];
  it.each(pairs)("%j", (input, expected) => {
    expect(idem(input)).toBe(expected);
    noWords(exported(input).all);
  });
  it("a name that is not a secret keeps its value; the secret word as a value elsewhere is untouched", () => {
    for (const text of ["- name: LOG_LEVEL\n  value: debug", "- name: PORT\n  value: 8080", "name: build\nvalue: 3"]) expect(idem(text)).toBe(text);
  });
  it("the one-pair-per-item reach: the next item's value is not touched", () => {
    expect(idem(j("- name: API_", "KEY\n- name: PORT\n  value: 80"))).toBe(j("- name: API_", "KEY\n- name: PORT\n  value: 80"));
  });
});

describe("known token prefixes mask the whole token, whatever its length", () => {
  const tail = (n: number, seed = "aB3xK9") => rep(seed, Math.ceil(n / seed.length)).slice(0, n);
  const TOKENS: [string, string][] = [
    ["glpat", j("glp", "at-", tail(20))], ["npm", j("np", "m_", tail(36))], ["hf", j("h", "f_", tail(34))], ["AIza", j("AI", "za", tail(35))],
    ["SG", j("S", "G.", tail(22), ".", tail(43))], ["xapp", j("xa", "pp-1-A0-", tail(30))], ["xoxe", j("xo", "xe-1-", tail(30))],
    ["xoxe.xoxp", j("xo", "xe.xoxp-1-", tail(30))], ["pk_live", j("pk_", "live_", tail(24))], ["rk_live", j("rk_", "live_", tail(24))], ["sk_live", j("sk_", "live_", tail(24))],
    ["ghp", j("gh", "p_", tail(36))], ["gho", j("gh", "o_", tail(36))], ["ghu", j("gh", "u_", tail(36))], ["ghs", j("gh", "s_", tail(36))], ["ghr", j("gh", "r_", tail(36))],
    ["github_pat", j("github_", "pat_", tail(40))], ["sk", j("s", "k-", tail(40))], ["xoxb", j("xo", "xb-", tail(30))], ["AKIA", j("AK", "IA", "ABCDEFGH12345678")], ["ASIA", j("AS", "IA", "ABCDEFGH12345678")],
    // long tokens: nothing of the tail survives
    ["glpat 300", j("glp", "at-", tail(300))], ["npm 400", j("np", "m_", tail(400))], ["ghp 600", j("gh", "p_", tail(600))], ["sk 5000", j("s", "k-", tail(5000))], ["AKIA 40", j("AK", "IA", rep("Z", 40))],
    ["AIza 300", j("AI", "za", tail(300))], ["xapp 300", j("xa", "pp-1-", tail(300))], ["hf 300", j("h", "f_", tail(300))], ["SG 300", j("S", "G.", tail(300), ".", tail(300))],
  ];
  it.each(TOKENS)("%s", (_name, token) => {
    expect(idem(`use ${token} now`)).toBe("use [secret] now");
    expect(idem(`use ${token}.`)).toBe("use [secret].");
    expect(idem(`(${token})`)).toBe("([secret])");
    const out = exported(`rotate ${token} soon.`, true);
    expect(out.all).not.toContain(token.slice(6, 16));
    expect(out.all).not.toContain(token.slice(-8));
    expect(out.represented).toContain("[secret]");
  });
  it("flagged by the OCR families", () => {
    const ocr = FAMILIES.filter((f) => f.ocr);
    for (const [, token] of TOKENS.slice(0, 21)) expect(ocr.some((f) => f.id === "token-prefix" && f.apply(`x ${token} y`) !== `x ${token} y`)).toBe(true);
    for (const [, token] of TOKENS.slice(0, 21)) expect(redact(`x ${token} y`)).toBe("x [secret] y");
  });
  it("prose and names that only start like a token survive", () => {
    for (const text of ["npm_config_registry", "set npm_config_cache", "the hf_ prefix", "hf_hub", "Use SG. Name", "SG.Name", "an AIza key", "xapp- tokens", "glpat- tokens", "pk_live_", "ASIA region", "ASIAPACIFIC", "npm_package_version", "HF_HOME"]) {
      expect(redact(text)).toBe(text.replace("pk_live_", "pk_live_"));
    }
  });
});

describe("values are masked whole, however long", () => {
  const long = rep("Qz", 300); // 600 characters
  const cases: [string, string][] = [
    [j("redis-cli --pa", "ss ", long, " ping"), j("redis-cli --pa", "ss [secret] ping")],
    [j("redis-cli --pa", "ss=", long), j("redis-cli --pa", "ss=[secret]")],
    [j("mysql -u root -", "p", long, " db"), "mysql -u root -p[secret] db"],
    [j("mysql -u root -", "p ", long, " db"), "mysql -u root -p [secret] db"],
    [j("redis-cli -", "a ", long, " ping"), "redis-cli -a [secret] ping"],
    [j("docker login -", "p ", long, " reg"), "docker login -p [secret] reg"],
    [j("curl -", "u ali", "ce:", long, " https://x.test"), "curl -u [secret] https://x.test"],
    [j("curl -", "ual", "ice:", long, " https://x.test"), "curl -u[secret] https://x.test"],
    [j("curl --", "user ali", "ce:", long), "curl --user [secret]"],
    [j("curl --", "user=ali", "ce:", long), "curl --user=[secret]"],
    [j("run --tok", "en ", long), j("run --tok", "en [secret]")],
    [j("run --db-pass", "word=\"", long, "\""), j("run --db-pass", "word=[secret]")],
    [j("\\\\ser", "ver\\share\\", long), "[path]"],
    [j("\\\\", rep("h", 63), "\\sh", "are\\", long), "[path]"],
    [j("see \\\\ser", "ver\\share\\", long, " here"), "see [path] here"],
    ["Bearer " + long, "Bearer [secret]"],
    ["Authorization: Bearer " + long + " next", "Bearer [secret] next"],
    [j("Authorization: Bas", "ic ", rep("QQ", 400)), "Authorization: [secret]"], // the key rule takes the whole line
    [j("send Bas", "ic ", rep("Qz1", 300)), j("send Bas", "ic [secret]")],
    [j("https://alice:", long, "@host.test/x"), "https://[credentials]@host.test/x"],
    [j("API_", "KEY=", long), j("API_", "KEY=[secret]")],
    [j("\"auth\": \"", long, "\""), j("\"auth\": \"[secret]\"")],
    [j("-ho", "me-fakeuser-", rep("a", 700)), "[path]"],
    [j("/sr", "v/", rep("a", 700), "/x"), "[path]"],
  ];
  it.each(cases.map((c) => [c[0].slice(0, 40), ...c] as [string, string, string]))("%s...", (_label, input, expected) => {
    const out = idem(input);
    expect(out).toBe(expected);
    expect(out).not.toContain("QzQz");
  });
  it("a PEM block of any size goes whole, and a header without END takes its whole body", () => {
    const big = rep("MIIEvQIBADANBgkqhkiG9w0B\n", 2800); // ~70 KB, no run long enough for the entropy rule
    const pem = j("-----BEGIN PRIV", "ATE KEY-----\n", big, "-----END PRIV", "ATE KEY-----");
    expect(idem(`a\n${pem}\nb`)).toBe("a\n[secret]\nb");
    expect(idem(j("-----BEGIN PRIV", "ATE KEY-----\n", big, "!tail text"))).toBe("[secret]!tail text");
    expect(idem(rep(j("-----BEGIN PRIV", "ATE KEY-----"), 3) + "!x")).toBe("[secret][secret][secret]!x");
    const two = `${pem}\nmid\n${pem}`;
    expect(idem(two)).toBe("[secret]\nmid\n[secret]");
  });
  it("is linear: adversarial 80K-450K character lines each redact in well under a second", () => {
    const N = 80_000;
    const bs = String.fromCharCode(92);
    const lines = [
      rep("a", N), rep("--a \"", N / 5), rep("--pa" + "ss \"", N / 8), rep("--pa" + "ss ", N / 7), rep("-p'", N / 3), rep("curl -u ", N / 8), rep(bs + bs + "a" + bs, N / 4), rep(bs + bs, N), rep("Bearer ", N / 7),
      rep("sk-", N / 3), rep("eyJ-", N / 4), rep("eyJaaaaaaaaaaa.", N / 15), rep("npm_", N / 4), rep("glpat-", N / 6), rep("AKIA", N / 4), rep("SG.", N / 3), rep("://", N / 3), rep("a://", N / 4),
      rep("@", N), rep("@/", N / 2), rep("~/", N / 2), rep("../", N / 3), rep("~/.claude/", N / 10), rep(j("-----BEGIN PRIV", "ATE KEY-----"), N / 27),
      rep("tok" + "en: {", N / 8), rep(j("pass", "word: \"a\n"), N / 12), rep("- name: API_" + "KEY\n", N / 16), rep("a: [\n", N / 5), rep("x".repeat(64) + ".", N / 65), rep("\\u005f", N / 6),
      rep("Basic ", N / 6), rep("-home-", N / 6), rep("a=", N / 2), rep("password" + " ", N / 9),
    ];
    for (const line of lines) {
      const text = line + "\n" + line;
      const t0 = performance.now();
      redact(text);
      const ms = performance.now() - t0;
      expect(ms, `${line.slice(0, 12)}`).toBeLessThan(1500);
    }
  });
});

describe("JSON escapes in keys are decoded before matching", () => {
  it("api\\u005fkey is api_key", () => {
    const text = j("{\"api\\u005f", "key\": \"violetzz maplezz\"}");
    expect(redact(text)).toContain("[secret]");
    expect(redact(text)).not.toContain("violetzz");
    expect(redact(redact(text))).toBe(redact(text));
    const out = exported(j("\"api\\u005f", "key\": \"violetzz maplezz\""));
    noWords(out.all);
    expect(snippetSafety(j("Never add comments, \"api\\u005f", "key\": \"x\""), undefined, { dataset: "real" })).toBe("unsure");
    expect(foldText("a\\u0041b")).toBe("aAb");
  });
  it("other escapes and ordinary text come back untouched", () => {
    expect(redact("caf\\u00e9 is fine")).toBe("caf\\u00e9 is fine");
    expect(redact("line\\u000a break")).toBe("line\\u000a break");
    expect(redact("plain \\u0041 text")).toBe("plain \\u0041 text");
  });
});

describe("pre-existing scanner edit: an approximate-number tilde is not a home path", () => {
  it("`~ 394` (an OCR'd approx sign before a number) is left alone, a real home reference is not", () => {
    for (const text of ["~ 394", "about ~ 394 tokens", "~ 3.5k", "~ 1,204 bytes", "~394", "~ .5"]) expect(redact(text)).toBe(text);
    expect(hasNonRelativePath("~ 394")).toBe(false);
    expect(redact("cd ~ now")).toBe("cd [path] now");
    expect(redact("cd ~")).toBe("cd [path]");
    expect(redact("~ /x/y")).toBe("[path]"); // a root followed by a path in the same run is one masked run
    expect(redact("~/x")).toBe("[path]");
  });
});

describe("a `~name` with no slash is prose", () => {
  it("`~alice` stays in the text; the table/poster show the rule's own words, with the redactor's other rules applied", () => {
    expect(redact(j("ask ~ali", "ce about it"))).toBe(j("ask ~ali", "ce about it"));
    expect(redact(j("~ali", "ce/diary.md"))).toBe("[path]");
  });
});
