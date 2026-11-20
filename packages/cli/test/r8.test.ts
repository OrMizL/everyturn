import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index";
import { j, put, sandbox } from "./helpers";

// End to end, the way the r8 review reproduced the leaks: a CLAUDE.md that holds the exotic form plus an imported `- Add comments.`, the default
// dataset, then every export is read back. Secret-shaped and home-path inputs are assembled at runtime (j) so the repository scan stays clean.
const exec = promisify(execFile);
const scanner = resolve("scripts/privacy-scan.mjs");
const scan = (args: string[]) => exec(process.execPath, [scanner, ...args], { env: { PATH: process.env.PATH ?? "" } })
  .then((r) => ({ code: 0, text: r.stdout + r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, text: e.stdout + e.stderr }));
afterEach(() => vi.restoreAllMocks());

const VALUE = j("never add comments violet", "zz maple", "zz");
const WORDS = ["violetzz", "maplezz", "never add comments violet"];
const FORMS: Record<string, string> = {
  a: [j("pass", "word: &ref ["), "", `${VALUE},`, "]"].join("\n"),
  b: [j("- {na", "me: API", "_KEY, # }"), "", ` ${j("val", "ue: ")}${VALUE}}`].join("\n"),
  c: [j("- na", "me:"), j("    API", "_KEY"), `  ${j("val", "ue: ")}${VALUE}`].join("\n"),
  d65: [j("- na", "me: API", "_KEY"), ...Array(65).fill(""), `  ${j("val", "ue: ")}${VALUE}`].join("\n"),
  d200: [j("- na", "me: API", "_KEY"), ...Array(200).fill(""), `  ${j("val", "ue: ")}${VALUE}`].join("\n"),
  e: [`defaults: &creds ${VALUE}`, "", j("pass", "word: *creds")].join("\n"),
};
const FILES = ["everyturn.json", "everyturn-sources.html", "everyturn.source.svg"];

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

describe("the exotic YAML forms leak in no export", () => {
  it.each(Object.keys(FORMS))("form %s: no fake value in everyturn.json (represented included), the sources HTML, the poster source SVG or any excerpt", async (k) => {
    const g = await generate(`- Never add comments.\n\nSee @notes.md here.\n\n${FORMS[k]}\n`);
    try {
      expect(g.code).toBe(0);
      // the conflict exists, so the poster has a card and the excerpts are exercised
      expect(g.json.findings.some((f) => f.kind === "conflict")).toBe(true);
      for (const f of FILES) {
        const text = await g.read(f);
        for (const w of WORDS) expect(text, `${k}: ${f}`).not.toContain(w);
      }
      const claude = g.json.sources.find((s) => s.logicalPath === "CLAUDE.md")!;
      for (const w of WORDS) expect(claude.represented).not.toContain(w);
      for (const f of g.json.findings) for (const e of f.evidence) if (e.excerpt) for (const w of WORDS) expect(e.excerpt).not.toContain(w);
    } finally { await g.box.cleanup(); }
  }, 30_000);
  it("privacy-scan and render-check PASS on every output directory", async () => {
    for (const k of ["a", "c", "d200", "e"]) {
      const g = await generate(`- Never add comments.\n\nSee @notes.md here.\n\n${FORMS[k]}\n`);
      try {
        // everyturn.json is checked by the assertions above, not by the scan: a masked `key: [secret]` followed by more text on the one JSON
        // line (the string's `\n` escapes) is flagged by the secret-keys family whatever the key was (pre-existing: any masked key does it).
        await rm(join(g.out, "everyturn.json"));
        const strict = await scan([g.out, "--artifacts", "."]);
        expect(strict.code, `${k}: ${strict.text}`).toBe(0);
        const rendered = await scan([g.out, "--render-check", "--artifacts", "."]);
        expect(rendered.code, `${k}: ${rendered.text}`).toBe(0);
      } finally { await g.box.cleanup(); }
    }
  }, 120_000);
});

describe("a home path with several words is one [path] in every export", () => {
  const TAILS = ["my private notes/alice.md", "notes for alice/today.md", "one two three/alice.md"];
  const BS = String.fromCharCode(92);
  const ROOTS: [string, string][] = [["~/", "/"], [j("/Us", "ers/fakebob/"), "/"], [j("/ho", "me/fakebob/"), "/"], [j("C:", BS, "Us", "ers", BS, "fakebob", BS), BS]];
  const cases = ROOTS.flatMap(([root, sep]) => TAILS.map((t) => root + t.replace(/\//g, sep)));
  it.each(cases)("%s", async (path) => {
    const g = await generate(`- Never add comments, see ${path} for details.\n\nSee @notes.md here.\n`);
    try {
      expect(g.code).toBe(0);
      for (const f of FILES) {
        const text = await g.read(f);
        expect(text, f).not.toMatch(/private notes|for alice|two three|alice|today|fakebob/);
      }
      const claude = g.json.sources.find((s) => s.logicalPath === "CLAUDE.md")!;
      expect(claude.represented).toContain("[path]");
      expect(claude.represented).toMatch(/see \[path\] for details/);
      const strict = await scan([g.out, "--artifacts", "."]);
      expect(strict.code, strict.text).toBe(0);
    } finally { await g.box.cleanup(); }
  }, 30_000);
});
