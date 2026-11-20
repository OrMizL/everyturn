import { describe, expect, it } from "vitest";
import { buildPosterModel, buildReport, posterFindings, redact, renderPosterSvg, renderSourcesTableHtml, snippetSafety, type RawSource } from "../src/index";
import { FAMILIES } from "../src/patterns.mjs";

// Canaries are assembled at runtime so the repository privacy scan never sees a literal secret shape.
const j = (...parts: string[]) => parts.join("");
const idem = (text: string) => {
  const once = redact(text);
  expect(redact(once)).toBe(once);
  return once;
};
const WINFILE = j("C:", "\\Users", "\\alice", "\\personal", "\\diary.md");
const UNC = j("\\\\", "fileserver", "\\home", "\\alice", "\\diary.md");
const FULLWIDTH_COLON = "\uFF1A";
const COLONS = ["\uFF1A", "\uFE55", "\uA789", "\u2236", "\u02F8", "\uFE13"];
const EQUALS = ["\uFF1D", "\uFE66", "\uA78A", "\u2254"];

describe("multi-word secret values are masked to the end of the value", () => {
  it("masks every word after = := => for secret-like keys", () => {
    expect(idem(j("sec", "ret = amber violet maple cedar"))).toBe("secret = [secret]");
    expect(idem(j("api_", "key = amber violet maple cedar"))).toBe("api_key = [secret]");
    expect(idem(j("api_", "key := amber violet maple cedar"))).toBe("api_key := [secret]");
    expect(idem(j("api_", "key => amber violet maple cedar"))).toBe("api_key => [secret]");
    expect(idem(j("API ", "key = amber violet maple cedar"))).toBe("API key = [secret]");
    expect(idem(j("sec", "ret := amber violet maple cedar"))).toBe("secret := [secret]");
  });
  it("a quoted value keeps its quotes only when nothing but , } ] follows; otherwise everything to the end of the line is masked", () => {
    expect(idem(j("api_", 'key = "amber violet maple cedar" # note'))).toBe("api_key = [secret]");
    expect(idem(j("api_", "key = 'amber violet' ok"))).toBe("api_key = [secret]");
    expect(idem(j('{"api_', 'key": "amber violet maple", "region": "eu"}'))).toBe('{"api_key": [secret]');
    expect(idem(j('{"api_', 'key": "amber violet maple"}'))).toBe('{"api_key": "[secret]"}');
  });
  it("no delimiter stops the mask (; , } are masked too)", () => {
    expect(idem(j("api_", "key = amber violet; export REGION=eu"))).toBe("api_key = [secret]");
    expect(idem(j("api_", "key: amber violet maple, region: eu"))).toBe("api_key: [secret]");
    expect(idem(j("{api_", "key: amber violet}"))).toBe("{api_key: [secret]");
  });
  it("masks the whole value of upper-case config assignments written with spaces, to the end of the line", () => {
    expect(idem(j("API_", "KEY = amber violet maple cedar"))).toBe("API_KEY = [secret]");
    expect(idem(j("DB_TOK", "EN = amber violet; echo done"))).toBe("DB_TOKEN = [secret]");
    // A bare password-like key swallows the rest of the line.
    expect(idem(j("SEC", "RET = amber violet; echo done"))).toBe("SECRET = [secret]");
  });
  it("prose after any secret key is masked", () => {
    expect(idem(j("Never print the sec", "ret: rotate weekly"))).toBe("Never print the secret: [secret]");
    expect(idem(j("sec", "ret: keep this out of logs"))).toBe("secret: [secret]");
    expect(idem(j("The API ", "key: store it in a secure note"))).toBe("The API key: [secret]");
    expect(idem(j("sec", "ret: amber violet maple cedar"))).toBe("secret: [secret]");
    expect(idem(j("sec", "ret = rotate weekly"))).toBe("secret = [secret]");
    expect(idem(j("sec", "ret := rotate weekly"))).toBe("secret := [secret]");
    expect(idem(j("sec", "ret => rotate weekly"))).toBe("secret => [secret]");
    expect(idem(j("api_", "key = rotate weekly"))).toBe("api_key = [secret]");
  });
  it("applies to labels and to the poster", () => {
    const text = j("api_", "key = amber violet maple cedar");
    const raw: RawSource = { logicalPath: "CLAUDE.md", text: `# Setup\n- ${text}\n- ${j("sec", "ret = amber violet maple cedar")}\n`, scope: "project" };
    const named: RawSource = { logicalPath: j("docs/api_", "key = amber violet maple cedar.md"), text: "x", scope: "project" };
    const report = buildReport([raw, named]);
    const svg = renderPosterSvg(buildPosterModel(report, { findings: posterFindings(report, "claude-code") }));
    const all = JSON.stringify(report) + renderSourcesTableHtml(report) + svg;
    for (const word of ["amber", "violet", "maple", "cedar"]) expect(all).not.toContain(word);
  });
});

describe("Unicode separators and non-home absolute paths", () => {
  it("redacts values after fullwidth and other colon/equals variants", () => {
    for (const colon of COLONS) expect(idem(j("pass", `word${colon} canary123`))).toContain("[secret]");
    for (const colon of COLONS) expect(idem(j("pass", `word${colon}canary123`))).not.toContain("canary123");
    for (const eq of EQUALS) expect(idem(j("api_", `key ${eq} canary123`))).not.toContain("canary123");
    expect(idem(j("ｐａｓｓｗｏｒｄ", FULLWIDTH_COLON, "canary123"))).not.toContain("canary123");
    expect(idem(j("ＴＯＫＥＮ", "＝", "canary123"))).not.toContain("canary123");
  });
  it("leaves text without anything to redact untouched (no gratuitous NFKC)", () => {
    const text = "Use 2×2 grids … and ½ the budget";
    expect(redact(text)).toBe(text);
  });
  it("redacts /srv, /var/home, /export/home, /usr/home, /Users, drive and UNC user paths (the whole path is [path])", () => {
    expect(idem(j("/sr", "v/", "alice/personal/diary.md"))).toBe("[path]");
    expect(idem(j("see /var", "/home/", "alice/notes"))).toBe("see [path]");
    expect(idem(j("/export", "/home/", "alice/x"))).toBe("[path]");
    expect(idem(j("/usr", "/home/", "alice/x"))).toBe("[path]");
    expect(idem(j("/Us", "ers/", "alice/x"))).toBe("[path]");
    expect(idem(WINFILE)).toBe("[path]");
    expect(idem(j("C:", "\\Documents and Settings", "\\alice", "\\x"))).toBe("[path]");
    expect(idem(UNC)).toBe("[path]");
    // /srv inside a longer path is not a user directory.
    expect(redact("docs/srv/layout.md")).toBe("docs/srv/layout.md");
  });
});

describe("the snippet gate", () => {
  const unsure = (text: string) => expect(snippetSafety(text, undefined, { dataset: "real" })).toBe("unsure");
  const ok = (text: string) => expect(snippetSafety(text, undefined, { dataset: "real" })).toBe("ok");
  it("withholds key-like pairs with any colon/equals variant, on the NFKC form too", () => {
    for (const colon of [":", ...COLONS]) unsure(j("Never print pass", `word${colon} canary123`));
    for (const eq of ["=", ...EQUALS]) unsure(j("set api_", `key ${eq} canary123`));
    unsure(j("ｐａｓｓｗｏｒｄ", FULLWIDTH_COLON, "canary123"));
    unsure("export NODE_ENV=production first");
  });
  it("withholds absolute, drive, UNC and tilde paths", () => {
    for (const text of [j("Never read /sr", "v/alice/personal/diary.md"), "Never read /etc/hosts", `Never read ${WINFILE}`, "Never read D:/work/notes.md", `Never read ${UNC}`, "Never read ~/x", j("Never read ~", "\\x")]) unsure(text);
  });
  it("still shows ordinary prose, relative paths and URL-less text", () => {
    for (const text of ["Never add comments to code.", "Run tests in src/components before commit.", "Use named exports and/or default exports sparingly.", "Keep the secret out of logs."]) ok(text);
  });
});

describe("no canary reaches findings JSON, the HTML table or the poster SVG (real mode)", () => {
  const canaries = () => [
    j("pass", "word", FULLWIDTH_COLON, "canary123"),
    j("pass", "word", "\uFE55", "canary456"),
    j("pass", "word ", "\uFF1D", " canary789"),
    j("/sr", "v/alice/personal/diary.md"),
    j("/var", "/home/", "alice/personal/diary.md"),
    WINFILE,
    UNC,
    "/opt/clients/acme/plan.md",
    "D:/work/alice/diary.md",
  ];
  it.each(canaries().map((c, i) => [i, c] as const))("canary %i never appears", (_i, canary) => {
    const files: RawSource[] = [
      { logicalPath: "CLAUDE.md", text: `- Never add comments to code, see ${canary} for details.\n`, scope: "project" },
      { logicalPath: "CLAUDE.local.md", text: "- Add comments to code.\n", scope: "project" },
    ];
    const report = buildReport(files, { dataset: "real" });
    expect(report.findings.some((f) => f.kind === "conflict")).toBe(true);
    const svg = renderPosterSvg(buildPosterModel(report, { dataset: "UNREVIEWED REAL SET", findings: posterFindings(report, "claude-code") }));
    // Findings JSON, the HTML table and the poster must carry none of it, and since r5 neither does the rest of the report:
    // every absolute path (/opt/..., D:/...) is redacted in sources[].represented too.
    const shown = JSON.stringify(report.findings) + renderSourcesTableHtml(report) + svg;
    for (const needle of ["canary123", "canary456", "canary789", "alice", "diary", "fileserver", "acme"]) expect(shown).not.toContain(needle);
    for (const needle of ["canary123", "canary456", "canary789", "alice", "diary", "fileserver", "acme"]) expect(JSON.stringify(report)).not.toContain(needle);
    // The excerpt itself is withheld, not merely cleaned.
    expect(report.findings.find((f) => f.kind === "conflict")!.evidence[0]!.excerpt).toBeNull();
  });
});

describe("leftover CLI forms", () => {
  it("redacts the redis-cli, curl and docker login password flags", () => {
    expect(idem(j("redis-cli -h x -", "a v1xsecret ping"))).toBe("redis-cli -h x -a [secret] ping");
    expect(idem(j("curl -", "u alice:v1xsecret https://x.test/api"))).toBe("curl -u [secret] https://x.test/api");
    expect(idem(j("curl --us", "er alice:v1xsecret https://x.test"))).toBe("curl --user [secret] https://x.test");
    expect(idem(j("docker login -u alice -", "p v1xsecret registry.test"))).toBe("docker login -u alice -p [secret] registry.test");
    // A bare user name prompts for the password.
    expect(redact("curl -u alice https://x.test")).toBe("curl -u alice https://x.test");
  });
  it("keeps the psql port and the redis-cli port", () => {
    expect(redact("psql -h db -p 5432 -U app")).toBe("psql -h db -p 5432 -U app");
    expect(redact("redis-cli -p 6379")).toBe("redis-cli -p 6379");
  });
  it("an env-assignment prefix keeps the command that follows it", () => {
    expect(idem(j("PGPASS", "WORD=v1xsecret psql -h db"))).toBe("PGPASSWORD=[secret] psql -h db");
    expect(idem(j("MYSQL_P", "WD=v1xsecret mysql -u root"))).toBe("MYSQL_PWD=[secret] mysql -u root");
  });
  it("the -p rule does not continue across ; & |", () => {
    expect(idem(j("mysql -u root; tar -", "p x"))).toBe(j("mysql -u root; tar -", "p x"));
    expect(idem(j("mysql -u root && ls -", "p dir"))).toBe(j("mysql -u root && ls -", "p dir"));
    expect(idem(j("mysql -u root | grep -", "p x"))).toBe(j("mysql -u root | grep -", "p x"));
    expect(idem(j("mysql -", "pone; mysql -", "ptwo"))).toBe("mysql -p[secret]; mysql -p[secret]");
    expect(idem(j("mysql -", "p'a;b' db"))).toBe("mysql -p[secret] db");
  });
});

describe("every secret family is OCR-checked", () => {
  it("has ocr: true on every family (no documented exceptions)", () => {
    expect(FAMILIES.filter((f) => !f.ocr).map((f) => f.id)).toEqual([]);
    expect(FAMILIES.find((f) => f.id === "cli-p-secret")!.ocr).toBe(true);
  });
});

describe("env-style KEY=value with spaces", () => {
  it("masks the whole unquoted value unless a shell command follows", async () => {
    const { redact } = await import("../src/redact");
    expect(redact(["API_K", "EY=amber violet maple"].join(""))).toBe("API_KEY=[secret]");
    // everything to the end of the line is masked, and only paired client variables keep a command.
    expect(redact(["DB_PA", "SS=amber violet; ls"].join(""))).toBe("DB_PASS=[secret]");
    expect(redact(["PGPASS", "WORD=x psql -h db"].join(""))).toBe("PGPASSWORD=[secret] psql -h db");
    expect(redact(["API_TOK", "EN=abc ./run.sh"].join(""))).toBe("API_TOKEN=[secret]");
  });
});
