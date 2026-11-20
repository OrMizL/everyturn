import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES, SKILL_HEAD_BYTES } from "../src/discover";
import { run } from "../src/index";
import { j, put, sandbox } from "./helpers";

afterEach(() => vi.restoreAllMocks());
const quiet = () => { vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); };
const SKILL_HEAD = "---\nname: big-skill\ndescription: Draft release notes from merged PRs.\n---\n";
type Json = { sources: { logicalPath: string; represented: string; bytes: number; estTokens: number; rawBytes: number; activation: string }[]; warnings: string[] };
const readJson = async (out: string) => JSON.parse(await readFile(join(out, "everyturn.json"), "utf8")) as Json;

describe("a secret assignment masks to the end of the line, end to end through the CLI JSON", () => {
  it("DB pass, API key and GitHub token assignments whose second word looks like a command", async () => {
    const box = await sandbox();
    quiet();
    try {
      const lines = [j("DB_", "PA", "SS=sunny git rainbow 77"), j("API_", "KE", "Y=amber git violet"), j("GITHUB_", "TOK", "EN=amber go violet"), j("PGPASS", "WOR", "D=x psql -h db"), j("PGPASS", "WOR", "D=x git push")];
      await put(box.repo, "CLAUDE.md", `# Setup\n\n${lines.join("\n")}\n`);
      const out = join(box.root, "out");
      expect(await run([box.repo, "--out", out], box)).toBe(0);
      const text = await readFile(join(out, "everyturn.json"), "utf8");
      const rep = (await readJson(out)).sources[0]!.represented;
      expect(rep).toContain(j("DB_", "PA", "SS=[secret]\n"));
      expect(rep).toContain(j("API_", "KE", "Y=[secret]\n"));
      expect(rep).toContain(j("GITHUB_", "TOK", "EN=[secret]\n"));
      expect(rep).toContain(j("PGPASS", "WOR", "D=[secret] psql -h db\n"));
      expect(rep.endsWith(j("PGPASS", "WOR", "D=[secret]\n"))).toBe(true); // git is not a paired client
      for (const w of ["sunny", "rainbow", "violet", "amber", "git push", "go violet"]) expect(text).not.toContain(w);
    } finally { await box.cleanup(); }
  });
});

describe("an oversized SKILL.md still counts its listing", () => {
  it("a 300 KB body: same listing size as a short body, hero includes it, rawBytes keeps the file size", async () => {
    const box = await sandbox();
    quiet();
    try {
      const body = "# Big\n" + "- Never add comments.\n".repeat(15_000); // ~330 KB
      expect(body.length).toBeGreaterThan(MAX_FILE_BYTES);
      await put(box.repo, ".claude/skills/big/SKILL.md", SKILL_HEAD + body);
      await put(box.repo, ".claude/skills/small/SKILL.md", SKILL_HEAD.replace("big-skill", "small-skill") + "# Small\n");
      const out = join(box.root, "out");
      expect(await run([box.repo, "--out", out], box)).toBe(0);
      const report = await readJson(out);
      const big = report.sources.find((s) => s.logicalPath.includes("/big/"))!;
      const small = report.sources.find((s) => s.logicalPath.includes("/small/"))!;
      expect(big.represented).toBe("- big-skill: Draft release notes from merged PRs.");
      expect(small.represented).toBe("- small-skill: Draft release notes from merged PRs.");
      // exact listing sizes: 49 and 51 UTF-8 bytes -> 13 tokens each (bytes / 4, rounded up); the body never changes them
      expect([big.bytes, big.estTokens]).toEqual([49, 13]);
      expect([small.bytes, small.estTokens]).toEqual([51, 13]);
      expect(big.rawBytes).toBeGreaterThan(MAX_FILE_BYTES);
      expect(big.activation).toBe("always");
      expect(report.warnings.some((w) => w.includes("skipped"))).toBe(false);
      // the poster hero counts both listings (mutation-proof: dropping skills from the hero would change this number)
      const svg = await readFile(join(out, "everyturn.source.svg"), "utf8");
      const hero = Number(/>~(\d+)</.exec(svg)![1]);
      expect(hero).toBe(big.estTokens + small.estTokens);
      expect(svg).toContain("from 2 always-loaded sources");
    } finally { await box.cleanup(); }
  });
  it("a SKILL.md over the cap whose frontmatter does not close within the head is skipped with a warning", async () => {
    const box = await sandbox();
    quiet();
    try {
      await put(box.repo, ".claude/skills/open/SKILL.md", "---\nname: open-skill\ndescription: " + "x".repeat(SKILL_HEAD_BYTES + MAX_FILE_BYTES) + "\n---\nbody");
      const out = join(box.root, "out");
      expect(await run([box.repo, "--out", out], box)).toBe(0);
      const report = await readJson(out);
      expect(report.sources.find((s) => s.logicalPath.includes("/open/"))).toBeUndefined();
      expect(report.warnings.some((w) => w.includes(".claude/skills/open/SKILL.md") && w.includes("does not close"))).toBe(true);
    } finally { await box.cleanup(); }
  });
});

describe("a CLAUDE.md under .claude/skills is labelled 'not memory' on the poster", () => {
  it("the poster source says not memory, not nested", async () => {
    const box = await sandbox();
    quiet();
    try {
      await put(box.repo, "CLAUDE.md", "- Be kind.\n");
      await put(box.repo, ".claude/skills/x/CLAUDE.md", "- Example.\n");
      const out = join(box.root, "out");
      expect(await run([box.repo, "--out", out], box)).toBe(0);
      const svg = await readFile(join(out, "everyturn.source.svg"), "utf8");
      expect(svg).toContain("1 not memory · not in the total");
      expect(svg).not.toContain("1 nested");
    } finally { await box.cleanup(); }
  });
});
