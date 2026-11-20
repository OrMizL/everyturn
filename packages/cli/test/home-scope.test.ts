import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discover } from "../src/discover";
import { run } from "../src/index";
import { j, put } from "./helpers";

// Fake HOME: a directory named for a fake user, inside a `home` directory under the OS temp dir. The user name only ever appears in paths, never in file contents.
const NAME = "orfake";
afterEach(() => vi.restoreAllMocks());

async function world() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "et-home-")));
  const parent = join(root, "home");
  const home = join(parent, NAME);
  const files = [
    ".claude/CLAUDE.md", ".claude/settings.json", ".claude/rules/a.md", ".claude/skills/s1/SKILL.md", ".codex/AGENTS.md",
    j(".claude/projects/-ho", "me-orfake-dev-secretproj/CLAUDE.md"), ".codex/junk/AGENTS.md",
  ];
  for (const f of files) await put(home, f, f.endsWith("settings.json") ? JSON.stringify({ model: "opus" }) : f.includes("SKILL") ? "---\nname: s1\ndescription: demo\n---\n" : "- Be brief.\n");
  await put(home, "dev/proj/CLAUDE.md", "- Project rule.\n");
  await put(root, "other/CLAUDE.md", "- Not mine.\n");
  await mkdir(join(root, "temp"));
  return { root, parent, home, temp: join(root, "temp"), cleanup: () => rm(root, { recursive: true, force: true }) };
}
function capture() {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  return logs;
}
/** Every text artifact in an output directory (the PNG is binary). */
async function artifacts(dir: string) {
  let text = "";
  for (const f of await readdir(dir)) if (!f.endsWith(".png")) text += await readFile(join(dir, f), "utf8");
  return text;
}
async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(before); }
}

describe("folders above HOME do not read user config", () => {
  it("refuses HOME, its parent, the temp root and relative .. paths (exit 2), without the user name anywhere", async () => {
    const w = await world();
    const logs = capture();
    try {
      const env = { home: w.home, temp: w.temp, xdgRuntimeDir: undefined };
      for (const repo of [w.home, w.parent, w.root, dirname(w.root)]) {
        expect(await run([repo, "--out", join(w.root, "o")], env), repo === w.home ? "home" : "ancestor").toBe(2);
      }
      expect(await run(["--repo", w.parent], env)).toBe(2);
      // ".." from inside HOME is the parent of HOME; "../.." from deeper is HOME itself.
      expect(await inDir(w.home, () => run([".."], env))).toBe(2);
      expect(await inDir(join(w.home, "dev/proj"), () => run(["../.."], env))).toBe(2);
      expect(await inDir(join(w.home, ".claude"), () => run([".", "--out", join(w.root, "o")], env))).toBe(2);
      const text = logs.join("\n");
      expect(text).toContain("--include-user");
      expect(text).not.toContain(NAME);
      expect(text).not.toContain("secretproj");
      // Nothing was written anywhere.
      expect(await readdir(w.temp)).toEqual([]);
      expect(await readdir(w.root)).not.toContain("o");
    } finally { await w.cleanup(); }
  });

  it("refuses the filesystem root and the real account home's ancestors even with a fake home", async () => {
    const w = await world();
    try {
      for (const repo of ["/", dirname(userInfo().homedir), userInfo().homedir]) {
        await expect(discover({ repo, home: w.home })).rejects.toThrow("--include-user");
      }
    } finally { await w.cleanup(); }
  });

  it("with --include-user a folder above HOME yields only the allowlist, and the name never reaches any output", async () => {
    const w = await world();
    const logs = capture();
    try {
      for (const repo of [w.parent, w.root]) {
        const out = join(w.root, `out-${repo === w.parent ? "parent" : "root"}`);
        expect(await run([repo, "--out", out, "--include-user", "--allow-out-in-repo", "--dataset", "real"], { home: w.home, temp: w.temp, xdgRuntimeDir: undefined })).toBe(0);
        const report = JSON.parse(await readFile(join(out, "everyturn.json"), "utf8")) as { sources: { logicalPath: string; scope: string }[] };
        expect(report.sources.map((s) => s.logicalPath).sort()).toEqual(["~/.claude/CLAUDE.md", "~/.claude/[path]", "~/.claude/settings.json", "~/.claude/skills/s1/SKILL.md", "~/.codex/AGENTS.md"]);
        expect(report.sources.every((s) => s.scope === "user")).toBe(true);
        const everything = (await artifacts(out)) + logs.join("\n");
        expect(everything).not.toContain(NAME);
        expect(everything).not.toContain("secretproj");
        expect(everything).not.toContain("Not mine");
        expect(everything).not.toContain("Project rule");
      }
    } finally { await w.cleanup(); }
  });

  it("prunes a symlink to HOME (and to its protected roots) found in a repo, with or without --include-user", async () => {
    const w = await world();
    try {
      const repo = join(w.root, "proj");
      await put(repo, "CLAUDE.md", "- Mine.\n");
      await put(repo, "nested/deep/AGENTS.md", "- Deep.\n");
      await symlink(w.home, join(repo, "linkhome"));
      await symlink(join(w.home, ".claude"), join(repo, "linkclaude"));
      await symlink(w.parent, join(repo, "linkparent"));
      for (const includeUser of [false, true]) {
        const { sources, warnings } = await discover({ repo, home: w.home, includeUser });
        const mine = sources.filter((s) => s.scope !== "user").map((s) => s.logicalPath).sort();
        expect(mine).toEqual(["CLAUDE.md", "nested/deep/AGENTS.md"]);
        expect(JSON.stringify([sources, warnings])).not.toContain(NAME);
        expect(sources.filter((s) => s.scope === "user")).toHaveLength(includeUser ? 5 : 0);
      }
    } finally { await w.cleanup(); }
  });

  it("refuses a root that is HOME, above HOME or inside a config root by filesystem identity, not path", async () => {
    const w = await world();
    try {
      const ident = async (path: string) => { const i = await stat(path, { bigint: true }); return `${i.dev}:${i.ino}`; };
      // A bind mount is a different path with the same (st_dev, st_ino). `alias` makes the stand-in directory look like the target.
      const alias = (map: Record<string, string>) => async (path: string) => map[path] ?? ident(path).catch(() => null);
      const plain = async (name: string) => { await mkdir(join(w.root, name, "sub"), { recursive: true }); return join(w.root, name); };
      const homeBind = await plain("mnt-home");
      const parentBind = await plain("mnt-parent");
      const claudeBind = await plain("mnt-claude");
      const codexBind = await plain("mnt-codex");
      const agentsBind = await plain("mnt-agents");
      await mkdir(join(w.home, ".agents"), { recursive: true });
      const identity = alias({
        [homeBind]: await ident(w.home), [parentBind]: await ident(w.parent), [claudeBind]: await ident(join(w.home, ".claude")),
        [codexBind]: await ident(join(w.home, ".codex")), [agentsBind]: await ident(join(w.home, ".agents")),
      });
      for (const repo of [homeBind, parentBind, claudeBind, join(claudeBind, "sub"), codexBind, join(codexBind, "sub"), agentsBind, join(agentsBind, "sub")]) {
        await expect(discover({ repo, home: w.home, identity }), repo).rejects.toThrow("--include-user");
      }
      // With --include-user the stand-ins read only the allowlist; they are never walked.
      await put(homeBind, "CLAUDE.md", "- Not a project rule.\n");
      const { sources } = await discover({ repo: homeBind, home: w.home, includeUser: true, identity });
      expect(sources.every((s) => s.scope === "user")).toBe(true);
      expect(sources).toHaveLength(5);
      // Without the aliasing the same directories are ordinary project folders.
      expect((await discover({ repo: homeBind, home: w.home })).sources.map((s) => s.logicalPath)).toEqual(["CLAUDE.md"]);
    } finally { await w.cleanup(); }
  });

  it("prunes a walked directory whose identity is HOME or a config root, and checks each directory once", async () => {
    const w = await world();
    try {
      const ident = async (path: string) => { const i = await stat(path, { bigint: true }); return `${i.dev}:${i.ino}`; };
      const repo = join(w.root, "proj");
      await put(repo, "CLAUDE.md", "- Mine.\n");
      await put(repo, "packages/a/AGENTS.md", "- Also mine.\n");
      for (const name of ["shadow-home", "shadow-claude", "shadow-codex"]) await put(repo, `${name}/deep/CLAUDE.md`, "- Reached through an alias.\n");
      const map: Record<string, string> = {
        [join(repo, "shadow-home")]: await ident(w.home), [join(repo, "shadow-claude")]: await ident(join(w.home, ".claude")), [join(repo, "shadow-codex")]: await ident(join(w.home, ".codex")),
      };
      const calls: string[] = [];
      const identity = async (path: string) => { calls.push(path); return map[path] ?? ident(path).catch(() => null); };
      for (const includeUser of [false, true]) {
        calls.length = 0;
        const { sources } = await discover({ repo, home: w.home, includeUser, identity });
        expect(sources.filter((s) => s.scope !== "user").map((s) => s.logicalPath).sort()).toEqual(["CLAUDE.md", "packages/a/AGENTS.md"]);
        expect(sources.filter((s) => s.scope === "user")).toHaveLength(includeUser ? 5 : 0);
        expect(new Set(calls).size).toBe(calls.length); // cached: one identity lookup per path
        expect(calls).toContain(join(repo, "packages", "a"));
      }
    } finally { await w.cleanup(); }
  });

  it("refuses a root reached through a symlink alias of HOME's parent or HOME", async () => {
    const w = await world();
    try {
      await symlink(w.parent, join(w.root, "alias-parent"));
      await symlink(w.home, join(w.root, "alias-home"));
      await symlink(join(w.home, ".codex"), join(w.root, "alias-codex"));
      for (const name of ["alias-parent", "alias-home", "alias-codex"]) await expect(discover({ repo: join(w.root, name), home: w.home })).rejects.toThrow("--include-user");
      await expect(discover({ repo: join(w.root, "alias-codex", "junk"), home: w.home })).rejects.toThrow("--include-user");
    } finally { await w.cleanup(); }
  });

  it("scans a normal project under HOME and still skips nothing it should read", async () => {
    const w = await world();
    try {
      const { sources } = await discover({ repo: join(w.home, "dev/proj"), home: w.home });
      expect(sources.map((s) => s.logicalPath)).toEqual(["CLAUDE.md"]);
      await writeFile(join(w.home, "dev/proj/AGENTS.md"), "- Also.\n");
      expect((await discover({ repo: join(w.home, "dev"), home: w.home })).sources.map((s) => s.logicalPath).sort()).toEqual(["proj/AGENTS.md", "proj/CLAUDE.md"]);
    } finally { await w.cleanup(); }
  });
});
