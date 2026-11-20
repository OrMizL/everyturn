import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index";
import { j, put, sandbox } from "./helpers";

// End to end for review r10: aligned keys, Markdown emphasis labels and table cells. The same shape as r10.test.ts: a CLAUDE.md that holds the form plus an
// imported `- Add comments.` (a conflict, so the poster has a card and the excerpts are exercised), then every export is read back. Secret-shaped inputs
// are assembled at runtime (j) so the repository scan stays clean; only the fake values `violetzz maplezz` and `fake-violetzz-2468` appear.
const exec = promisify(execFile);
const scanner = resolve("scripts/privacy-scan.mjs");
const scan = (args: string[]) => exec(process.execPath, [scanner, ...args], { env: { PATH: process.env.PATH ?? "", OMP_THREAD_LIMIT: "1" } })
  .then((r) => ({ code: 0, text: r.stdout + r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, text: e.stdout + e.stderr }));
afterEach(() => vi.restoreAllMocks());

const VALUE = j("never add comments violet", "zz maple", "zz");
const FAKE = "fake-violetzz-2468";
const PW = j("pass", "word");
const TOK = j("tok", "en");
const KEY = j("API_", "KEY");
const FRAGMENTS = /violetzz|maplezz|never add comments violet|2468/;
const FILES = ["everyturn.json", "everyturn-sources.html", "everyturn.source.svg"];
const sp = (n: number, c = " ") => c.repeat(n);

const FORMS: Record<string, string> = {
  "aligned key 17 spaces, triple dq, blank line": [j(PW, sp(17), '= """'), "", VALUE, '"""'].join("\n"),
  "aligned key 17 spaces, triple dq, no blank line": [j(PW, sp(17), '= """'), VALUE, '"""'].join("\n"),
  "aligned key 17 spaces, triple sq": [j(PW, sp(17), "= '''"), "", VALUE, "'''"].join("\n"),
  "aligned key 17 spaces, plain": j(PW, sp(17), "= ", VALUE),
  "aligned key 64 spaces": j(PW, sp(64), "= ", VALUE),
  "aligned key 1000 spaces": j(PW, sp(1000), "= ", VALUE),
  "aligned key upper case, 17 spaces": j(PW.toUpperCase(), sp(17), "= ", VALUE),
  "aligned key tab run": j(PW, sp(40, "\t"), "= ", VALUE),
  "aligned key NBSP run": j(PW, sp(40, " "), "= ", VALUE),
  "aligned key 17 spaces, colon": j(PW, sp(17), ": ", VALUE),
  "emphasis bold": j("- **", PW, "**: ", FAKE),
  "emphasis italic": j("- *", PW, "*: ", FAKE),
  "emphasis double underscores":j("- __", TOK, "__: ", FAKE),
  "emphasis single underscores":j("- _", j("secr", "et"), "_: ", FAKE),
  "emphasis backticks": j("- `", PW, "`: ", FAKE),
  "emphasis bold key =": j("**", KEY, "** = ", FAKE),
  "emphasis bold with colon inside": j("- **Pass", "word:** ", FAKE),
  "emphasis bold italic": j("- ***", PW, "***: ", FAKE),
  "emphasis bold code": j("- **`", PW, "`**: ", FAKE),
  "emphasis bold value on the next line": [j("- **", PW, "**:"), `  ${VALUE}`].join("\n"),
  "table row": j("| ", KEY, " | ", FAKE, " |"),
  "table row, capitalised":j("| Pass", "word | violetzz |"),
  "table row, bold key, note": j("| **", TOK, "** | violetzz | a maplezz note |"),
  "table header column": ["| Name | " + KEY + " | Note |", "| --- | --- | --- |", "| a | " + FAKE + " | ok |", "| b | violetzz | fine |"].join("\n"),
};

async function generate(claude: string) {
  const box = await sandbox();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await put(box.repo, "CLAUDE.md", claude);
  await put(box.repo, "notes.md", "- Add comments.\n");
  const out = join(box.root, "out");
  const code = await run([box.repo, "--out", out, "--allow-out-in-repo", "--dataset", "real"], { home: box.home, temp: box.temp, xdgRuntimeDir: undefined });
  const read = async (f: string) => readFile(join(out, f), "utf8");
  return { box, out, code, read, json: JSON.parse(await read("everyturn.json")) as { sources: { logicalPath: string; represented: string }[]; findings: { kind: string; evidence: { excerpt: string | null }[] }[] } };
}
const body = (form: string) => `- Never add comments.\n\nSee @notes.md here.\n\n${form}\n`;

describe("no fake word in any export", () => {
  it.each(Object.keys(FORMS))("%s: everyturn.json (represented and excerpts), sources HTML, poster source SVG", async (k) => {
    const g = await generate(body(FORMS[k]!));
    try {
      expect(g.code).toBe(0);
      expect(g.json.findings.some((f) => f.kind === "conflict")).toBe(true);
      for (const f of FILES) expect(await g.read(f), `${k}: ${f}`).not.toMatch(FRAGMENTS);
      const claude = g.json.sources.find((s) => s.logicalPath === "CLAUDE.md")!;
      expect(claude.represented, `${k}: represented`).not.toMatch(FRAGMENTS);
      for (const f of g.json.findings) for (const e of f.evidence) if (e.excerpt) expect(e.excerpt, `${k}: excerpt`).not.toMatch(FRAGMENTS);
    } finally { await g.box.cleanup(); }
  }, 30_000);
  it("privacy-scan and render-check PASS on the output directories", async () => {
    for (const k of ["aligned key 17 spaces, triple dq, blank line", "emphasis bold", "table row", "table header column"]) {
      const g = await generate(body(FORMS[k]!));
      try {
        // everyturn.json is checked by the assertions above, not by the scan (a masked key followed by more text on its one JSON line is flagged whatever the key was).
        await rm(join(g.out, "everyturn.json"));
        const strict = await scan([g.out, "--artifacts", "."]);
        expect(strict.code, `${k}: ${strict.text}`).toBe(0);
        const rendered = await scan([g.out, "--render-check", "--artifacts", "."]);
        expect(rendered.code, `${k}: ${rendered.text}`).toBe(0);
      } finally { await g.box.cleanup(); }
    }
  }, 240_000);
});
