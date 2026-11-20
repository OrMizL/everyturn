import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FAMILIES, looseSecretKey } from "../../core/src/patterns.mjs";
import { j, put, sandbox } from "./helpers";

// Secret-shaped inputs are assembled at runtime (j) so the repository privacy scan never sees a literal key/value, home path or token.
const exec = promisify(execFile);
const scanner = resolve("scripts/privacy-scan.mjs");
type Result = { code: number; text: string };
const scan = (args: string[], env: Record<string, string> = {}): Promise<Result> =>
  exec(process.execPath, [scanner, ...args], { env: { PATH: process.env.PATH ?? "", ...env } })
    .then((r) => ({ code: 0, text: r.stdout + r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, text: e.stdout + e.stderr }));

/** A stand-in tesseract that prints a sidecar file, so the OCR text of each case is exact. */
async function ocrScan(box: Awaited<ReturnType<typeof sandbox>>, ocr: string) {
  const bin = join(box.root, "fake-tesseract.sh");
  await writeFile(bin, `#!/bin/sh\ncat "$1.ocr"\n`, { mode: 0o755 });
  await put(box.repo, "out/x.png", "png bytes are never read by the stand-in");
  await put(box.repo, "out/x.png.ocr", ocr);
  return scan([box.repo, "--render-check"], { EVERYTURN_TESSERACT: bin });
}
const CLEAN = "Hello poster tokens estimate in the sources list.\n";

describe("the OCR loose-key rule", () => {
  const MUST_FAIL: [string, string][] = [
    ["API_LKEY (extra letter)", j("API_LK", "EY=fakevalue")],
    ["AP1_K3Y (1 for I, 3 for E)", j("AP1_K", "3Y=fakevalue")],
    ["APl_KEY (l for I)", j("APl_K", "EY: fakevalue")],
    ["api key with a space", j("api k", "ey: fakevalue")],
    ["T0KEN (0 for O)", j("T0K", "EN: fakevalue")],
    ["passw0rd", j("passw", "0rd = fakevalue")],
    ["SECRET with a camelCase prefix", j("client", "Sec", "ret: fakevalue")],
    ["a plural", j("tok", "ens: fakevalue")],
    ["AUTH", j("AU", "TH: fakevalue")],
    ["Authorization with one garbled letter", j("Authorizati", "0n: fakevalue")],
  ];
  it.each(MUST_FAIL)("fails: %s", async (_label, line) => {
    const box = await sandbox();
    try {
      const r = await ocrScan(box, CLEAN + line + "\n");
      expect(r.code).toBe(1);
      expect(r.text).toContain("(rendered text)");
      expect(r.text).not.toContain("fakevalue");
    } finally { await box.cleanup(); }
  });
  it("loose family is named in the failure for the garbled keys the exact matcher misses", async () => {
    const box = await sandbox();
    try {
      for (const line of [j("API_LK", "EY=fakevalue"), j("AP1_K", "3Y=fakevalue")]) {
        const r = await ocrScan(box, CLEAN + line + "\n");
        expect(r.text).toContain("family secret-keys-ocr-loose (rendered text)");
      }
    } finally { await box.cleanup(); }
  });
  const BENIGN = [["Author", "Someone"], ["keyboard", "us"], ["monkey", "x"], ["hotkey", "y"], ["Authority", "none"], ["Authors", "two"], ["bypass", "true"], ["passed", "645"], ["compass", "north"], ["Primary key", "id"], ["turkey", "2"], ["sigma", "3"]].map(([k, v]) => k + ": " + v);
  it.each(BENIGN)("passes: %s", async (line) => {
    const box = await sandbox();
    try {
      const r = await ocrScan(box, CLEAN + line + "\n");
      expect(r.text).not.toContain("rendered text");
      expect(r.code).toBe(0);
    } finally { await box.cleanup(); }
  });
  it("the matcher itself: whole components, not substrings", () => {
    for (const text of ["Author: Someone", "keyboard: us", "monkey: x", "hotkey: y", "author:x", "Authorities=1"]) expect(looseSecretKey(text), text).toBe(false);
    for (const text of [j("API_LK", "EY=x"), j("AP1_K", "3Y=x"), j("api k", "ey: x"), j("pass", "word: x"), j("my_tok", "en=x"), j("AccessK", "ey: x")]) expect(looseSecretKey(text), text).toBe(true);
    expect(looseSecretKey(j("tok", "en:"))).toBe(false); // no value
    expect(looseSecretKey(j("tok", "en: [secret]"))).toBe(false); // already redacted
  });
  it("is linear: an 80K-character identifier line runs in under 200 ms", () => {
    const N = 80_000;
    const lines = [
      "A".repeat(N) + ": x", "a_".repeat(N / 2) + ": x", "aB".repeat(N / 2) + ": x", "tok".repeat(N / 3) + "en: x", "API_".repeat(N / 4) + "LKEY=x",
      "api ".repeat(N / 4) + "key: x", "a:".repeat(N / 2), "token ".repeat(N / 6), "k3y=".repeat(N / 4), "0".repeat(N) + "=x", "a1l".repeat(N / 3) + ":x",
    ];
    for (const line of lines) {
      const t0 = performance.now();
      looseSecretKey(line);
      const ms = performance.now() - t0;
      expect(ms, line.slice(0, 12)).toBeLessThan(200);
    }
  });
});

describe("strict artifact rules are chosen explicitly, or by generated file type", () => {
  const abs = () => j("see /op", "t/tools/run for details");
  it("a folder named out/ is not strict by its name", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "out/notes.txt", abs());
      expect(await scan([box.repo])).toMatchObject({ code: 0 });
      const strict = await scan([box.repo, "--artifacts", "out"]);
      expect(strict.code).toBe(1);
      expect(strict.text).toContain("family paths");
      // a relative directory is relative to the scan root; an absolute one works too
      expect((await scan([box.repo, "--artifacts", join(box.repo, "out")])).code).toBe(1);
    } finally { await box.cleanup(); }
  });
  it("--artifacts is repeatable, and a directory outside the repo is scanned too", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "gen-a/a.txt", abs());
      await put(box.repo, "gen-b/b.txt", "clean");
      const outside = join(box.root, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "c.txt"), abs());
      expect(await scan([box.repo, "--artifacts", join(box.repo, "gen-b")])).toMatchObject({ code: 0 });
      expect((await scan([box.repo, "--artifacts", join(box.repo, "gen-b"), "--artifacts", join(box.repo, "gen-a")])).code).toBe(1);
      expect((await scan([box.repo, "--artifacts", outside])).code).toBe(1);
      await writeFile(join(outside, "c.txt"), "clean");
      expect((await scan([box.repo, "--artifacts", outside])).code).toBe(0);
    } finally { await box.cleanup(); }
  });
  it("--extra directories are strict too", async () => {
    const box = await sandbox();
    try {
      const extra = join(box.root, "extra");
      await mkdir(extra);
      await writeFile(join(extra, "e.txt"), abs());
      const r = await scan([box.repo, "--extra", extra]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("family paths");
    } finally { await box.cleanup(); }
  });
  it.each([".svg", ".json", ".html"])("a generated %s anywhere outside the source directories is strict, wherever it sits", async (ext) => {
    const box = await sandbox();
    try {
      await put(box.repo, `build/report${ext}`, abs());
      const r = await scan([box.repo]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("family paths");
      await put(box.repo, `build/report${ext}`, "clean");
      expect((await scan([box.repo])).code).toBe(0);
    } finally { await box.cleanup(); }
  });
  it("source directories and root-level config files keep the source rules (they may document paths)", async () => {
    const box = await sandbox();
    try {
      for (const where of ["docs/x.json", "fixtures/x.json", "packages/a/x.json", "scripts/x.html", ".github/x.json", "apps/web/src/x.svg", "package.json", "config.json"]) await put(box.repo, where, abs());
      expect(await scan([box.repo])).toMatchObject({ code: 0 });
    } finally { await box.cleanup(); }
  });
  it("a plain text file elsewhere keeps the source rules, an --artifacts flag without a directory is an error", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "notes/x.txt", abs());
      expect(await scan([box.repo])).toMatchObject({ code: 0 });
      expect((await scan([box.repo, "--artifacts"])).code).toBe(2);
      expect((await scan([box.repo, "--artifacts", "--render-check"])).code).toBe(2);
    } finally { await box.cleanup(); }
  });
  it("--render-check also looks at PNGs in --artifacts directories", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "pngs/x.png", "not a png");
      expect((await scan([box.repo, "--render-check", "--artifacts", join(box.repo, "pngs")])).text).toContain("png ocr unavailable/empty");
      expect(await scan([box.repo, "--render-check"])).toMatchObject({ code: 0 });
    } finally { await box.cleanup(); }
  });
});

describe("literal values of credential keys in source files", () => {
  const literal = FAMILIES.find((f) => f.id === "secret-literals")!;
  const flagged = (text: string) => literal.apply(text) !== text;
  it("flags a hard-coded literal", () => {
    for (const text of [
      j("au", 'th: "abc123token"'), j("const c = { au", "th: 'abc123token' };"), j('"autho', 'rization": "Bearer-abc123"'), j('"autho', 'rization": "abcdefgh"'),
      j("coo", "kie: sid=abc123def456"), j("coo", 'kie: "sid=abc123"'), j("sess", 'ion: "abc123xyz"'), j("headers.au", "th = abc123xyz9"), j("j", 'wt: "abcdefgh"'), j("hm", 'ac: "abcdefgh"'),
      j("ps", 'k: "abcdefgh"'), j("ds", 'n: "abc123xyz"'), j("be", "arer: abc123xyz9"), j("cook", 'ies: "abcdefgh"'), j("x_au", 'th: "abc123token"'), j("client_au", 'th: "abc123token"'),
    ]) expect(flagged(text), text).toBe(true);
  });
  it("lets types, empty values, placeholders, templates, environment reads and prose through", () => {
    // [key, rest]: the pieces are joined at runtime, so no source line of this file holds a literal `key: value`
    const pairs: [string, string][] = [
      ["auth", ": string"], ["auth", ": boolean;"], ["auth?", ": string | undefined"], ["auth", ': ""'], ["auth", ": ''"], ["auth", ': "<token>"'], ["auth", ': "[token]"'],
      ["auth", ": process.env.AUTH_HEADER"], ["auth", ': "${AUTH}"'], ["auth", ": `${token}`"], ["auth", ': "xxx"'], ["auth", ': "xxxxxxxx"'], ["auth", ': "changeme"'],
      ["auth", ': "change-me"'], ["auth", ': "your-token-here"'], ["auth", ': "YOUR_TOKEN"'], ["auth", ': "..."'], ["auth", ': "{{ token }}"'], ["auth", ': "$TOKEN"'],
      ["auth", ': "%TOKEN%"'], ["cookie", ": string"], ["cookie", ": Cookie"], ["cookie", ": undefined"], ["cookie", ": null"], ["session", ": Session"],
      ["session", ": SessionStore"], ["auth", ": AuthConfig"], ["auth", ": config.auth.token"], ["auth", ': "Authentication failed"'], ["auth", ": true"],
      ["auth", ": false"], ["auth", ": none"], ["auth", ": getToken()"], ["auth", ": Bearer"], ["authorization", ': "Bearer <token>"'], ["cookie", ": ${COOKIE}"],
      ["auth", ": import.meta.env.X"], ["jwt", ': "example"'], ["dsn", ": process.env.SENTRY_DSN"], ["session", ": 3"], ["auth", ": 12345"], ["const auth", " = 1;"],
      ["auth", ": abc"], ["session id", ": none"],
    ];
    for (const [key, rest] of pairs) expect(flagged(key + rest), key + rest).toBe(false);
  });
  it("the scan fails a source file with such a literal, names only the family, and passes the repo's own sources", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "src/ok.ts", "export const a: { auth: string; cookie: string } = { auth: process.env.A ?? '', cookie: '' };\n");
      expect(await scan([box.repo])).toMatchObject({ code: 0 });
      await put(box.repo, "src/bad.ts", j("export const c = { au", 'th: "abc123token" };\n'));
      const r = await scan([box.repo]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("family secret-literals");
      expect(r.text).not.toContain("abc123token");
    } finally { await box.cleanup(); }
  });
  it("redaction is unchanged: exported text already has these keys masked by the full key rule", async () => {
    const { redact } = await import("../../core/src/index");
    expect(redact(j("au", 'th: "abc123token"'))).toBe(j("au", 'th: "[secret]"'));
  });
});

describe("pre-existing scanner edits: glued OCR variants skip secret-keys, internal-host and secret-literals", () => {
  it("gluing words does not invent an internal host (`file.` + `local`)", async () => {
    const box = await sandbox();
    try {
      // gluing the last words together would read a host name; the plain text has none
      const r = await ocrScan(box, CLEAN + "Overrides live in the file.\nlocal\n");
      expect(r).toMatchObject({ code: 0 });
    } finally { await box.cleanup(); }
  });
  it("gluing words does not invent a key (`co` + `okie:`), a literal, or a host, while the same text unbroken still fails", async () => {
    const box = await sandbox();
    try {
      const r = await ocrScan(box, CLEAN + j("The co\nokie: abc123xyz9\n"));
      expect(r).toMatchObject({ code: 0 });
      const bad = await ocrScan(box, CLEAN + j("coo", "kie: abc123xyz9\n"));
      expect(bad.code).toBe(1);
      expect(bad.text).toContain("(rendered text)");
    } finally { await box.cleanup(); }
  });
  it("an OCR'd approximate hero number (`~ 394`) is not a home path", async () => {
    const box = await sandbox();
    try {
      expect(await ocrScan(box, CLEAN + "~ 394 tokens in 5 sources\n")).toMatchObject({ code: 0 });
      expect((await ocrScan(box, CLEAN + "cd ~ now\n")).code).toBe(1);
    } finally { await box.cleanup(); }
  });
  it("a host in the plain text is still caught", async () => {
    const box = await sandbox();
    try {
      const r = await ocrScan(box, CLEAN + j("connect to db.acme.", "internal now\n"));
      expect(r.code).toBe(1);
      expect(r.text).toContain("family internal-host (rendered text)");
    } finally { await box.cleanup(); }
  });
});
