import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index";
import { j, put, sandbox } from "./helpers";

// Secret-shaped and home-path inputs are assembled at runtime (j) so the repository privacy scan never sees a literal key/value, home path or token.
const exec = promisify(execFile);
const scanner = resolve("scripts/privacy-scan.mjs");
type Result = { code: number; text: string };
const scan = (args: string[], env: Record<string, string> = {}): Promise<Result> =>
  exec(process.execPath, [scanner, ...args], { env: { PATH: process.env.PATH ?? "", ...env } })
    .then((r) => ({ code: 0, text: r.stdout + r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, text: e.stdout + e.stderr }));
afterEach(() => vi.restoreAllMocks());

/** A stand-in tesseract that prints a sidecar file, so the OCR text of each case is exact. */
async function ocrScan(box: Awaited<ReturnType<typeof sandbox>>, ocr: string) {
  const bin = join(box.root, "fake-tesseract.sh");
  await put(box.root, "fake-tesseract.sh", `#!/bin/sh\ncat "$1.ocr"\n`);
  await exec("chmod", ["755", bin]);
  await put(box.repo, "out/x.png", "png bytes are never read by the stand-in");
  await put(box.repo, "out/x.png.ocr", ocr);
  return scan([box.repo, "--render-check"], { EVERYTURN_TESSERACT: bin });
}
const CLEAN = "Hello poster tokens estimate in the sources list.\n";

describe("the scanner classifies by an exact allowlist", () => {
  const KEYED = j("j", "wt: violet", "zz\n");
  const OPT = j("/op", "t/alice/x\n");
  it.each([
    "apps/web/everyturn.json", "apps/web/test/report.json", "everyturn.json", "docs/generated/everyturn.json", "apps/web/test/everyturn-sources.html", "docs/everyturn.source.svg",
    "apps/web/dist/index.html", "apps/web/dist/data.json", "apps/web/unknown-output.json",
  ])("%s with a secret key or an absolute path FAILS", async (file) => {
    for (const text of [KEYED, OPT]) {
      const box = await sandbox();
      try {
        await put(box.repo, file, file.endsWith(".json") ? JSON.stringify({ text }) : text);
        const r = await scan([box.repo]);
        expect(r.code, `${file}: ${text}`).toBe(1);
        expect(r.text).not.toMatch(/violetzz|alice/);
      } finally { await box.cleanup(); }
    }
  });
  it.each([
    "apps/web/package.json", "apps/web/tsconfig.json", "apps/web/index.html", "apps/web/src/notes.json", "docs/notes.json", "fixtures/x/sample.json", "packages/core/test/data.json", "package.json",
  ])("%s, hand-written, keeps the source rules (a path is documentation there)", async (file) => {
    const box = await sandbox();
    try {
      await put(box.repo, file, file.endsWith(".json") ? JSON.stringify({ doc: OPT.trim() }) : `<p>${OPT.trim()}</p>`);
      expect(await scan([box.repo])).toMatchObject({ code: 0 });
    } finally { await box.cleanup(); }
  });
  it("a secret in a source file still fails (tokens are never allowed anywhere)", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "apps/web/package.json", JSON.stringify({ t: j("ghp_", "A".repeat(10), "b".repeat(14), "7") }));
      expect((await scan([box.repo])).code).toBe(1);
    } finally { await box.cleanup(); }
  });
  it("an app's dist scripts are artifacts: a path in a string literal fails, a regex or `key:` property in code does not", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "apps/web/dist/assets/index-abc.js", `const re=/^\\s*#|\\/a\\/b/;const o={key:1,id:2};function f(e){return e.replace(/\\\\r\\\\n?/g,"\\n")}\n`);
      expect(await scan([box.repo])).toMatchObject({ code: 0 });
      await put(box.repo, "apps/web/dist/assets/index-abc.js", `const p=${JSON.stringify(j("/ho", "me/alice/.claude/x"))};\n`);
      const r = await scan([box.repo]);
      expect(r.code).toBe(1);
      expect(r.text).not.toContain("alice");
      await put(box.repo, "apps/web/dist/assets/index-abc.js", `const p=${JSON.stringify(j("secret", "_key: violet", "zz"))};\n`);
      expect((await scan([box.repo])).code).toBe(1);
    } finally { await box.cleanup(); }
  });
  it("the binary chunk's verified base64 literals are blanked, the rest of that chunk is scanned", async () => {
    const box = await sandbox();
    try {
      // a literal is blanked only when it is, byte for byte, one of the renderer's own wasm/font files (a made-up blob no longer passes).
      const blob = (await readFile(resolve("packages/core/assets/fonts/inter/Inter-Regular.ttf"))).toString("base64");
      await put(box.repo, "apps/web/dist/assets/binary-abc.js", `const A="${blob}";export{A as w};\n`);
      expect(await scan([box.repo])).toMatchObject({ code: 0 });
      await put(box.repo, "apps/web/dist/assets/binary-abc.js", `const A="${blob}";const B=${JSON.stringify(j("/ho", "me/alice/x"))};export{A as w};\n`);
      expect((await scan([box.repo])).code).toBe(1);
      // the same literal in any other chunk is not exempt
      await put(box.repo, "apps/web/dist/assets/binary-abc.js", "export{};\n");
      await put(box.repo, "apps/web/dist/assets/index-abc.js", `const A="${blob}";\n`);
      expect((await scan([box.repo])).code).toBe(1);
    } finally { await box.cleanup(); }
  });
});

describe("the OCR check", () => {
  it.each([j("GITHUB_T0KEN", "_VALUE: x"), j("SESS", "lON_ID: x"), j("API_K", "3Y_NAME: x")])("fails %s", async (line) => {
    const box = await sandbox();
    try {
      const r = await ocrScan(box, CLEAN + line + "\n");
      expect(r.code).toBe(1);
      expect(r.text).toContain("(rendered text)");
    } finally { await box.cleanup(); }
  });
  it("passes an already-masked value", async () => {
    const box = await sandbox();
    try {
      expect(await ocrScan(box, CLEAN + j("coo", 'kie: "[secret]"\n'))).toMatchObject({ code: 0 });
    } finally { await box.cleanup(); }
  });
  it("a lone `~` on its own (the hero ~394 split in two) is not a path; `cd ~ now` still is", async () => {
    const box = await sandbox();
    try {
      for (const ocr of ["~\n394\n", "~\n", "x ~\n394 est. tokens\n", "  ~  \n394\n"]) expect(await ocrScan(box, CLEAN + ocr), JSON.stringify(ocr)).toMatchObject({ code: 0 });
      expect((await ocrScan(box, CLEAN + "cd ~ now\n")).code).toBe(1);
    } finally { await box.cleanup(); }
  });
  it("the byline `everyturn @OrMiz` glued to a column-merged path is not an email; a real address still fails", async () => {
    const box = await sandbox();
    try {
      for (const ocr of ["F everyturn @ormiz\n.claude/settings.json 267 B\n", "everyturn @OrMiz .claude/skills/db-migrations/SKILL.md\n"]) expect(await ocrScan(box, CLEAN + ocr), ocr).toMatchObject({ code: 0 });
      for (const ocr of [j("everyturn@ormiz", ".claude"), j("ali", "ce @ormiz\n.claude/x\n"), j("me ", "@acme-corp.io\n")]) expect((await ocrScan(box, CLEAN + ocr + "\n")).code, ocr).toBe(1);
    } finally { await box.cleanup(); }
  });
  it("does not fail on the allowlisted user-config paths, garbled or truncated; any other path still fails", async () => {
    const box = await sandbox();
    try {
      for (const text of [
        "~/.claude/skills/release-notes/SKILL.md · user", "~/.claude/skills/…/SKILL.md · user", "~/.claude/skills/.../SKILL.md user", "…/skills/release-notes/SKILL.md",
        "…settings.json", "~/.claude/settings.json", "~/.codex/AGENTS.md", "~/…/SKILL.md", "_/skills/release-notes/SKILL.md",
      ]) expect(await ocrScan(box, CLEAN + text + "\n"), text).toMatchObject({ code: 0 });
      for (const text of [j("/ho", "me/alice/.claude/settings.json"), j("~/.claude/rules/ali", "ce.md"), j("/opt/ali", "ce/CLAUDE.md"), j("C:", "\\Users", "\\alice", "\\SKILL.md")]) {
        expect((await ocrScan(box, CLEAN + text + "\n")).code, text).toBe(1);
      }
    } finally { await box.cleanup(); }
  });
});

describe("a legitimate --include-user poster passes the artifact scan and the render check", () => {
  it("generates the poster and PNG, then both gates pass", async () => {
    const box = await sandbox();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await put(box.home, ".claude/skills/release-notes/SKILL.md", "---\nname: release-notes\ndescription: Draft release notes from merged changes.\n---\n# Body\n");
      await put(box.home, ".claude/skills/fakealice/SKILL.md", "---\nname: helper\ndescription: Does a helper thing.\n---\n# Body\n");
      await put(box.home, ".claude/settings.json", JSON.stringify({ model: "opus" }));
      await put(box.home, ".claude/CLAUDE.md", "- Never add comments.\n");
      await put(box.repo, "CLAUDE.md", "- Add comments.\n- Run tests.\n");
      const out = join(box.root, "out");
      expect(await run([box.repo, "--out", out, "--include-user", "--allow-out-in-repo", "--dataset", "real"], { home: box.home, temp: box.temp, xdgRuntimeDir: undefined })).toBe(0);
      const source = await readFile(join(out, "everyturn.source.svg"), "utf8");
      const report = await readFile(join(out, "everyturn.json"), "utf8");
      expect(source).toMatch(/skills\/(?:release-notes|…)/);
      expect(source + report).toContain("· user");
      expect(source + report).not.toContain("fakealice");
      expect(report).toContain("~/.claude/skills/[name]/SKILL.md");
      expect(report).toContain("~/.claude/skills/release-notes/SKILL.md");
      const strict = await scan([box.root, "--artifacts", "out"]);
      expect(strict.code, strict.text).toBe(0);
      const rendered = await scan([box.root, "--render-check", "--artifacts", "out"]);
      expect(rendered.code, rendered.text).toBe(0);
      expect(rendered.text).toContain("1 png");
    } finally { await box.cleanup(); }
  }, 60_000);
});

describe("the CLI reminds you to review everyturn.json", () => {
  it("prints the warning after the wrote lines", async () => {
    const box = await sandbox();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await put(box.repo, "CLAUDE.md", "- Run tests.\n");
      expect(await run([box.repo, "--out", join(box.root, "out"), "--allow-out-in-repo", "--dataset", "real"], { home: box.home, temp: box.temp, xdgRuntimeDir: undefined })).toBe(0);
      const note = "Review everyturn.json before sharing; it keeps the redacted text of every source.";
      const at = lines.indexOf(note);
      expect(at).toBeGreaterThan(-1);
      expect(lines.slice(0, at).filter((l) => l.startsWith("wrote ")).length).toBe(6);
      expect(lines.slice(at + 1).some((l) => l.startsWith("wrote "))).toBe(false);
    } finally { await box.cleanup(); }
  });
});
