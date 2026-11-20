import { link, lstat, mkdir, readFile, readdir, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index";
import { put, sandbox } from "./helpers";

afterEach(() => vi.restoreAllMocks());
function capture() {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  return logs;
}
const uid = () => process.getuid!();

describe("output directory trust", () => {
  it("uses $XDG_RUNTIME_DIR/everyturn when that directory is ours, else <tmp>/everyturn-<uid>", async () => {
    const box = await sandbox();
    capture();
    try {
      await put(box.repo, "CLAUDE.md");
      const xdg = join(box.root, "xdg");
      await mkdir(xdg, { mode: 0o700 });
      expect(await run([box.repo], { ...box, xdgRuntimeDir: xdg })).toBe(0);
      const runs = await readdir(join(xdg, "everyturn"));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatch(/^run-/);
      expect((await lstat(join(xdg, "everyturn"))).mode & 0o777).toBe(0o700);
      expect(await readdir(box.temp)).toEqual([]);
      // Missing or relative XDG directories fall back to the per-uid temp parent.
      for (const bad of [join(box.root, "missing"), "relative/dir"]) {
        expect(await run([box.repo], { ...box, xdgRuntimeDir: bad })).toBe(0);
      }
      expect(await readdir(join(box.temp, `everyturn-${uid()}`))).toHaveLength(2);
    } finally { await box.cleanup(); }
  });

  it("refuses a parent that is a symlink, writing nothing through it", async () => {
    const box = await sandbox();
    const logs = capture();
    try {
      await put(box.repo, "CLAUDE.md");
      const target = join(box.root, "elsewhere");
      await mkdir(target, { mode: 0o700 });
      await symlink(target, join(box.temp, `everyturn-${uid()}`));
      expect(await run([box.repo], box)).toBe(2);
      expect(logs.join("\n")).toContain("not private");
      expect(await readdir(target)).toEqual([]);
    } finally { await box.cleanup(); }
  });

  it("refuses a parent that others can enter (mode & 0o077) and accepts a 0700 one", async () => {
    const box = await sandbox();
    capture();
    try {
      await put(box.repo, "CLAUDE.md");
      const parent = join(box.temp, `everyturn-${uid()}`);
      for (const mode of [0o755, 0o750, 0o701]) {
        await mkdir(parent, { mode: 0o700 }).catch(() => undefined);
        await chmod(parent, mode);
        expect(await run([box.repo], box), mode.toString(8)).toBe(2);
        expect(await readdir(parent)).toEqual([]);
      }
      await chmod(parent, 0o700);
      expect(await run([box.repo], box)).toBe(0);
    } finally { await box.cleanup(); }
  });

  it("refuses a default parent or explicit --out directory that the process does not own", async () => {
    const box = await sandbox();
    capture();
    try {
      await put(box.repo, "CLAUDE.md");
      const out = join(box.root, "out");
      await mkdir(out, { mode: 0o700 });
      vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(uid() + 1);
      expect(await run([box.repo, "--out", out], box)).toBe(2);
      expect(await readdir(out)).toEqual([]);
      expect(await run([box.repo], box)).toBe(2);
      vi.restoreAllMocks();
      capture();
      expect(await run([box.repo, "--out", out], box)).toBe(0);
    } finally { await box.cleanup(); }
  });

  it("refuses an explicit --out that is not a directory", async () => {
    const box = await sandbox();
    capture();
    try {
      const file = await put(box.root, "afile", "x");
      expect(await run([box.repo, "--out", file], box)).toBe(2);
      expect(await readFile(file, "utf8")).toBe("x");
    } finally { await box.cleanup(); }
  });

  it("never truncates a hard-linked output file, and writes nothing else when any output is linked", async () => {
    const box = await sandbox();
    capture();
    try {
      const out = join(box.root, "out");
      const victim = await put(box.root, "victim.txt", "precious");
      await mkdir(out, { mode: 0o700 });
      await link(victim, join(out, "everyturn.json"));
      expect(await run([box.repo, "--out", out, "--overwrite"], box)).toBe(2);
      expect(await readFile(victim, "utf8")).toBe("precious");
      expect(await readdir(out)).toEqual(["everyturn.json"]);
      // A link on a later output file is caught before the earlier ones are written.
      await mkdir(join(box.root, "out2"), { mode: 0o700 });
      await link(victim, join(box.root, "out2", "everyturn.html"));
      expect(await run([box.repo, "--out", join(box.root, "out2"), "--overwrite"], box)).toBe(2);
      expect(await readFile(victim, "utf8")).toBe("precious");
      expect(await readdir(join(box.root, "out2"))).toEqual(["everyturn.html"]);
    } finally { await box.cleanup(); }
  });

  it("overwrites regular single-link files only with --overwrite, keeping mode 0600", async () => {
    const box = await sandbox();
    capture();
    try {
      const out = join(box.root, "out");
      expect(await run([box.repo, "--out", out], box)).toBe(0);
      expect(await run([box.repo, "--out", out], box)).toBe(2);
      expect(await run([box.repo, "--out", out, "--overwrite"], box)).toBe(0);
      for (const f of await readdir(out)) {
        const info = await lstat(join(out, f));
        expect(info.mode & 0o777).toBe(0o600);
        expect(info.nlink).toBe(1);
      }
    } finally { await box.cleanup(); }
  });
});

describe("stdout does not print the output directory", () => {
  it("prints file names under <out> by default and the directory only with --print-paths", async () => {
    const box = await sandbox();
    const logs = capture();
    try {
      await put(box.repo, "CLAUDE.md");
      const out = join(box.root, "private-looking-dir");
      expect(await run([box.repo, "--out", out], box)).toBe(0);
      let text = logs.join("\n");
      expect(text).toContain("wrote <out>/everyturn.json");
      for (const leak of ["private-looking-dir", box.root, box.temp, "run-"]) expect(text).not.toContain(leak);
      logs.length = 0;
      expect(await run([box.repo, "--overwrite", "--out", out, "--print-paths"], box)).toBe(0);
      text = logs.join("\n");
      expect(text).toContain("private-looking-dir/everyturn.json");
      expect(text).not.toContain("wrote <out>");
      logs.length = 0;
      expect(await run([box.repo], box)).toBe(0);
      text = logs.join("\n");
      expect(text).not.toContain(box.temp);
      expect(text).not.toMatch(/[0-9a-f]{16}/);
    } finally { await box.cleanup(); }
  });
});

describe("--show-names (CLI)", () => {
  it("aliases MCP server names by default and shows them (redacted) with --show-names", async () => {
    const box = await sandbox();
    capture();
    try {
      await put(box.repo, ".mcp.json", JSON.stringify({ mcpServers: { "acme-payments-prod": { command: "x" }, docs: { url: "https://h.example/x" } } }));
      const a = join(box.root, "a"), b = join(box.root, "b");
      expect(await run([box.repo, "--out", a], box)).toBe(0);
      expect(await run([box.repo, "--out", b, "--show-names"], box)).toBe(0);
      const byDefault = await readFile(join(a, "everyturn.json"), "utf8");
      expect(byDefault).toContain("server-1 (stdio); server-2 (http)");
      expect(byDefault).not.toContain("acme-payments-prod");
      expect(await readFile(join(b, "everyturn.json"), "utf8")).toContain("acme-payments-prod (stdio)");
    } finally { await box.cleanup(); }
  });
});
