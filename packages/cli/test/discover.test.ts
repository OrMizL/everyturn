import { mkdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { discover, MAX_FILE_BYTES, MAX_RUN_BYTES } from "../src/discover";
import { j, put, sandbox } from "./helpers";

describe("discovery", () => {
  it("finds all 13 demo sources including local settings", async () => {
    const { sources } = await discover({ repo: "fixtures/demo-repo", home: resolve("fixtures/basic") });
    expect(sources.map((s) => s.logicalPath).sort()).toEqual([
      ".claude/settings.json", ".claude/settings.local.json", ".claude/skills/db-migrations/SKILL.md",
      ".claude/skills/release-notes/SKILL.md", ".cursor/rules/general.mdc", ".cursor/rules/typescript.mdc",
      ".github/copilot-instructions.md", ".mcp.json", "AGENTS.md", "CLAUDE.local.md", "CLAUDE.md",
      "apps/web/CLAUDE.md", "packages/api/AGENTS.md",
    ]);
    expect(sources.find((s) => s.logicalPath === "apps/web/CLAUDE.md")?.scope).toBe("nested");
  });
  it("uses exactly the user allowlist, including single-level rules and skills", async () => {
    const box = await sandbox();
    try {
      const allow = [".claude/CLAUDE.md", ".claude/settings.json", ".claude/rules/a.md", ".claude/skills/a/SKILL.md", ".codex/AGENTS.md", ".codex/AGENTS.override.md", ".codex/skills/a/SKILL.md", ".agents/skills/a/SKILL.md"];
      const junk = [j(".claude/projects/-ho", "me-fakeuser-dev-secretproj/CLAUDE.md"), ".claude/rules/deep/CLAUDE.md", ".claude/skills/deep/child/SKILL.md", ".codex/junk/AGENTS.md", ".claude/settings.local.json", "CLAUDE.md", ".agents/CLAUDE.md"];
      for (const path of [...allow, ...junk]) await put(box.home, path);
      for (const path of ["CLAUDE.md", ".env", "node_modules/a/AGENTS.md"]) await put(box.repo, path);
      const off = await discover({ repo: box.repo, home: box.home });
      expect(off.sources.map((s) => s.logicalPath)).toEqual(["CLAUDE.md"]);
      const on = await discover({ repo: box.repo, home: box.home, includeUser: true });
      expect(on.sources.filter((s) => s.scope === "user").map((s) => s.logicalPath).sort()).toEqual(allow.map((p) => `~/${p}`).sort());
      expect(JSON.stringify(on)).not.toContain("secretproj");
      expect(JSON.stringify(on)).not.toContain("fakeuser");
    } finally { await box.cleanup(); }
  });
  it("protects canonical home and all user-config subtrees, including root symlinks", async () => {
    const box = await sandbox();
    try {
      await put(box.home, ".claude/projects/private/CLAUDE.md");
      await put(box.home, ".claude/CLAUDE.md");
      await put(box.home, ".codex/AGENTS.md");
      await put(box.home, ".agents/skills/a/SKILL.md");
      const alias = join(box.root, "alias");
      await symlink(box.home, alias);
      for (const repo of [box.home, alias, join(box.home, ".claude"), join(box.home, ".claude/projects/private"), join(box.home, ".codex"), join(box.home, ".agents")]) {
        await expect(discover({ repo, home: box.home })).rejects.toThrow("--include-user");
        const on = await discover({ repo, home: box.home, includeUser: true });
        expect(on.sources).toHaveLength(3);
        expect(on.sources.every((s) => s.scope === "user" && s.logicalPath.startsWith("~/"))).toBe(true);
        expect(JSON.stringify(on.sources)).not.toContain("private");
      }
    } finally { await box.cleanup(); }
  });
  it("skips child symlinks, including allowlist directories and files", async () => {
    const box = await sandbox();
    try {
      const target = await put(box.root, "target/AGENTS.md");
      await symlink(target, join(box.repo, "AGENTS.md"));
      await symlink(join(box.root, "target"), join(box.repo, "linked"));
      await mkdir(join(box.home, ".codex"));
      await symlink(target, join(box.home, ".codex/AGENTS.md"));
      await symlink(join(box.root, "target"), join(box.home, ".claude"));
      expect((await discover({ repo: box.repo, home: box.home, includeUser: true })).sources).toEqual([]);
    } finally { await box.cleanup(); }
  });
  it("scopes hidden/nested directories correctly and walks in code-unit order", async () => {
    const box = await sandbox();
    try {
      const paths = ["a/CLAUDE.md", "Z/CLAUDE.md", ".hidden/CLAUDE.md", ".claude/.hidden/CLAUDE.md", "nested/.claude/rules/a.md", ".claude/rules/a.md", ".codex/skills/a/SKILL.md"];
      for (const path of paths) await put(box.repo, path);
      const { sources } = await discover({ repo: box.repo, home: box.home });
      expect(sources.map((s) => s.logicalPath)).toEqual([...paths].sort());
      for (const s of sources) expect(s.scope).toBe([".claude/rules/a.md", ".codex/skills/a/SKILL.md"].includes(s.logicalPath) ? "project" : "nested");
    } finally { await box.cleanup(); }
  });
  it("caps files at 256 KiB, skips binary/invalid UTF-8, and redacts sorted warnings", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "CLAUDE.md", "x".repeat(MAX_FILE_BYTES));
      await put(box.repo, "z/AGENTS.md", "x".repeat(MAX_FILE_BYTES + 1));
      await put(box.repo, "a/AGENTS.md", new Uint8Array([0xc3, 0x28]));
      await put(box.repo, "b/AGENTS.md", new Uint8Array([0, 1]));
      await put(box.repo, j("-ho", "me-fakeuser-private/AGENTS.md"), "x".repeat(MAX_FILE_BYTES + 1));
      const result = await discover({ repo: box.repo, home: box.home });
      expect(result.sources).toHaveLength(1);
      expect(result.warnings).toHaveLength(4);
      expect(result.warnings.join("\n")).toContain("invalid UTF-8");
      expect(result.warnings.join("\n")).not.toContain("fakeuser");
      expect(result.warnings).toEqual([...result.warnings].sort());
      expect(MAX_FILE_BYTES).toBe(256 * 1024);
    } finally { await box.cleanup(); }
  });
  it("stops the run at 5 MiB across project and user files", async () => {
    const box = await sandbox();
    try {
      for (let i = 0; i < 21; i++) await put(box.repo, `${String(i).padStart(2, "0")}/CLAUDE.md`, "x".repeat(MAX_FILE_BYTES));
      await put(box.home, ".claude/CLAUDE.md");
      const { sources, warnings } = await discover({ repo: box.repo, home: box.home, includeUser: true });
      expect(MAX_RUN_BYTES).toBe(5 * 1024 * 1024);
      expect(sources).toHaveLength(20);
      expect(warnings).toEqual([`Run limit ${MAX_RUN_BYTES} bytes reached; stopped discovery`]);
    } finally { await box.cleanup(); }
  });
  it("rejects missing roots and files as roots", async () => {
    const box = await sandbox();
    try {
      const file = await put(box.repo, "CLAUDE.md");
      for (const repo of [join(box.root, "missing"), file]) await expect(discover({ repo, home: box.home })).rejects.toThrow("Cannot read repo root");
    } finally { await box.cleanup(); }
  });
});
