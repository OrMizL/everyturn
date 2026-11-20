import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, readFile, readdir, realpath, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index";
import { j, put, sandbox } from "./helpers";

const exec = promisify(execFile);
afterEach(() => vi.restoreAllMocks());
function capture() {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
  return logs;
}

describe("safe CLI output", () => {
  it("defaults to a random run directory under a per-uid private parent, with private modes", async () => {
    const box = await sandbox();
    const logs = capture();
    try {
      await put(box.repo, "CLAUDE.md");
      const alias = join(box.root, "alias");
      await symlink(box.repo, alias);
      expect(await run(["--repo", alias, "--print-paths"], box)).toBe(0);
      const parent = join(box.temp, `everyturn-${process.getuid!()}`);
      expect((await lstat(parent)).mode & 0o777).toBe(0o700);
      const runs = await readdir(parent);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatch(/^run-[A-Za-z0-9]{6}$/);
      const hash = createHash("sha256").update(await realpath(box.repo)).digest("hex").slice(0, 16);
      expect(runs[0]).not.toContain(hash);
      const out = join(parent, runs[0]!);
      expect((await lstat(out)).mode & 0o777).toBe(0o700);
      for (const file of ["everyturn.json", "everyturn-sources.html"]) {
        expect((await lstat(join(out, file))).mode & 0o777).toBe(0o600);
        expect(logs.join("\n")).toContain(file);
      }
      // A second run gets a different directory (mkdtemp), never the same one.
      expect(await run(["--repo", alias], box)).toBe(0);
      expect(await readdir(parent)).toHaveLength(2);
      expect(await lstat(join(box.repo, "everyturn-out")).catch(() => null)).toBeNull();
      expect(logs.join("\n")).toContain("Inventory across all agents");
    } finally { await box.cleanup(); }
  });
  it("requires both in-repo opt-ins, detects parent symlinks, and refuses overwrite without its flag", async () => {
    const box = await sandbox();
    capture();
    try {
      await put(box.repo, "CLAUDE.md");
      const out = join(box.repo, "out", "demo");
      expect(await run([box.repo, "--out", out], box)).toBe(2);
      expect(await run([box.repo, "--allow-out-in-repo"], { ...box, temp: box.repo })).toBe(2);
      const alias = join(box.root, "alias");
      await symlink(box.repo, alias);
      expect(await run([box.repo, "--out", join(alias, "out/demo")], box)).toBe(2);
      const args = [box.repo, "--out", out, "--allow-out-in-repo"];
      expect(await run(args, box)).toBe(0);
      const path = join(out, "everyturn.json");
      await put(out, "everyturn.json", "marker");
      expect(await run(args, box)).toBe(2);
      expect(await readFile(path, "utf8")).toBe("marker");
      await chmod(out, 0o755);
      await chmod(path, 0o644);
      expect(await run([...args, "--overwrite"], box)).toBe(0);
      expect((await lstat(out)).mode & 0o777).toBe(0o700);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    } finally { await box.cleanup(); }
  });
  it("preflights both files and refuses output-file symlinks even with overwrite", async () => {
    const box = await sandbox();
    capture();
    try {
      const out = join(box.root, "output");
      await put(out, "everyturn-sources.html", "marker");
      expect(await run([box.repo, "--out", out], box)).toBe(2);
      expect(await lstat(join(out, "everyturn.json")).catch(() => null)).toBeNull();
      const target = await put(box.root, "target", "marker");
      await symlink(target, join(out, "everyturn.json"));
      expect(await run([box.repo, "--out", out, "--overwrite"], box)).toBe(2);
      expect(await readFile(target, "utf8")).toBe("marker");
    } finally { await box.cleanup(); }
  });
  it("keeps adversarial config values and private warning paths out of files and stdout", async () => {
    const box = await sandbox();
    const logs = capture();
    try {
      const values = Array.from({ length: 7 }, (_, i) => j("FAKE", String(i), "-confidential-value"));
      const host = j("mcp", ".acme", ".internal");
      const helper = j("/ho", "me/fakeuser/private/helper");
      await put(box.repo, ".mcp.json", JSON.stringify({ mcpServers: { safe: { env: { KEY: values[0] }, args: ["--token", values[1]], headers: { Authorization: j("Bear", "er ", values[2]!) }, url: j("https://", host) } } }));
      await put(box.repo, ".claude/settings.json", JSON.stringify({ env: { [j("ANTHROPIC_API_", "KEY")]: values[3], [j("GITHUB_", "TOKEN")]: values[4] }, [j("api", "KeyHelper")]: helper }));
      await put(box.home, ".claude/settings.json", JSON.stringify({ env: { [j("GITHUB_", "TOKEN")]: values[5] }, [j("api", "KeyHelper")]: values[6] }));
      await put(box.repo, j("-ho", "me-fakeuser-private/CLAUDE.md"), new Uint8Array([0xff]));
      const out = join(box.root, "output");
      expect(await run([box.repo, "--out", out, "--include-user"], box)).toBe(0);
      const outputs = logs.join("\n") + await readFile(join(out, "everyturn.json"), "utf8") + await readFile(join(out, "everyturn-sources.html"), "utf8");
      for (const value of [...values, host, helper, "fakeuser", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "--token"]) expect(outputs).not.toContain(value);
      expect(outputs).toContain("invalid UTF-8");
      expect(outputs).toContain("config summary");
    } finally { await box.cleanup(); }
  });
  it("returns exit code 2 for invalid roots and arguments", async () => {
    const box = await sandbox();
    const logs = capture();
    try {
      expect(await run([join(box.root, "missing")], box)).toBe(2);
      expect(logs.join("\n")).toContain("Cannot read repo root");
      expect(await run([box.repo, "--out"], box)).toBe(2);
      expect(await run([box.repo, "--unknown"], box)).toBe(2);
    } finally { await box.cleanup(); }
  });
});

describe("repository gates", () => {
  it("keeps fixture local settings eligible and provides an operator-only fresh clone gate", async () => {
    const ignore = await readFile(".gitignore", "utf8");
    expect(ignore.indexOf("!fixtures/demo-repo/.claude/settings.local.json")).toBeGreaterThan(ignore.indexOf("*.local.json"));
    expect(ignore).not.toContain("!fixtures/**");
    expect(JSON.parse(await readFile("fixtures/demo-repo/.claude/settings.local.json", "utf8"))).toHaveProperty("model");
    const script = await readFile("scripts/fresh-clone-check.sh", "utf8");
    expect(script).toContain("git clone --no-local .");
    expect(script).toContain("npm ci --ignore-scripts --prefer-offline");
    expect(script).toContain("npm run gate");
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.scripts.gate).not.toContain("demo");
    expect(pkg.scripts["gate:full"]).toBe("npm run gate && npm run demo && npm run web-shot && npm run web-accept && npm run privacy-scan && npm run render-check");
    // strict artifact rules are chosen explicitly, not by the name of the out/ folder
    expect(pkg.scripts["privacy-scan"]).toBe("node scripts/privacy-scan.mjs --artifacts out");
    expect(pkg.scripts["render-check"]).toBe("node scripts/privacy-scan.mjs --render-check --artifacts out");
    const screenshot = await readFile("scripts/screenshot.mjs", "utf8");
    for (const flag of ["--disable-background-networking", "--disable-component-update", "--no-first-run", "--no-sandbox"]) expect(screenshot).toContain(flag);
  });
  it("scans ignored/generated HTML, JSON and SVG and skips binaries and dependencies", async () => {
    const box = await sandbox();
    try {
      const scanner = resolve("scripts/privacy-scan.mjs");
      const leak = j("sk", "_live_", "abcdefghijklmnop1234");
      for (const path of ["node_modules/a.txt", ".git/a.txt", "poster.jpg"]) await put(box.repo, path, leak);
      await put(box.repo, "binary.bin", new Uint8Array([0, ...new TextEncoder().encode(leak)]));
      await put(box.repo, "safe.txt", j("demo", "@example.org ", "demo", "@example.com ", "demo", "@users.noreply.github.com"));
      await expect(exec(process.execPath, [scanner, box.repo])).resolves.toBeDefined();
      for (const extension of ["html", "json", "svg"]) await put(box.repo, `out/generated.${extension}`, leak);
      await expect(exec(process.execPath, [scanner, box.repo])).rejects.toMatchObject({ code: 1 });
    } finally { await box.cleanup(); }
  });
  it.each([
    () => j("/ho", "me/fakeuser/file"), () => j("/Us", "ers/fakeuser/file"), () => j("/ro", "ot/file"),
    () => j("C:", "\\\\Users", "\\\\fakeuser"), () => j("-ho", "me-fakeuser-dev-secretproj"),
    () => j("private", "@", "company.test"), () => j("sk", "-abcdefghijklmnop1234"),
    () => j("gh", "p_abcdefghijklmnopqrstuv12"), () => j("github", "_pat_abcdefghijklmnopqrstuv12"),
    () => j("xox", "b-abcdefghijklmnop"), () => j("AK", "IAABCDEFGHIJKLMNOP"),
    () => j("Bear", "er abcdefghijklmnop1234"), () => j("-----BEGIN ", "PRIVATE KEY-----"),
    () => j("aB3dE6gH9jK2mN5p", "Q8sT1vW4yZ7cF0iL"),
    () => j("/aB3dE6gH9jK2mN5p/", "Q8sT1vW4yZ7cF0iL"),
    () => j("service", ".acme", ".internal"),
    () => j("https://", "user:", "password", "@host/x"),
  ])("detects each required privacy family (%#)", async (make) => {
    const box = await sandbox();
    try {
      await put(box.repo, "out/canary.txt", make());
      const error = await exec(process.execPath, [resolve("scripts/privacy-scan.mjs"), box.repo]).catch((err: unknown) => err);
      expect(error).toMatchObject({ code: 1 });
      expect((error as { stderr: string }).stderr).not.toContain(make());
    } finally { await box.cleanup(); }
  });
});
