import { describe, expect, it } from "vitest";
import { buildPosterModel, buildReport, posterFindings, redact, renderPosterSvg, renderSourcesTableHtml, snippetSafety, type RawSource } from "../src/index";
import { hasNonRelativePath, hasSecretKeyPair, isSecretKeyName } from "../src/patterns.mjs";

// Secret-shaped inputs are assembled at runtime so the repository privacy scan never sees a literal key=value line.
const j = (...parts: string[]) => parts.join("");
const idem = (text: string) => {
  const once = redact(text);
  expect(redact(once)).toBe(once);
  return once;
};

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
const WORDS = ["amber", "violet", "maple", "cedar", "sunny", "rainbow", "violetzz", "maplezz"];

describe("secret keys mask to the end of the line, in every export", () => {
  const cases: [string, string, string][] = [
    [j("API_", "KEY=amber git violet"), j("API_", "KEY=[secret]"), "amber"],
    [j("GITHUB_", "TOK", "EN=amber go violet"), j("GITHUB_", "TOK", "EN=[secret]"), "violet"],
    [j("DB_", "PA", "SS=sunny git rainbow 77"), j("DB_", "PA", "SS=[secret]"), "rainbow"],
    ['"auth": "violetzz maplezz"', '"auth": "[secret]"', "maplezz"],
    [j('"cred', 'ential": "violetzz maplezz"'), j('"cred', 'ential": "[secret]"'), "maplezz"],
    [j("'cred", "ential' = amber violet"), j("'cred", "ential' = [secret]"), "violet"],
    ["auth: amber violet", "auth: [secret]", "violet"],
    [j("api_", "key:\n  amber violet maple"), j("api_", "key:\n  [secret]"), "maple"],
    [j("api_", "key: |\n  amber violet\n  maple cedar\nnext: ok"), j("api_", "key: |\n  [secret]\n  [secret]\nnext: ok"), "cedar"],
    [j("api_", "key: >-\n  amber violet\nnext: ok"), j("api_", "key: >-\n  [secret]\nnext: ok"), "violet"],
    [j('"sec', 'ret": keep amber violet'), j('"sec', 'ret": [secret]'), "keep amber"],
    [j("pass ", "word: amber violet"), j("pass ", "word: [secret]"), "violet"],
    [j("api ", "key: amber violet"), j("api ", "key: [secret]"), "violet"],
    [j("secret ", "key: amber violet"), j("secret ", "key: [secret]"), "violet"],
    [j("aws_sec", "ret_access_", "key = amber violet"), j("aws_sec", "ret_access_", "key = [secret]"), "violet"],
    [j("x-api-", "key: amber violet"), j("x-api-", "key: [secret]"), "violet"],
    [j("client", "Sec", "ret: amber violet"), j("client", "Sec", "ret: [secret]"), "violet"],
    [j("db.pass", "word = amber violet"), j("db.pass", "word = [secret]"), "violet"],
    ["session: amber violet", "session: [secret]", "violet"],
    ["cookie => amber violet", "cookie => [secret]", "violet"],
    ["salt := amber violet", "salt := [secret]", "violet"],
    ["otp -> amber violet", "otp -> [secret]", "violet"],
    [j("pass", "word＝amber violet"), j("pass", "word=[secret]"), "violet"], // NFKC folds the fullwidth equals sign
  ];
  it.each(cases)("%s", (input, expected, word) => {
    expect(idem(input)).toBe(expected);
    const out = exported(input);
    expect(out.represented).toContain(expected.split("\n")[0]!);
    for (const w of WORDS) expect(out.all).not.toContain(w);
    expect(out.represented).not.toContain(word);
  });
  it("a JSON value on the next lines is masked, nested objects included", () => {
    const nested = j('{\n  "credent', 'ials": {\n    "user": "amber"\n  },\n  "name": "b"\n}');
    // a sibling after the secret key lies in the same JSON node (the block backstop), so it is masked too.
    expect(idem(nested)).not.toContain('"name": "b"');
    expect(idem(nested)).not.toContain("amber");
    expect(idem(j('"tok', 'en":\n  "amber",\n"user": "bob"'))).toBe(j('"tok', 'en":\n  "[secret]",\n"user": "bob"'));
  });
  it("a quoted value keeps its quotes only when nothing but , } ] follows", () => {
    expect(idem('{"auth": "amber violet"}')).toBe('{"auth": "[secret]"}');
    expect(idem(j('{"au', 'th": "amber", "user": "bob"}'))).toBe('{"auth": [secret]');
  });
  it("paired client variables keep their client, every other KEY=value masks to the end of the line", () => {
    expect(idem(j("PGPASS", "WORD=x psql -h db"))).toBe(j("PGPASS", "WORD=[secret] psql -h db"));
    expect(idem(j("PGPASS", "WORD=x pg_dump db"))).toBe(j("PGPASS", "WORD=[secret] pg_dump db"));
    expect(idem(j("MYSQL_", "PW", "D=x mysql -u root"))).toBe(j("MYSQL_", "PW", "D=[secret] mysql -u root"));
    expect(idem(j("REDISCLI_", "AUTH=x redis-cli ping"))).toBe(j("REDISCLI_", "AUTH=[secret] redis-cli ping"));
    expect(idem(j("PGPASS", "WORD=x git push"))).toBe(j("PGPASS", "WORD=[secret]"));
    expect(idem(j("MYSQL_", "PW", "D=x psql"))).toBe(j("MYSQL_", "PW", "D=[secret]"));
    expect(idem(j("PGPASS", "WORD=a b psql"))).toBe(j("PGPASS", "WORD=[secret]")); // not one shell word
    expect(idem(j("PGPASS", "WORD = x psql"))).toBe(j("PGPASS", "WORD = [secret]")); // config syntax, not shell
    expect(idem(j("API_", "KEY=git curl violet maple"))).toBe(j("API_", "KEY=[secret]"));
  });
  it("redis-cli's pass flag and curl's attached -u form are redacted", () => {
    expect(idem(j("redis-cli --pa", "ss amber ping"))).toBe(j("redis-cli --pa", "ss [secret] ping"));
    expect(idem(j("curl -ual", "ice:amber https://x.test"))).toBe("curl -u[secret] https://x.test");
    expect(redact("curl -u alice https://x.test")).toBe("curl -u alice https://x.test");
  });
  it("the shared matcher: whole words and components, with the documented exclusions", () => {
    for (const name of ["auth", "Authorization", "credentials", "cookie", "session", "bearer", "privatekey", "pass", "pwd", "passwd", "password", "passphrase", "token", "secret", "key", "apikey", "signature", "sig", "dsn", "salt", "otp", "pin", "pin-code",
      "GITHUB_TOKEN", "aws_secret_access_key", "x-api-key", "clientSecret", "db.password", "dbpassword", "SERVICE_KEYNAME", "tokens"]) expect(isSecretKeyName(name)).toBe(true);
    for (const name of ["keyboard", "monkey", "hotkey", "author", "bypass", "compass", "turkey", "estTokens", "sigma", "name", "path"]) expect(isSecretKeyName(name)).toBe(false);
    expect(isSecretKeyName("key", "primary")).toBe(false); // "Primary key: id"
    expect(isSecretKeyName("word", "pass")).toBe(true);
    expect(hasSecretKeyPair(j('"au', 'th": "x"'))).toBe(true);
    expect(hasSecretKeyPair("the session lasts an hour")).toBe(false);
  });
  it("prose around keys that only contain a key word stays readable", () => {
    for (const text of ["Primary key: id", "keyboard: us", "author: Someone", "the session lasts an hour", "mkdir -p dist"]) expect(redact(text)).toBe(text);
  });
});

describe("paths are shown only when repo-relative", () => {
  const PATHS = ["/opt/alice/x", "/var/lib/alice/x", "/mnt/data/alice/x", j("~ali", "ce/diary.md"), j("/sr", "v/alice/x"), j("/ho", "me/alice/x"), j("/Us", "ers/alice/x"),
    j("C:", "\\Us", "ers", "\\ali", "ce\\x"), j("C:/Us", "ers/alice/x"), j("\\\\", "server\\share\\alice"), j("file:///sr", "v/x/alice"), "~/alice/x", j("~", "\\ali", "ce\\x")];
  it.each(PATHS)("%s never reaches JSON, HTML or the poster SVG", (path) => {
    const out = exported(`see ${path} for details.`, true);
    expect(idem(path)).toBe("[path]");
    expect(out.all).not.toContain("alice");
    expect(out.represented).toContain("[path]");
    // the snippet is withheld, not just cleaned
    expect(out.report.findings.find((f) => f.kind === "conflict")!.evidence.some((e) => e.excerpt === null)).toBe(true);
  });
  it("shows repo-relative paths", () => {
    for (const text of ["docs/setup.md", "./scripts/run.sh", ".claude/rules/x.md", "docs/../y.md", "**/*.ts", "https://example.com/a/b"]) expect(idem(text)).toBe(text);
  });
  it("any tilde form and any absolute form is [path], also a single segment and a `..` out of the repo", () => {
    expect(idem("cd ~")).toBe("cd [path]");
    expect(idem("a ~/x b")).toBe("a [path] b");
    expect(idem("see /opt for it")).toBe("see [path] for it");
    expect(idem("../../etc/hosts")).toBe("[path]");
    expect(idem("read ../notes.md")).toBe("read [path]");
    expect(idem("a/../../b")).toBe("[path]");
    expect(idem("run /review now")).toBe("run /review now"); // a slash command, not a path
    expect(idem("about ~N tokens")).toBe("about ~N tokens");
  });
  it("only the tool's own user-config logical paths keep their `~`", () => {
    for (const p of ["~/.claude/CLAUDE.md", "~/.claude/settings.json", "~/.codex/AGENTS.md", "~/.codex/AGENTS.override.md", "~/.claude/settings.local.json", "~/.claude/skills/x/SKILL.md", "~/.agents/skills/x/SKILL.md"]) expect(idem(p)).toBe(p);
    for (const p of ["~/.claude/projects/alice/x.jsonl", "~/.claude/../x.md", "~/.ssh/config"]) expect(idem(p)).toBe("[path]");
    const r = buildReport([{ logicalPath: "~/.claude/CLAUDE.md", text: "- Be brief.\n", scope: "user" }], { includeUser: true });
    expect(r.sources[0]!.logicalPath).toBe("~/.claude/CLAUDE.md");
  });
  it("hasNonRelativePath is the one decision (the gate uses it)", () => {
    expect(hasNonRelativePath("/opt")).toBe(true);
    expect(hasNonRelativePath("docs/setup.md")).toBe(false);
    expect(hasNonRelativePath("~/.claude/settings.json")).toBe(false);
  });
});

describe("snippet gate", () => {
  const unsure = (text: string) => expect(snippetSafety(text, undefined, { dataset: "real" })).toBe("unsure");
  const ok = (text: string) => expect(snippetSafety(text, undefined, { dataset: "real" })).toBe("ok");
  it("withholds quoted keys and tilde-user paths", () => {
    unsure('Never add comments, "auth": "violetzz maplezz".');
    unsure(j('Never add comments, "cred', 'ential": "violetzz".'));
    unsure(j("Never add comments to ~ali", "ce/diary.md"));
    unsure("Never read /opt");
    unsure("Never add comments to ../../x.md");
  });
  it("shows 2-space indentation in real mode, and relative paths", () => {
    ok("Use 2-space indentation.");
    ok("Use 4-space indentation in docs/setup.md.");
    ok("Primary key: id");
  });
});
