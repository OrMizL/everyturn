import { execFile, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { fontFiles } from "../src/index";
import { j, put, sandbox } from "./helpers";

const exec = promisify(execFile);
const scanner = resolve("scripts/privacy-scan.mjs");
type Result = { code: number; text: string };
const scan = (args: string[], env: Record<string, string> = {}): Promise<Result> =>
  exec(process.execPath, [scanner, ...args], { env: { PATH: process.env.PATH ?? "", ...env } })
    .then((r) => ({ code: 0, text: r.stdout + r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, text: e.stdout + e.stderr }));
const hasTesseract = (() => { try { execFileSync("tesseract", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

/** A PNG with `text` drawn in the bundled Inter font. */
function png(text: string, size = 64): Uint8Array {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="170"><rect width="100%" height="100%" fill="#fff"/><text x="24" y="112" font-family="Inter" font-size="${size}" fill="#000">${text}</text></svg>`;
  return new Resvg(svg, { font: { loadSystemFonts: false, fontFiles, defaultFontFamily: "Inter" } }).render().asPng();
}

describe("the scan has the redactor's families", () => {
  const b64 = () => j("dXNlcjpwYXNz", "d29yZDEyMzQ1Ng==");
  const canaries: [string, () => string][] = [
    ["40-hex", () => j("0123456789abcdef", "0123456789abcdef", "01234567")],
    ["32-hex", () => j("fedcba9876543210", "fedcba9876543210")],
    ["uuid", () => j("123e4567-", "e89b-12d3-", "a456-", "426614174000")],
    ["Authorization Basic", () => j("Authorization: Bas", "ic ", b64())],
    ["bare Basic", () => j("Bas", "ic ", b64())],
    ["long secret flag", () => j("run --tok", "en x1")],
    ["short assignment (4 chars)", () => j("tok", "en: ab12")],
    ["short upper assignment", () => j("MY_TOK", "EN=ab12")],
    ["multi-word", () => j("pass", "word: correct horse battery")],
    ["fat arrow", () => j('"pass', 'word" => "ab12"')],
    ["thin arrow", () => j("tok", "en -> ab12")],
    ["next-line JSON", () => j('{"tok', 'en":\n  "ab12"}')],
    ["home path with spaces", () => j("/ho", "me/Fake Alice/x")],
    ["mac home path with spaces", () => j("/Us", "ers/Fake Alice/x")],
    ["bare dash-encoded home", () => j("-ho", "me-fakeuser")],
    ["root home", () => j("cd /ro", "ot/x")],
  ];
  it.each(canaries)("detects %s without echoing it", async (_label, make) => {
    const box = await sandbox();
    try {
      await put(box.repo, "out/canary.txt", make());
      const r = await scan([box.repo]);
      expect(r.code).toBe(1);
      expect(r.text).toMatch(/file 1 matches family/);
      for (const part of make().split(/[\s"]+/).filter((p) => p.length > 3)) expect(r.text).not.toContain(part);
    } finally { await box.cleanup(); }
  });
  it("detects canaries in file names, and passes readable names and short git SHAs", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "notes/release2026-notes.md", "Primary key: id. Fixed in a1b2c3d. See .claude/skills/release2026-notes/SKILL.md and app/root/x.");
      expect((await scan([box.repo])).code).toBe(0);
      await put(box.repo, j("-ho", "me-fakeuser/x.txt"), "ok");
      expect((await scan([box.repo])).code).toBe(1);
    } finally { await box.cleanup(); }
  });
  it("shares its patterns with the redactor (one module, imported by both)", async () => {
    const { readFile } = await import("node:fs/promises");
    expect(await readFile("packages/core/src/redact.ts", "utf8")).toContain('from "./patterns.mjs"');
    expect(await readFile("scripts/privacy-scan.mjs", "utf8")).toContain("packages/core/src/patterns.mjs");
  });
});

describe("PNGs get a rendered-text check", () => {
  it("fails a PNG that OCR cannot read, even with a clean matching sibling source", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "out/poster.png", "not really a png");
      let r = await scan([box.repo]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("file 1 png ocr unavailable/empty");
      expect(r.text).not.toContain("poster");
      await put(box.repo, "out/poster.source.svg", "<svg><text>All clear here, nothing to see in this poster.</text></svg>");
      r = await scan([box.repo]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("png ocr unavailable/empty");
    } finally { await box.cleanup(); }
  });
  it.runIf(hasTesseract).each([
    ["X.source.svg", "x.png", "x.source.svg", (s: string) => `<svg><text><tspan>${s}</tspan></text></svg>`],
    ["X.html", "x.png", "x.html", (s: string) => `<html><body><p>${s}</p></body></html>`],
    ["sources.png + everyturn-sources.html", "sources.png", "everyturn-sources.html", (s: string) => `<table><tr><td>${s}</td></tr></table>`],
  ])("scans the visible text of a matching sibling source in addition to OCR: %s", async (_label, pngName, sibling, wrap) => {
    const box = await sandbox();
    try {
      await put(box.repo, `out/${pngName}`, png("Hello poster"));
      await put(box.repo, `out/${sibling}`, wrap("All clear here."));
      expect((await scan([box.repo])).code).toBe(0);
      await put(box.repo, `out/${sibling}`, wrap(j("/ho", "me/Fake Alice/x")));
      const r = await scan([box.repo]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("(rendered text)");
      expect(r.text).not.toMatch(/Fake|Alice|x\.png|sources\.png/);
    } finally { await box.cleanup(); }
  });
  it.runIf(hasTesseract)("an unrelated sibling never counts: a .png.txt, another PNG's source, or a sibling of a different stem", async () => {
    const box = await sandbox();
    try {
      const leak = j("/ho", "me/Fake Alice/x");
      await put(box.repo, "out/x.png", png("Hello poster"));
      await put(box.repo, "out/x.png.txt", leak);
      await put(box.repo, "out/other.source.svg", `<svg><text>${leak}</text></svg>`);
      await put(box.repo, "out/other.html", `<p>${leak}</p>`);
      await put(box.repo, "out/everyturn-sources.html", `<p>${leak}</p>`); // belongs to sources.png only
      // --render-check looks only at PNGs: none of those files is x.png's source, so none is read for it.
      expect((await scan([box.repo, "--render-check"])).code).toBe(0);
      // And a .png.txt cannot stand in for a missing OCR read.
      await put(box.repo, "out/y.png", "not really a png");
      await put(box.repo, "out/y.png.txt", "Hello poster, all clear, plenty of words here.");
      const r = await scan([box.repo, "--render-check"]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("png ocr unavailable/empty");
      expect(r.text).not.toContain("(rendered text)");
    } finally { await box.cleanup(); }
  });
  it.runIf(hasTesseract)("reassembles text split across tags and entities before matching", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "out/x.png", png("Hello poster"));
      await put(box.repo, "out/x.source.svg", `<svg><text><tspan>${j("/ho", "me/ora")}</tspan><tspan>fake/&#112;roj</tspan></text></svg>`);
      const r = await scan([box.repo]);
      expect(r.code).toBe(1);
      expect(r.text).toMatch(/family home-path \(rendered text\)/);
    } finally { await box.cleanup(); }
  });
  it.runIf(hasTesseract)("OCRs the pixels: clean text passes, a denylisted name fails even a character off (OCR noise)", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "out/clean.png", png("Hello poster tokens estimate"));
      expect((await scan([box.repo])).code).toBe(0);
      // No sibling source at all: only OCR can pass this, so it must have read the pixels.
      await put(box.repo, "out/alone/ocr-only.png", png("Hello poster tokens estimate"));
      expect((await scan([box.repo])).code).toBe(0);
      const list = await put(box.root, "deny.txt", "zebracorp\nnorthwind notes\n");
      await put(box.repo, "out/alone/ocr-only.png", png("ZEBRACORP internal roadmap"));
      let r = await scan([box.repo], { EVERYTURN_DENYLIST: list });
      expect(r.code).toBe(1);
      expect(r.text).toContain("denylist family (rendered text)");
      expect(r.text).not.toMatch(/zebra|ocr-only/i);
      // One character off ("zebracorb"): fuzzy match for terms of 6+ characters.
      await put(box.repo, "out/alone/ocr-only.png", png("Zebracorb internal roadmap"));
      r = await scan([box.repo], { EVERYTURN_DENYLIST: list });
      expect(r.code).toBe(1);
      // Two characters off is not a match.
      await put(box.repo, "out/alone/ocr-only.png", png("Zebrakorb internal roadmap"));
      expect((await scan([box.repo], { EVERYTURN_DENYLIST: list })).code).toBe(0);
    } finally { await box.cleanup(); }
  }, 120_000);
  it.runIf(hasTesseract)("OCR finds a home path and an email drawn into pixels", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "out/p.png", png(j("/ho", "me/orfake/notes/plan.md"), 56));
      const path = await scan([box.repo]);
      expect(path.code).toBe(1);
      expect(path.text).toContain("(rendered text)");
      await put(box.repo, "out/p.png", png(j("write to ", "private", "@", "company.test"), 56));
      const mail = await scan([box.repo]);
      expect(mail.code).toBe(1);
      expect(mail.text).toContain("(rendered text)");
    } finally { await box.cleanup(); }
  }, 120_000);

  it.runIf(hasTesseract)("--render-check checks only PNGs under out/ plus --extra dirs, ignoring other text files", async () => {
    const box = await sandbox();
    try {
      const leak = j("/ho", "me/Fake Alice/x");
      await put(box.repo, "notes.txt", leak);
      await put(box.repo, "out/ok.png", png("Hello poster"));
      await put(box.repo, "out/ok.source.svg", "<svg><text>fine</text></svg>");
      await put(box.repo, "elsewhere/stray.png", "not a png");
      const ok = await scan([box.repo, "--render-check"]);
      expect(ok).toMatchObject({ code: 0 });
      expect(ok.text).toContain("render-check PASS (1 png files)");
      // --extra adds directories.
      const extra = join(box.root, "extra");
      await mkdir(extra);
      await writeFile(join(extra, "bad.png"), "not a png");
      const bad = await scan([box.repo, "--render-check", "--extra", extra]);
      expect(bad.code).toBe(1);
      expect(bad.text).toContain("png ocr unavailable/empty");
      expect(bad.text).toContain("render-check FAIL");
      await writeFile(join(extra, "bad.source.svg"), `<svg><text>${leak}</text></svg>`);
      expect((await scan([box.repo, "--render-check", "--extra", extra])).text).toContain("(rendered text)");
      // A repo without out/ has nothing to check.
      expect((await scan([join(box.root, "temp"), "--render-check"])).code).toBe(0);
    } finally { await box.cleanup(); }
  });
});

describe("the render-check cannot fail open", () => {
  /** A blank poster-sized PNG with no text at all. */
  const blank = () => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><rect width="100%" height="100%" fill="#fff"/></svg>`).render().asPng();
  const planted = () => j("gh", "p_ ", "FAKEfakeFAKE", " fakeFAKE123456");

  it.runIf(hasTesseract)("fails a PNG with a planted ghp_ token that OCR splits (rendered with resvg from an SVG)", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "out/planted.png", png(planted(), 56));
      let r = await scan([box.repo, "--render-check"]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("family token-prefix (rendered text)");
      expect(r.text).not.toMatch(/FAKE|fake|planted/);
      // The same token after other words on the line (whitespace removal alone would glue it to the word before).
      await put(box.repo, "out/planted.png", png(j("Source list and ", planted()), 52));
      r = await scan([box.repo, "--render-check"]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("(rendered text)");
      // Unsplit.
      await put(box.repo, "out/planted.png", png(j("gh", "p_FAKEfakeFAKEfakeFAKE123456"), 56));
      expect((await scan([box.repo, "--render-check"])).code).toBe(1);
    } finally { await box.cleanup(); }
  }, 120_000);

  it.runIf(hasTesseract)("fails a PNG that shows a mysql password flag and a fake password with no sibling source", async () => {
    const box = await sandbox();
    try {
      for (const text of [j("mysql -u root -", "pFakeSmall9 appdb"), j("mysql -u root -", "p FakeSmall9 appdb")]) {
        await put(box.repo, "out/mysql.png", png(text, 56));
        const r = await scan([box.repo, "--render-check"]);
        expect(r.code).toBe(1);
        expect(r.text).toContain("family cli-p-secret (rendered text)");
        expect(r.text).not.toMatch(/Fake|Small9/);
      }
    } finally { await box.cleanup(); }
  }, 120_000);

  it.runIf(hasTesseract)("fails a PNG that shows a compound secret key with a multi-word value (second word a command)", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "out/apikey.png", png(j("API_K", "EY=amber git violet maple"), 56));
      const r = await scan([box.repo, "--render-check"]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("(rendered text)");
      expect(r.text).not.toMatch(/amber|violet|maple/);
    } finally { await box.cleanup(); }
  }, 120_000);

  it("fails a PNG with no text, and one with fewer than 10 alphanumerics, as ocr unavailable/empty", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "out/blank.png", blank());
      let r = await scan([box.repo, "--render-check"]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("file 1 png ocr unavailable/empty");
      await put(box.repo, "out/blank.png", png("Hi", 64));
      r = await scan([box.repo, "--render-check"]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("png ocr unavailable/empty");
      // A clean matching sibling does not rescue it.
      await put(box.repo, "out/blank.source.svg", "<svg><text>All clear here, plenty of ordinary words.</text></svg>");
      expect((await scan([box.repo, "--render-check"])).code).toBe(1);
    } finally { await box.cleanup(); }
  }, 120_000);

  it("fails when tesseract is missing or errors, even for a clean PNG with a clean sibling", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "out/x.png", png("Hello poster tokens estimate"));
      await put(box.repo, "out/x.source.svg", "<svg><text>Hello poster tokens estimate</text></svg>");
      for (const binary of [join(box.root, "no-such-tesseract"), "/bin/false"]) {
        const r = await scan([box.repo, "--render-check"], { EVERYTURN_TESSERACT: binary });
        expect(r.code).toBe(1);
        expect(r.text).toContain("png ocr unavailable/empty");
      }
      if (hasTesseract) expect((await scan([box.repo, "--render-check"])).code).toBe(0);
    } finally { await box.cleanup(); }
  }, 120_000);

  describe("OCR text variants (a stand-in tesseract prints a sidecar, so the cases are exact)", () => {
    const standIn = async (box: Awaited<ReturnType<typeof sandbox>>, ocr: string) => {
      const bin = join(box.root, "fake-tesseract.sh");
      await writeFile(bin, `#!/bin/sh\ncat "$1.ocr"\n`, { mode: 0o755 });
      await put(box.repo, "out/x.png", "png bytes are never read by the stand-in");
      await put(box.repo, "out/x.png.ocr", ocr);
      return scan([box.repo, "--render-check"], { EVERYTURN_TESSERACT: bin });
    };
    const clean = "Hello poster tokens estimate in the sources list.\n";
    it.each([
      ["as read: split after the prefix", () => j("gh", "p_ FAKEfakeFAKE fakeFAKE123456\n")],
      ["token broken across lines", () => j("gh", "p_\nFAKEfakeFAKEfake\nFAKE123456\n")],
      ["token after words on the same line", () => j("Source list ", "gh", "p_ FAKEfakeFAKE fakeFAKE123456 ends\n")],
      ["sk- key split in three", () => j("see sk", "- abcdefghij klmnopqrstuv wxyz\n")],
      ["github_pat split", () => j("github", "_pat_ 11ABCDEFG0abcdefghij klmnopqrstuvwxyz\n")],
      ["upper-case OCR of a lower-case token", () => j("GH", "P_ FAKEFAKEFAKE FAKEFAKE123456\n")],
    ])("fails: %s", async (_label, make) => {
      const box = await sandbox();
      try {
        const r = await standIn(box, clean + make());
        expect(r.code).toBe(1);
        expect(r.text).toMatch(/matches family .* \(rendered text\)/);
        expect(r.text).not.toMatch(/FAKE|fake|abcdefghij/i);
      } finally { await box.cleanup(); }
    });
    it("passes clean text, so the variants do not over-trigger", async () => {
      const box = await sandbox();
      try {
        const r = await standIn(box, clean + "SOURCE   SIZE, LARGEST FIRST   EST. TOKENS\nCLAUDE.md 195 70%\nSkill: release-notes 33 12%\nfrom 4 always-loaded sources, before you type anything\n#  Source  Agent  Scope  projec projec Bytes 778 415 209 178 149 tokens\n");
        expect(r).toMatchObject({ code: 0 });
      } finally { await box.cleanup(); }
    });
    it("fails fewer than 10 alphanumerics from the stand-in, and a stand-in that prints nothing", async () => {
      const box = await sandbox();
      try {
        expect((await standIn(box, "Hi there\n")).code).toBe(1);
        expect((await standIn(box, "")).text).toContain("png ocr unavailable/empty");
      } finally { await box.cleanup(); }
    });
  });
});
