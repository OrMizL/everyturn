import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index";
import { j, put, sandbox } from "./helpers";

// End to end for the r11 follow-ups: pipeless Markdown tables. The table is the only place the contradicting words appear, next to an imported
// `- Add comments.`, so a directive extracted from a table row would become a conflict on the poster. Secret-shaped inputs are assembled at runtime (j).
afterEach(() => vi.restoreAllMocks());

const VALUE = j("never add comments violet", "zz maple", "zz");
const PW = j("pass", "word");
const KEY = j("API_", "KEY");
const FRAGMENTS = /violetzz|maplezz|never add comments violet/;
const FILES = ["everyturn.json", "everyturn-sources.html", "everyturn.source.svg"];

const FORMS: Record<string, string> = {
  "review repro": [`name | ${PW}`, "--- | ---", `db | ${VALUE}`].join("\n"),
  "tight delimiter": [`name | ${PW}`, "---|---", `db | ${VALUE}`].join("\n"),
  "aligned delimiter": [`name | ${PW}`, ":--|--:", `db | ${VALUE}`].join("\n"),
  "key cell": ["Name | Value", "--- | ---", `${KEY} | ${VALUE}`].join("\n"),
  "piped form": [`| name | ${PW} |`, "|---|---|", `| db | ${VALUE} |`].join("\n"),
  "outer-pipe header, pipeless rows": [`| name | ${PW} |`, "|---|---|", `db | ${VALUE}`].join("\n"),
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
const body = (form: string) => `See @notes.md here.\n\n${form}\n`;

describe("pipeless tables reach no export", () => {
  it.each(Object.keys(FORMS))("%s: no fake word in JSON, sources HTML or poster SVG, and no conflict from the table", async (k) => {
    const g = await generate(body(FORMS[k]!));
    try {
      expect(g.code).toBe(0);
      expect(g.json.findings.filter((f) => f.kind === "conflict"), `${k}: conflicts`).toEqual([]);
      for (const f of FILES) expect(await g.read(f), `${k}: ${f}`).not.toMatch(FRAGMENTS);
      const claude = g.json.sources.find((s) => s.logicalPath === "CLAUDE.md")!;
      expect(claude.represented, `${k}: represented`).not.toMatch(FRAGMENTS);
      for (const f of g.json.findings) for (const e of f.evidence) if (e.excerpt) expect(e.excerpt, `${k}: excerpt`).not.toMatch(FRAGMENTS);
    } finally { await g.box.cleanup(); }
  }, 30_000);
});
