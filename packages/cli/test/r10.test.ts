import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index";
import { j, put, sandbox } from "./helpers";

// End to end, the way the r9 review reproduced the leaks: a CLAUDE.md that holds the form plus an imported `- Add comments.` (a conflict, so the
// poster has a card and the excerpts are exercised), the default dataset, then every export is read back. Secret-shaped and home-path inputs are
// assembled at runtime (j) so the repository scan stays clean.
const exec = promisify(execFile);
const scanner = resolve("scripts/privacy-scan.mjs");
// OMP_THREAD_LIMIT keeps tesseract to one thread, so these checks do not starve the OCR tests of other files that run beside them.
const scan = (args: string[]) => exec(process.execPath, [scanner, ...args], { env: { PATH: process.env.PATH ?? "", OMP_THREAD_LIMIT: "1" } })
  .then((r) => ({ code: 0, text: r.stdout + r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, text: e.stdout + e.stderr }));
afterEach(() => vi.restoreAllMocks());

const BS = String.fromCharCode(92);
const VALUE = j("never add comments violet", "zz maple", "zz");
const HOME = j("$HO", "ME");
const PW = j("pass", "word");
const FRAGMENTS = /violetzz|maplezz|never add comments violet|alicefake|alice|fakeapp|fakebob|two three|private notes/;
const FILES = ["everyturn.json", "everyturn-sources.html", "everyturn.source.svg"];
const blank = (n: number) => Array(n).fill("") as string[];

/** Whole CLAUDE.md bodies. Home roots: a rule that names a home path; then the value forms and spaced paths. */
const FORMS: Record<string, string> = {
  "home root $HOME": j("- Never add comments; notes live in ", HOME, "/fake alice/notes.md for details."),
  "home root ${HOME}": j("- Never add comments; notes live in ${HO", "ME}/fake alice/notes.md for details."),
  "home root quoted $HOME": j('- Never add comments; see "', HOME, '/.config/fakeapp/alice.json" for details.'),
  "home root $env:USERPROFILE": j("- Never add comments; see $env:USERPROFILE", BS, "alicefake", BS, "notes.md for details."),
  "home root %USERPROFILE%": j("- Never add comments; see %USERPROFILE%", BS, "alicefake", BS, "notes.md for details."),
  "home root %userprofile%": j("- Never add comments; see %userprofile%", BS, "alicefake", BS, "notes.md for details."),
  "home root %HOMEPATH%": j("- Never add comments; see %HOMEPATH%", BS, "alicefake", BS, "notes.md for details."),
  "home root %APPDATA%": j("- Never add comments; see %APPDATA%", BS, "alicefake", BS, "notes.md for details."),
  "home root %LOCALAPPDATA%": j("- Never add comments; see %LOCALAPPDATA%", BS, "alicefake", BS, "notes.md for details."),
  "triple quote triple dq, blank line": [j(PW, ' = """'), "", VALUE, '"""'].join("\n"),
  "triple quote triple sq, blank line": [j(PW, " = '''"), "", VALUE, "'''"].join("\n"),
  "triple quote triple dq, no blank line": [j(PW, ' = """'), VALUE, '"""'].join("\n"),
  "triple quote triple sq, no blank line": [j(PW, " = '''"), VALUE, "'''"].join("\n"),
  "yaml folded name": [j("- na", "me: >-"), j("    API", "_KEY"), `  ${j("val", "ue: ")}${VALUE}`].join("\n"),
  "yaml anchored name": [j("- na", "me: &n API", "_KEY"), `  ${j("val", "ue: ")}${VALUE}`].join("\n"),
  "yaml anchor defined before": [`defaults: &ref ${VALUE}`, "", j(PW, ":"), "  *ref"].join("\n"),
  "yaml anchor defined before, 70 blank lines": [`defaults: &ref ${VALUE}`, ...blank(70), j(PW, ":"), "  *ref"].join("\n"),
  "yaml anchor defined after": [j(PW, ":"), "  *ref", "", `defaults: &ref ${VALUE}`].join("\n"),
  "yaml anchored quote on the next line": [j(PW, ":"), '  &ref "', "", VALUE, '"'].join("\n"),
  "spaced path two spaces": j("- Never add comments, see ~/one  two three/violetzz.md for details."),
  "spaced path tab": j("- Never add comments, see ~/one\ttwo three/violetzz.md for details."),
  "spaced path posix": j("- Never add comments, see /ho", "me/fakebob/one  two three/violetzz.md for details."),
  "spaced path drive": j("- Never add comments, see C:", BS, "Us", "ers", BS, "fakebob", BS, "one  two three", BS, "violetzz.md for details."),
  "spaced path file://": j("- Never add comments, see file:///ho", "me/fakebob/one  two three/violetzz.md for details."),
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
const body = (form: string) => (form.startsWith("- Never") ? `${form}\n\nSee @notes.md here.\n` : `- Never add comments.\n\nSee @notes.md here.\n\n${form}\n`);

describe("no fake word or path fragment in any export", () => {
  it.each(Object.keys(FORMS))("%s: everyturn.json (represented and excerpts), sources HTML, poster source SVG", async (k) => {
    const g = await generate(body(FORMS[k]!));
    try {
      expect(g.code).toBe(0);
      // the conflict exists, so the poster has a card and the excerpts are exercised
      expect(g.json.findings.some((f) => f.kind === "conflict")).toBe(true);
      for (const f of FILES) expect(await g.read(f), `${k}: ${f}`).not.toMatch(FRAGMENTS);
      const claude = g.json.sources.find((s) => s.logicalPath === "CLAUDE.md")!;
      expect(claude.represented, `${k}: represented`).not.toMatch(FRAGMENTS);
      for (const f of g.json.findings) for (const e of f.evidence) if (e.excerpt) expect(e.excerpt, `${k}: excerpt`).not.toMatch(FRAGMENTS);
      if (k.startsWith("home root") || k.startsWith("spaced path")) expect(claude.represented).toMatch(/\[path\]"? for details/);
    } finally { await g.box.cleanup(); }
  }, 30_000);
  it("privacy-scan and render-check PASS on every output directory", async () => {
    for (const k of ["home root $HOME", "home root %USERPROFILE%", "triple quote triple dq, blank line", "yaml folded name", "yaml anchor defined after", "spaced path two spaces", "spaced path drive"]) {
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
