import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redact } from "../../core/src/index";
import { j, put, sandbox } from "./helpers";

// The scanner side of r8. Old leaking outputs are assembled at runtime (j) so the repository scan never sees them.
const exec = promisify(execFile);
const scanner = resolve("scripts/privacy-scan.mjs");
type Result = { code: number; text: string };
const scan = (args: string[], env: Record<string, string> = {}): Promise<Result> =>
  exec(process.execPath, [scanner, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, maxBuffer: 64 * 1024 * 1024 })
    .then((r) => ({ code: 0, text: r.stdout + r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, text: e.stdout + e.stderr }));
afterEach(() => vi.restoreAllMocks());

async function ocrScan(box: Awaited<ReturnType<typeof sandbox>>, ocr: string) {
  const bin = join(box.root, "fake-tesseract.sh");
  await put(box.root, "fake-tesseract.sh", `#!/bin/sh\ncat "$1.ocr"\n`);
  await exec("chmod", ["755", bin]);
  await put(box.repo, "out/x.png", "png bytes are never read by the stand-in");
  await put(box.repo, "out/x.png.ocr", ocr);
  return scan([box.repo, "--render-check"], { EVERYTURN_TESSERACT: bin });
}
const CLEAN = "Hello poster tokens estimate in the sources list.\n";

describe("the scanner flags the old leaking outputs", () => {
  const OLD_TAILS = [j("[path]", " private notes/alice.md"), j("[path]", " for alice/today.md"), j("[path]", " two three/alice.md")];
  it.each(OLD_TAILS)("%s fails in JSON, HTML and SVG, and the fixed output of the same text passes", async (old) => {
    const box = await sandbox();
    try {
      const wrap: Record<string, (t: string) => string> = {
        "everyturn.json": (t) => JSON.stringify({ sources: [{ represented: `see ${t} for details.\n` }] }),
        "everyturn-sources.html": (t) => `<table><tr><td>see ${t} for details.</td></tr></table>`,
        "everyturn.source.svg": (t) => `<svg xmlns="http://www.w3.org/2000/svg"><text>see ${t} for details.</text></svg>`,
      };
      for (const [file, make] of Object.entries(wrap)) {
        await put(box.repo, `out/${file}`, make(old));
        const r = await scan([box.repo, "--artifacts", "out"]);
        expect(r.code, `${file}: ${old}`).toBe(1);
        expect(r.text).toContain("family path-tail");
        expect(r.text).not.toMatch(/alice|private notes|today/);
        // what the fixed redactor makes of the same input
        const fixed = redact(old.replace("[path]", j("~/", old.slice(7).replace(/ /g, "_"))).replace(/_/g, " "));
        await put(box.repo, `out/${file}`, make(fixed));
        expect(await scan([box.repo, "--artifacts", "out"]), file).toMatchObject({ code: 0 });
        await put(box.repo, `out/${file}`, "{}");
      }
    } finally { await box.cleanup(); }
  });
  it("the old secret-block output (a masked key, then the value on a later line) fails the artifact scan", async () => {
    const box = await sandbox();
    try {
      const old = j("pass", "word: [secret]\n\nnever add comments violet", "zz maple", "zz,\n]\n");
      await put(box.repo, "out/everyturn.json", JSON.stringify({ sources: [{ represented: old }] }));
      await put(box.repo, "out/everyturn-sources.html", `<pre>${old}</pre>`);
      const r = await scan([box.repo, "--artifacts", "out"]);
      expect(r.code).toBe(1);
      expect(r.text).not.toMatch(/violetzz|maplezz/);
    } finally { await box.cleanup(); }
  });
});

describe("the OCR check", () => {
  it.each([
    j("[path]", " private notes/alice.md"), j("see [path]", " for alice/today.md here"),
    j("pass", "word: [secret]\n\nnever add comments violet", "zz maple", "zz,\n]"),
  ])("fails %s (plain variants)", async (line) => {
    const box = await sandbox();
    try {
      const r = await ocrScan(box, `${CLEAN}${line}\n`);
      expect(r.code).toBe(1);
      expect(r.text).toContain("(rendered text)");
    } finally { await box.cleanup(); }
  });
  it("the two-space line join leaves everything the earlier OCR battery flagged flagged, and what it passed passed", async () => {
    const box = await sandbox();
    try {
      for (const text of [j("GITHUB_T0KEN", "_VALUE: x"), j("SESS", "lON_ID: x"), j("API_K", "3Y_NAME: x"), "cd ~ now", j("/ho", "me/alice/.claude/settings.json"), j("~/.claude/rules/ali", "ce.md"), j("/opt/ali", "ce/CLAUDE.md"), j("C:", "\\Users", "\\alice", "\\SKILL.md")]) {
        expect((await ocrScan(box, `${CLEAN}${text}\n`)).code, text).toBe(1);
      }
      for (const text of ["~/.claude/skills/release-notes/SKILL.md · user", "~/.claude/settings.json", "~/.codex/AGENTS.md", "~\n394\n", "x ~\n394 est. tokens\n", "~/.claude/CLAUDE.md\ndocs/x.md\n", "~/.claude/CLAUDE.md:12 ≠ AGENTS.md:6"]) {
        expect(await ocrScan(box, `${CLEAN}${text}\n`), text).toMatchObject({ code: 0 });
      }
    } finally { await box.cleanup(); }
  });
  it("the byline needs its line to end: `everyturn @OrMiz` + `.fakecompany.test` / `fakecompany.test` FAIL, the earlier passing cases pass", async () => {
    const box = await sandbox();
    try {
      for (const ocr of ["F everyturn @ormiz\n.claude/settings.json 267 B\n", "everyturn @OrMiz .claude/skills/db-migrations/SKILL.md\n", "everyturn @OrMiz\nStatic scan, not a recording\n", "everyturn @OrMiz\n0.1.0 Preview\n", "everyturn @OrMiz"]) {
        expect(await ocrScan(box, CLEAN + ocr), ocr).toMatchObject({ code: 0 });
      }
      for (const ocr of ["everyturn @OrMiz\n.fakecompany.test\n", "everyturn @OrMiz\nfakecompany.test\n", "everyturn @OrMiz.fakecompany.test\n", "everyturn @OrMiz fakecompany.test\n"]) {
        expect((await ocrScan(box, CLEAN + ocr)).code, ocr).toBe(1);
      }
    } finally { await box.cleanup(); }
  });
});

describe("the binary chunk is checked by its bytes, not its name", () => {
  const FONTS = ["inter/Inter-Regular", "inter/Inter-Medium", "inter/Inter-SemiBold", "inter/Inter-Bold", "jetbrains-mono/JetBrainsMonoNL-Regular", "jetbrains-mono/JetBrainsMonoNL-Medium"].map((n) => `packages/core/assets/fonts/${n}.ttf`);
  const CHUNK = "apps/web/dist/assets/binary-forged.js";
  it("a forged binary chunk fails: base64 of a key=value line, or a long alphanumeric literal", async () => {
    const box = await sandbox();
    try {
      const keyed = Buffer.from(j("API_", "KEY=violet", "zz maple", "zz ", "x".repeat(400))).toString("base64");
      await put(box.repo, CHUNK, `const A="${keyed}";export{A as w};\n`);
      const r = await scan([box.repo]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("family binary-literal");
      expect(r.text).not.toMatch(/violetzz|maplezz/);
      await put(box.repo, CHUNK, `const A="${"a1".repeat(150)}";export{A as w};\n`);
      expect((await scan([box.repo])).code).toBe(1);
    } finally { await box.cleanup(); }
  });
  it("the real wasm and six fonts pass, and the denylist reads the un-blanked text", async () => {
    const box = await sandbox();
    try {
      const files = ["node_modules/@resvg/resvg-wasm/index_bg.wasm", ...FONTS];
      const literals = await Promise.all(files.map(async (f) => (await readFile(resolve(f))).toString("base64")));
      await put(box.repo, CHUNK, `const ${literals.map((l, i) => `v${i}="${l}"`).join(",")};export{v0 as w};\n`);
      const clean = await scan([box.repo]);
      expect(clean.code, clean.text).toBe(0);
      // a private-name term that happens to occur inside a verified literal is still found: the denylist runs before anything is blanked
      const term = /[A-Za-z0-9]{12}/.exec(literals[1]!.slice(2000))![0];
      await put(box.root, "deny.txt", `${term}\n`);
      const denied = await scan([box.repo], { EVERYTURN_DENYLIST: join(box.root, "deny.txt") });
      expect(denied.code).toBe(1);
      expect(denied.text).toContain("denylist family");
      expect(denied.text).not.toContain(term);
    } finally { await box.cleanup(); }
  }, 120_000);
});
