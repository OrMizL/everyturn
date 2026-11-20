// File list order, the oversized SKILL.md head read (equal to the CLI), and the post-render status/scroll constants.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SKILL_HEAD_BYTES as CORE_HEAD } from "@everyturn/core";
import { MAX_FILE_BYTES as CLI_FILE, SKILL_HEAD_BYTES as CLI_HEAD } from "../../../packages/cli/src/discover";
import { run } from "../../../packages/cli/src/index";
import { put, sandbox } from "../../../packages/cli/test/helpers";
import { HEAD_NOTE, MAX_FILE_BYTES, POSTER_SCROLL, STATUS, Workspace, analyze, reportJson } from "../src/app";
import type { Candidate } from "../src/app";
import { sampleCandidates } from "../src/sample";

afterEach(() => vi.restoreAllMocks());
const enc = new TextEncoder();
const candidate = (path: string, body: string | Uint8Array, direct = true): Candidate => {
  const bytes = typeof body === "string" ? enc.encode(body) : body;
  return { path, size: bytes.length, read: async (max) => (max === undefined ? bytes : bytes.subarray(0, max)), direct };
};
const order = (ws: Workspace) => ws.orderedRows().map((r) => r.path);

describe("file list order", () => {
  const files = [
    ".cursor/rules/a.mdc", "docs/notes.md", "CLAUDE.md", ".claude/settings.json", "AGENTS.md", "apps/x/CLAUDE.md", ".github/copilot-instructions.md",
    "CLAUDE.local.md", ".windsurfrules", ".claude/skills/s/SKILL.md", "logo.png",
  ];
  const body = (path: string) => (path.endsWith(".json") ? "{}" : path.endsWith("SKILL.md") ? "---\nname: s\ndescription: d\n---\n" : "- Always run tests.\n");
  // Every agent's instruction file at the repo root, alphabetical; the selected agent plays no part in the order. A file in a folder
  // (.github/copilot-instructions.md) is listed with the rest.
  const top = [".windsurfrules", "AGENTS.md", "CLAUDE.local.md", "CLAUDE.md"];

  it("puts the root instruction files of every agent first, alphabetically, then the rest by path", async () => {
    const ws = new Workspace();
    await ws.add(files.map((p) => candidate(p, body(p))));
    expect(order(ws)).toEqual([...top, ...files.filter((p) => !top.includes(p)).sort()]);
  });

  it("lists AGENTS.md in the root group for a Claude Code user (it is an instruction file whichever agent is selected)", async () => {
    const ws = new Workspace();
    await ws.add([candidate("docs/a.md", "x"), candidate("CLAUDE.md", "- a\n"), candidate("AGENTS.override.md", "- b\n"), candidate("AGENTS.md", "- c\n"), candidate("CLAUDE.local.md", "- d\n"), candidate(".claude/rules/r.md", "- e\n")]);
    expect(order(ws).slice(0, 4)).toEqual(["AGENTS.md", "AGENTS.override.md", "CLAUDE.local.md", "CLAUDE.md"]);
    expect(order(ws).slice(4)).toEqual([".claude/rules/r.md", "docs/a.md"]); // the skipped docs/a.md is in the second group
  });

  it("is the same for picked, dropped, pasted and reversed input", async () => {
    const picked = new Workspace(), dropped = new Workspace(), pasted = new Workspace();
    await picked.add(files.map((p) => candidate(p, body(p))));
    await dropped.add([...files].reverse().map((p) => candidate(p, body(p), false)));
    for (const p of [...files].reverse()) pasted.addText(p, body(p));
    const want = order(picked);
    expect(order(dropped)).toEqual(want.filter((p) => p !== "logo.png" && p !== "docs/notes.md"));
    expect(order(pasted)).toEqual(want);
    expect(want.slice(0, 3)).toEqual([".windsurfrules", "AGENTS.md", "CLAUDE.local.md"]);
  });

  it("does not move a nested, conditional or skipped file to the top", async () => {
    const ws = new Workspace();
    await ws.add([candidate("apps/x/AGENTS.md", "- a\n"), candidate(".cursor/rules/r.mdc", "---\nalwaysApply: false\n---\n- a\n"), candidate(".env", "x"), candidate("CLAUDE.md", "- a\n")]);
    expect(order(ws)).toEqual(["CLAUDE.md", ".cursor/rules/r.mdc", ".env", "apps/x/AGENTS.md"]);
  });

  it("orders the bundled sample with its root instruction files first, AGENTS.md included", async () => {
    const ws = new Workspace();
    await ws.add(sampleCandidates());
    const paths = order(ws);
    expect(paths.slice(0, 3)).toEqual(["AGENTS.md", "CLAUDE.local.md", "CLAUDE.md"]);
    expect(paths.slice(3)).toEqual(paths.slice(3).sort());
    expect(paths).toContain(".github/copilot-instructions.md");
  });
});

describe("oversized SKILL.md: the CLI's head read", () => {
  const FRONT = "---\nname: big-skill\ndescription: Draft release notes from merged PRs.\n---\n";
  const SKILL = ".claude/skills/big/SKILL.md";
  const big = FRONT + "# Big\n" + "- Never add comments.\n".repeat(15_000); // ~330 KB

  it("shares one head size with the CLI", () => {
    expect(CORE_HEAD).toBe(64 * 1024);
    expect(CLI_HEAD).toBe(CORE_HEAD);
    expect(HEAD_NOTE).toBe("read first 64 KiB");
  });

  it("keeps the row with a muted note, reads only the head, and counts the bytes read", async () => {
    const ws = new Workspace();
    const maxes: (number | undefined)[] = [];
    const c = candidate(SKILL, big);
    expect(c.size).toBeGreaterThan(MAX_FILE_BYTES);
    await ws.add([{ ...c, read: async (max) => { maxes.push(max); return c.read(max); } }]);
    expect(maxes).toEqual([CORE_HEAD]);
    expect(ws.rows).toEqual([{ path: SKILL, size: c.size, kind: "skill", note: HEAD_NOTE }]);
    expect(ws.usable).toBe(1);
    expect(ws.usableBytes).toBe(CORE_HEAD);
    expect(ws.skipped).toBe(0);
  });

  it("counts head bytes, not file size, against the 5 MiB budget", async () => {
    const ws = new Workspace();
    const skills = Array.from({ length: 40 }, (_, i) => candidate(`.claude/skills/s${String(i).padStart(2, "0")}/SKILL.md`, big));
    const result = await ws.add(skills); // 40 x ~330 KB = 13 MB of files, 40 x 64 KiB = 2.5 MiB read
    expect(result.overLimit).toBe(false);
    expect(ws.usable).toBe(40);
    expect(ws.usableBytes).toBe(40 * CORE_HEAD);
  });

  it("skips with 'frontmatter unreadable' (the CLI's warning) when the frontmatter does not close in the head", async () => {
    const open = "---\nname: open-skill\ndescription: " + "x".repeat(CORE_HEAD + MAX_FILE_BYTES) + "\n---\nbody";
    const ws = new Workspace();
    await ws.add([candidate(".claude/skills/open/SKILL.md", open)]);
    expect(ws.rows[0]).toMatchObject({ skip: "frontmatter unreadable", kind: "skill" });
    expect(ws.rows[0]?.note).toBeUndefined();
    expect(ws.usable).toBe(0);
    expect((await ws.prepare()).warnings).toEqual([`.claude/skills/open/SKILL.md: over ${CLI_FILE} bytes and its frontmatter does not close within the first ${CORE_HEAD} bytes, skipped`]);
  });

  it("a multi-byte character cut by the head limit does not make the file 'not UTF-8 text'", async () => {
    const pad = CORE_HEAD - FRONT.length - 1; // the 2-byte "é" starts on the last byte of the head
    const text = FRONT + "a".repeat(pad) + "é" + "b".repeat(MAX_FILE_BYTES);
    const ws = new Workspace();
    await ws.add([candidate(SKILL, text)]);
    expect(ws.rows[0]?.skip).toBeUndefined();
    expect(ws.usableBytes).toBe(CORE_HEAD);
  });

  it("a pasted oversized SKILL.md is read the same way", () => {
    const ws = new Workspace();
    expect(ws.addText(SKILL, big)).toEqual({ replaced: false, overLimit: false });
    expect(ws.rows[0]).toMatchObject({ size: enc.encode(big).length, note: HEAD_NOTE });
    expect(ws.usableBytes).toBe(CORE_HEAD);
  });

  it("still skips every other file over 256 KiB, SKILL.md outside the skill folders included", () => {
    const ws = new Workspace();
    ws.addText("docs/SKILL.md", "a".repeat(MAX_FILE_BYTES + 1));
    ws.addText(".cursor/rules/r.mdc", "a".repeat(MAX_FILE_BYTES + 1));
    expect(ws.rows.map((r) => r.skip)).toEqual(["not an instruction file", "over 256 KiB"]);
  });

  it("gives the CLI's listing size, estTokens, report JSON and poster source SVG", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const box = await sandbox();
    try {
      const files: [string, string][] = [
        ["CLAUDE.md", "- Always run tests.\n"], [SKILL, big],
        [".claude/skills/small/SKILL.md", FRONT.replace("big-skill", "small-skill") + "# Small\n"],
      ];
      for (const [path, text] of files) await put(box.repo, path, text);
      const out = join(box.temp, "cli-out");
      expect(await run([box.repo, "--agent", "claude-code", "--dataset", "real", "--out", out], box)).toBe(0);
      const cliJson = await readFile(join(out, "everyturn.json"), "utf8");
      const cliSvg = await readFile(join(out, "everyturn.source.svg"), "utf8");

      const ws = new Workspace();
      await ws.add(files.map(([path, text]) => candidate(path, text, false)));
      const prepared = await ws.prepare();
      const web = analyze({ files: prepared.files, imported: prepared.imported, warnings: prepared.warnings, agent: "claude-code", sample: false });
      expect(reportJson(web.report)).toBe(cliJson);
      expect(web.svg).toBe(cliSvg);
      const row = web.report.sources.find((s) => s.logicalPath === SKILL)!;
      expect([row.bytes, row.estTokens]).toEqual([49, 13]);
      expect(row.rawBytes).toBe(enc.encode(big).length);
    } finally { await box.cleanup(); }
  });

  it("gives the CLI's warning for a SKILL.md whose frontmatter does not close", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const box = await sandbox();
    try {
      const open = "---\nname: open-skill\ndescription: " + "x".repeat(CORE_HEAD + MAX_FILE_BYTES) + "\n---\nbody";
      const files: [string, string][] = [["CLAUDE.md", "- Always run tests.\n"], [".claude/skills/open/SKILL.md", open]];
      for (const [path, text] of files) await put(box.repo, path, text);
      const out = join(box.temp, "cli-out");
      expect(await run([box.repo, "--agent", "claude-code", "--dataset", "real", "--out", out], box)).toBe(0);
      const cliJson = await readFile(join(out, "everyturn.json"), "utf8");
      const ws = new Workspace();
      await ws.add(files.map(([path, text]) => candidate(path, text, false)));
      const prepared = await ws.prepare();
      const web = analyze({ files: prepared.files, warnings: prepared.warnings, agent: "claude-code", sample: false });
      expect(reportJson(web.report)).toBe(cliJson);
    } finally { await box.cleanup(); }
  });
});

describe("after a render the user asked for", () => {
  it("appends 'Poster ready.' to the spec's done line", () => {
    expect(STATUS.doneReady(13, 13)).toBe("Rendered 13 files. Poster ready.");
    expect(STATUS.doneReady(3, 5)).toBe("Rendered 3 of 5 files. 2 skipped. Poster ready.");
    expect(STATUS.doneReady(1, 1)).toBe("Rendered 1 file. Poster ready.");
    expect(STATUS.done(13, 13)).toBe("Rendered 13 files."); // a finding change re-draws in place and stays quiet
  });

  it("jumps to the heading instantly, never smoothly", () => {
    expect(POSTER_SCROLL).toEqual({ block: "start", behavior: "instant" });
  });
});
