// The frame label and caption, and a nameless SKILL.md behaving exactly as the CLI does.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES as CLI_FILE, SKILL_HEAD_BYTES as CLI_HEAD } from "../../../packages/cli/src/discover";
import { run } from "../../../packages/cli/src/index";
import { put, sandbox } from "../../../packages/cli/test/helpers";
import { FRAME_LABEL, HEAD_NOTE, NO_NAME, Workspace, analyze, frameCaption, frameLabel, reportJson } from "../src/app";
import type { Candidate } from "../src/app";
import { sampleCandidates } from "../src/sample";

afterEach(() => vi.restoreAllMocks());
const enc = new TextEncoder();
const candidate = (path: string, body: string, direct = true): Candidate => {
  const bytes = enc.encode(body);
  return { path, size: bytes.length, read: async (max) => (max === undefined ? bytes : bytes.subarray(0, max)), direct };
};
/** What main.ts keeps in state.input and state.analysis after a render. */
async function render(ws: Workspace) {
  const prepared = await ws.prepare();
  const sample = ws.sample;
  const analysis = analyze({ files: prepared.files, imported: prepared.imported, warnings: prepared.warnings, agent: "claude-code", sample });
  return { input: { files: prepared, sample }, analysis };
}
const caption = (r: Awaited<ReturnType<typeof render>>) => frameCaption(r.input.files.read, r.analysis.model.totals.inventorySources);

describe("frame label and caption", () => {
  it("the empty state and the pure sample read 'Sample · synthetic data'", async () => {
    expect(frameLabel(undefined)).toBe("Sample · synthetic data"); // nothing rendered: the dimmed sample
    const ws = new Workspace();
    await ws.add(sampleCandidates());
    const r = await render(ws);
    expect(frameLabel(r.input)).toBe(FRAME_LABEL.sample);
    expect(caption(r)).toBe("13 files read · 9 sources");
  });

  it("switches to 'Your files · redacted' for real files, mixed sample + pasted included, and back for the sample", async () => {
    const ws = new Workspace();
    ws.addText("CLAUDE.md", "- Always run tests.\n");
    const real = await render(ws);
    expect(frameLabel(real.input)).toBe("Your files · redacted");
    expect(caption(real)).toBe("1 file read · 1 source");

    ws.clear();
    await ws.add(sampleCandidates());
    ws.addText("docs/extra/CLAUDE.md", "- Be kind.\n");
    expect(ws.sample).toBe(false);
    expect(frameLabel((await render(ws)).input)).toBe(FRAME_LABEL.own);

    ws.clear();
    await ws.add(sampleCandidates());
    expect(frameLabel((await render(ws)).input)).toBe(FRAME_LABEL.sample);
  });

  it("counts files read (usable) and the sources the poster counts, with plurals", () => {
    expect(frameCaption(13, 9)).toBe("13 files read · 9 sources");
    expect(frameCaption(1, 1)).toBe("1 file read · 1 source");
    expect(frameCaption(1204, 0)).toBe("1,204 files read · 0 sources");
  });

  it("does not count a skipped file as read", async () => {
    const ws = new Workspace();
    ws.addText("CLAUDE.md", "- a\n");
    ws.addText(".env", "KEY=value");
    ws.addText(".claude/skills/x/SKILL.md", "---\ndescription: no name\n---\n");
    expect((await render(ws)).input.files.read).toBe(1);
  });
});

describe("a nameless SKILL.md follows the CLI", () => {
  const SKILL = ".claude/skills/n/SKILL.md";
  const cases: [string, string][] = [
    ["frontmatter with no name", "---\ndescription: Does a thing.\n---\nbody\n"],
    ["empty frontmatter", "---\n---\nbody\n"],
    ["a blank name", "---\nname:\ndescription: Does a thing.\n---\nbody\n"],
    ["no frontmatter at all", "# Just a heading\n\nbody\n"],
  ];

  for (const [name, text] of cases) {
    it(`skips ${name} with the row reason and the CLI's warning and report`, async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const box = await sandbox();
      try {
        const files: [string, string][] = [["CLAUDE.md", "- Always run tests.\n"], [SKILL, text], [".claude/skills/ok/SKILL.md", "---\nname: ok\ndescription: Fine.\n---\n"]];
        for (const [path, body] of files) await put(box.repo, path, body);
        const out = join(box.temp, "cli-out");
        expect(await run([box.repo, "--agent", "claude-code", "--dataset", "real", "--out", out], box)).toBe(0);
        const cliJson = JSON.parse(await readFile(join(out, "everyturn.json"), "utf8")) as { warnings: string[]; sources: { logicalPath: string }[] };
        expect(cliJson.warnings).toContain(`${SKILL}: SKILL.md without name frontmatter, skipped`);
        expect(cliJson.sources.some((s) => s.logicalPath === SKILL)).toBe(false);

        const ws = new Workspace();
        await ws.add(files.map(([path, body]) => candidate(path, body, false)));
        const row = ws.rows.find((r) => r.path === SKILL)!;
        expect(row.skip).toBe(NO_NAME);
        expect(NO_NAME).toBe("no name in front matter");
        expect(ws.usable).toBe(2);
        const prepared = await ws.prepare();
        const web = analyze({ files: prepared.files, imported: prepared.imported, warnings: prepared.warnings, agent: "claude-code", sample: false });
        expect(reportJson(web.report)).toBe(await readFile(join(out, "everyturn.json"), "utf8"));
        expect(prepared.read).toBe(2);
      } finally { await box.cleanup(); }
    });
  }

  it("applies to a pasted file and to an oversized one read to its head", async () => {
    const ws = new Workspace();
    ws.addText(SKILL, "---\ndescription: x\n---\n");
    expect(ws.rows[0]).toMatchObject({ skip: NO_NAME, kind: "skill" });
    const big = "---\ndescription: " + "x".repeat(10) + "\n---\n" + "- body\n".repeat(50_000);
    expect(enc.encode(big).length).toBeGreaterThan(CLI_FILE);
    await ws.add([candidate(".claude/skills/big/SKILL.md", big)]);
    expect(ws.rows.find((r) => r.path.includes("/big/"))).toMatchObject({ skip: NO_NAME });
    expect(ws.rows.find((r) => r.path.includes("/big/"))?.note).toBeUndefined();
    expect(HEAD_NOTE).toBe(`read first ${CLI_HEAD / 1024} KiB`);
  });

  it("removing the row or clearing drops the held file too", async () => {
    const ws = new Workspace();
    ws.addText(SKILL, "---\ndescription: x\n---\n");
    ws.addText("CLAUDE.md", "- a\n");
    expect((await ws.prepare()).files.map((f) => f.path)).toEqual([SKILL, "CLAUDE.md"]);
    ws.remove(SKILL);
    expect((await ws.prepare()).files.map((f) => f.path)).toEqual(["CLAUDE.md"]);
    ws.addText(SKILL, "---\ndescription: x\n---\n");
    ws.clear();
    expect((await ws.prepare()).files).toEqual([]);
  });

  it("a replaced nameless file is no longer held once the new one has a name", async () => {
    const ws = new Workspace();
    ws.addText(SKILL, "---\ndescription: x\n---\n");
    ws.addText(SKILL, "---\nname: n\ndescription: x\n---\n");
    expect(ws.rows[0]?.skip).toBeUndefined();
    expect((await ws.prepare()).files).toHaveLength(1);
  });
});
