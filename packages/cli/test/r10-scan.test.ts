import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redact } from "../../core/src/index";
import { j, put, sandbox } from "./helpers";

// The scanner side of r10. The old leaking outputs are assembled at runtime (j) so the repository scan never sees them.
const exec = promisify(execFile);
const scanner = resolve("scripts/privacy-scan.mjs");
type Result = { code: number; text: string };
const scan = (args: string[], env: Record<string, string> = {}): Promise<Result> =>
  exec(process.execPath, [scanner, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, maxBuffer: 64 * 1024 * 1024 })
    .then((r) => ({ code: 0, text: r.stdout + r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, text: e.stdout + e.stderr }));
afterEach(() => vi.restoreAllMocks());

const BS = String.fromCharCode(92);
const HOME = j("$HO", "ME");
const PW = j("pass", "word");
const VALUE = j("never add comments violet", "zz maple", "zz");
const wrap: Record<string, (t: string) => string> = {
  "everyturn.json": (t) => JSON.stringify({ sources: [{ represented: `see ${t} for details.\n` }] }),
  "everyturn-sources.html": (t) => `<table><tr><td>see ${t} for details.</td></tr></table>`,
  "everyturn.source.svg": (t) => `<svg xmlns="http://www.w3.org/2000/svg"><text>see ${t} for details.</text></svg>`,
};
async function ocrScan(box: Awaited<ReturnType<typeof sandbox>>, ocr: string) {
  const bin = join(box.root, "fake-tesseract.sh");
  await put(box.root, "fake-tesseract.sh", `#!/bin/sh\ncat "$1.ocr"\n`);
  await exec("chmod", ["755", bin]);
  await put(box.repo, "out/x.png", "png bytes are never read by the stand-in");
  await put(box.repo, "out/x.png.ocr", ocr);
  return scan([box.repo, "--render-check"], { EVERYTURN_TESSERACT: bin });
}
const CLEAN = "Hello poster tokens estimate in the sources list.\n";

describe("the scanner flags the old leaking outputs, and passes what the fixed redactor makes of them", () => {
  const OLD_PATHS: [string, string][] = [
    [j(HOME, "/alicefake/notes.md"), "home-path"],
    [j("${HO", "ME}/alicefake/notes.md"), "home-path"],
    [j('"', HOME, '/.config/fakeapp/alice.json"'), "home-path"],
    [j("$env:USERPROFILE", BS, "alicefake", BS, "notes.md"), "home-path"],
    [j("%USERPROFILE%", BS, "alicefake", BS, "notes.md"), "home-path"],
    [j("%userprofile%", BS, "alicefake", BS, "notes.md"), "home-path"],
    [j("%HOMEPATH%", BS, "alicefake", BS, "notes.md"), "home-path"],
    [j("%APPDATA%", BS, "alicefake", BS, "x.json"), "home-path"],
    [j("%LOCALAPPDATA%", BS, "alicefake", BS, "x.json"), "home-path"],
    [j("[path]", "  two three/violetzz.md"), "path-tail"],
    [j("[path]", "   two three/violetzz.md"), "path-tail"],
    [j("[path]", "\ttwo three/violetzz.md"), "path-tail"],
    [j("[path]", "  two three/violetzz.md"), "path-tail"],
  ];
  it.each(OLD_PATHS)("%s fails in JSON, HTML and SVG (family %s)", async (old, family) => {
    const box = await sandbox();
    try {
      for (const [file, make] of Object.entries(wrap)) {
        await put(box.repo, `out/${file}`, make(old));
        const r = await scan([box.repo, "--artifacts", "out"]);
        expect(r.code, `${file}: ${JSON.stringify(old)}`).toBe(1);
        expect(r.text).toContain(`family ${family}`);
        expect(r.text).not.toMatch(/alice|violetzz|fakeapp|two three/);
        // what the fixed redactor makes of the same text
        const input = old.startsWith("[path]") ? `~/one${old.slice(6)}` : old;
        const fixed = redact(input);
        expect(fixed).toMatch(/^"?\[path\]"?$/);
        await put(box.repo, `out/${file}`, make(fixed));
        expect(await scan([box.repo, "--artifacts", "out"]), file).toMatchObject({ code: 0 });
        await put(box.repo, `out/${file}`, "{}");
      }
    } finally { await box.cleanup(); }
  });
  it("secret value forms written out in an HTML or SVG text fail; the fixed redactor's output of them passes", async () => {
    const box = await sandbox();
    try {
      const forms = [
        [j("- na", "me: >-"), j("    API", "_KEY"), `  ${j("val", "ue: ")}${VALUE}`].join("\n"),
        [j("- na", "me: &n API", "_KEY"), `  ${j("val", "ue: ")}${VALUE}`].join("\n"),
        [j(PW, ' = """'), "", VALUE, '"""'].join("\n"),
        [j(PW, ":"), "  *ref", "", `defaults: &ref ${VALUE}`].join("\n"),
        [`defaults: &ref ${VALUE}`, "", j(PW, ":"), "  *ref"].join("\n"),
        [j(PW, ': &ref "'), "", VALUE, '"'].join("\n"),
      ];
      for (const form of forms) {
        await put(box.repo, "out/everyturn-sources.html", `<pre>\n${form}\n</pre>`);
        const r = await scan([box.repo, "--artifacts", "out"]);
        expect(r.code, form).toBe(1);
        expect(r.text).toContain("family secret-keys");
        expect(r.text).not.toMatch(/violetzz|maplezz/);
        await put(box.repo, "out/everyturn-sources.html", `<pre>\n${redact(form)}\n</pre>`);
        expect(await scan([box.repo, "--artifacts", "out"]), form).toMatchObject({ code: 0 });
      }
    } finally { await box.cleanup(); }
  });
});

describe("path families on the joined variants", () => {
  it("our own allowlisted row label and the next cell's repo-relative path PASS in HTML and SVG", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "out/everyturn-sources.html", "<table><tr><td>~/.claude/CLAUDE.md</td><td>docs/x.md</td></tr><tr><td>~/.codex/AGENTS.md:6</td><td>src/a.ts</td></tr></table>");
      await put(box.repo, "out/everyturn.source.svg", '<svg xmlns="http://www.w3.org/2000/svg"><text>~/.claude/CLAUDE.md</text><text>docs/x.md</text></svg>');
      const r = await scan([box.repo, "--artifacts", "out"]);
      expect(r.code, r.text).toBe(0);
    } finally { await box.cleanup(); }
  });
  it("OCR: a row label plus the next row's path PASS (a line join is a run break); spaced path tails and env roots FAIL", async () => {
    const box = await sandbox();
    try {
      for (const text of ["~/.claude/CLAUDE.md\ndocs/x.md\n", "~/.claude/CLAUDE.md:12 ≠ AGENTS.md:6", "~/.claude/skills/release-notes/SKILL.md · user", "~/.claude/CLAUDE.md  docs/x.md"]) {
        expect(await ocrScan(box, `${CLEAN}${text}\n`), text).toMatchObject({ code: 0 });
      }
      for (const text of [j(HOME, "/alicefake/notes.md"), j("%USERPROFILE%", BS, "alicefake", BS, "notes.md"), j("see [path]", "  two three/violetzz.md here"), j("[path]", "\ttwo three/violetzz.md")]) {
        const r = await ocrScan(box, `${CLEAN}${text}\n`);
        expect(r.code, text).toBe(1);
        expect(r.text).toContain("(rendered text)");
      }
    } finally { await box.cleanup(); }
  });
});
