import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES, SKILL_HEAD_BYTES } from "../src/discover";
import { run } from "../src/index";
import { j, put, sandbox } from "./helpers";

afterEach(() => vi.restoreAllMocks());
const quiet = () => { vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); };
type Json = { sources: { logicalPath: string; represented: string; bytes: number; estTokens: number; rawBytes: number; activation: string }[]; warnings: string[] };
const readJson = async (out: string) => JSON.parse(await readFile(join(out, "everyturn.json"), "utf8")) as Json;
const BODY = "# Big\n" + "- Never add comments.\n".repeat(15_000); // over MAX_FILE_BYTES

describe("the 64 KiB skill head needs a real closing fence", () => {
  /** Scan a repo holding one oversized skill whose head is `head`; returns [listed?, warning about the fence?]. */
  async function scanSkill(head: string): Promise<[boolean, boolean]> {
    const box = await sandbox();
    quiet();
    try {
      expect(BODY.length).toBeGreaterThan(MAX_FILE_BYTES);
      await put(box.repo, ".claude/skills/big/SKILL.md", head + BODY);
      const out = join(box.root, "out");
      expect(await run([box.repo, "--out", out], box)).toBe(0);
      const report = await readJson(out);
      return [report.sources.some((s) => s.logicalPath.includes("/big/")), report.warnings.some((w) => w.includes("does not close"))];
    } finally { await box.cleanup(); }
  }
  const TOP = "---\nname: big-skill\ndescription: Draft release notes.\n";
  it("a line that merely starts with --- is not a closing fence (skipped with a warning)", async () => {
    expect(await scanSkill(TOP + "---NOT-A-FENCE\n")).toEqual([false, true]);
    expect(await scanSkill(TOP + "--- not a fence\n")).toEqual([false, true]);
    expect(await scanSkill(TOP + "----\n")).toEqual([false, true]);
    expect(await scanSkill(TOP + " ---\n")).toEqual([false, true]);
  });
  it("--- alone on its line closes it: LF, CRLF, trailing spaces, and the `...` form", async () => {
    expect(await scanSkill(TOP + "---\n")).toEqual([true, false]);
    expect(await scanSkill(TOP + "---   \n")).toEqual([true, false]);
    expect(await scanSkill((TOP + "---\n").replace(/\n/g, "\r\n"))).toEqual([true, false]);
    expect(await scanSkill(TOP + "...\n")).toEqual([true, false]);
  });
  it("an empty frontmatter and one whose fence is the very last line of the head", async () => {
    expect(await scanSkill("---\n---\n")).toEqual([false, false]); // closes (no warning), but has no name, so there is no listing
    const box = await sandbox();
    quiet();
    try {
      // the head is cut at 64 KiB. A fence that ends EXACTLY at the cut (`\n---`, no newline inside the head) may be the start of
      // `---not-a-fence` in the full file, so it does not count; one followed by its newline inside the head does.
      const head = (extra: number) => j("---\nname: big-skill\ndescription: ", "x".repeat(SKILL_HEAD_BYTES - j("---\nname: big-skill\ndescription: ", "\n---").length - extra), "\n---");
      const warns = async (text: string) => {
        await put(box.repo, ".claude/skills/big/SKILL.md", text);
        const out = join(box.root, `out-${text.length}`);
        expect(await run([box.repo, "--out", out], box)).toBe(0);
        return (await readJson(out)).warnings.some((w) => w.includes("does not close"));
      };
      expect(await warns(head(0) + "-NOT-A-FENCE\n" + BODY)).toBe(true); // fence-looking text cut at the head boundary, not a fence in the full file
      expect(await warns(head(0) + "\n" + BODY)).toBe(true); // a real fence whose newline lies beyond the head: not closed within the head
      expect(await warns(head(1) + "\n" + BODY)).toBe(false); // the newline is the last byte of the head
    } finally { await box.cleanup(); }
  });
});
