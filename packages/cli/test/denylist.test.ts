import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index";
import { parseDenylist } from "../src/denylist";
import { put, sandbox } from "./helpers";

const exec = promisify(execFile);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function capture() {
  const out: string[] = [], err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.join(" ")); });
  return { out, err, all: () => [...out, ...err].join("\n") };
}
// Synthetic terms only.
const LEAK = [/acme[-_.\s]*notes/i, /zebracorp/i, /fake\.person@example\.org/i, /secret[-_.\s]*proj/i];
async function allOutput(dir: string) {
  const texts: string[] = [];
  for (const f of await readdir(dir)) if (!f.endsWith(".png")) texts.push(await readFile(join(dir, f), "utf8"));
  return texts.join("\n");
}
async function seed(repo: string) {
  await put(repo, "CLAUDE.md", "- Work on Acme Notes. Mail fake.person@example.org.\n");
  await put(repo, "apps/zebracorp-api/CLAUDE.md", "- Be brief.\n", );
  await put(repo, ".claude/skills/secret-proj-helper/SKILL.md", "---\nname: secret-proj-helper\ndescription: For zebracorp.\n---\n");
  await put(repo, ".mcp.json", JSON.stringify({ mcpServers: { "acme-notes-db": { command: "x" } } }));
}

describe("denylist CLI", () => {
  it("parses files: comments, blanks, CRLF and BOM", () => {
    expect(parseDenylist("﻿# private\r\n\r\nacme notes\r\n  zebracorp  \n#x\nfake.person@example.org")).toEqual(["acme notes", "zebracorp", "fake.person@example.org"]);
  });

  it("--deny (repeatable) and --denylist file redact every output and print only the count", async () => {
    const box = await sandbox();
    const log = capture();
    try {
      await seed(box.repo);
      const list = await put(box.root, "deny.txt", "# private\n\nacme notes\nzebracorp\n");
      const out = join(box.root, "o");
      const code = await run([box.repo, "--out", out, "--dataset", "real", "--deny", "fake.person@example.org", "--deny", "secret-proj", "--denylist", list], box);
      expect(code).toBe(0);
      expect(log.out).toContain("denylist: 4 terms");
      expect(log.err.join("\n")).not.toContain("without a denylist");
      for (const re of LEAK) expect(log.all()).not.toMatch(re);
      const files = await allOutput(out);
      for (const re of LEAK) expect(files).not.toMatch(re);
      expect(files).toContain("[redacted]");
      expect(await readFile(join(out, "everyturn.source.svg"), "utf8")).toContain('class="redacted"');
      expect(await readFile(join(out, "everyturn-sources.html"), "utf8")).toContain('aria-label="redacted"');
    } finally { await box.cleanup(); }
  });

  it("reads EVERYTURN_DENYLIST (a file path) and never prints its value or the terms", async () => {
    const box = await sandbox();
    const log = capture();
    try {
      await seed(box.repo);
      const list = await put(box.root, "private-list.txt", "zebracorp\nacme notes\n");
      vi.stubEnv("EVERYTURN_DENYLIST", list);
      const out = join(box.root, "o");
      expect(await run([box.repo, "--out", out], box)).toBe(0);
      expect(log.out).toContain("denylist: 2 terms");
      expect(log.all()).not.toContain("private-list");
      for (const re of LEAK.slice(0, 2)) expect(await allOutput(out)).not.toMatch(re); // only these two are listed
    } finally { await box.cleanup(); }
  });

  it("accepts the env path through the run option too", async () => {
    const box = await sandbox();
    const log = capture();
    try {
      await seed(box.repo);
      const list = await put(box.root, "d.txt", "zebracorp\n");
      expect(await run([box.repo, "--out", join(box.root, "o")], { ...box, denylistEnv: list })).toBe(0);
      expect(log.out).toContain("denylist: 1 term");
    } finally { await box.cleanup(); }
  });

  it("warns on stderr for --dataset real without a denylist, but does not fail", async () => {
    const box = await sandbox();
    const log = capture();
    try {
      await seed(box.repo);
      expect(await run([box.repo, "--out", join(box.root, "o"), "--dataset", "real"], box)).toBe(0);
      expect(log.err).toContain("warning: real dataset without a denylist; private names may appear");
      expect(log.out.join("\n")).not.toContain("denylist:");
      log.err.length = 0;
      // A real (non-fixture) repo gets the same warning by default; a loaded denylist silences it.
      expect(await run([box.repo, "--out", join(box.root, "o2")], box)).toBe(0);
      expect(log.err.join("\n")).toContain("without a denylist");
      log.err.length = 0;
      expect(await run([box.repo, "--out", join(box.root, "o3"), "--deny", "zebracorp"], box)).toBe(0);
      expect(log.err.join("\n")).not.toContain("without a denylist");
    } finally { await box.cleanup(); }
  });

  it("fails safely: short terms and unreadable files never echo the term or path", async () => {
    const box = await sandbox();
    const log = capture();
    try {
      await seed(box.repo);
      expect(await run([box.repo, "--out", join(box.root, "o"), "--deny", "zebracorp", "--deny", "qq"], box)).toBe(2);
      expect(log.err.join("\n")).toMatch(/term 2 is too short/);
      expect(log.all()).not.toContain("qq");
      expect(await run([box.repo, "--out", join(box.root, "o"), "--denylist", join(box.root, "missing-zebracorp.txt")], box)).toBe(2);
      expect(log.err.join("\n")).toContain("Cannot read denylist file");
      expect(log.all()).not.toContain("missing-zebracorp");
      expect(await run([box.repo, "--denylist"], box)).toBe(2);
      expect(await run([box.repo, "--denylist", "a", "--denylist", "b"], box)).toBe(2);
    } finally { await box.cleanup(); }
  });

  it("redacts denylisted names in the written-path line (--print-paths) and prints no directory by default", async () => {
    const box = await sandbox();
    const log = capture();
    try {
      await seed(box.repo);
      const out = join(box.root, "zebracorp-out");
      expect(await run([box.repo, "--out", out, "--deny", "zebracorp"], box)).toBe(0);
      expect(log.all()).not.toMatch(/zebracorp/i);
      expect(log.out).toContain("wrote <out>/everyturn.json");
      expect(await run([box.repo, "--out", out, "--deny", "zebracorp", "--overwrite", "--print-paths"], box)).toBe(0);
      expect(log.all()).not.toMatch(/zebracorp/i);
      expect(log.out.some((l) => l.startsWith("wrote ") && l.includes("[redacted]-out/everyturn.json"))).toBe(true);
    } finally { await box.cleanup(); }
  });
});

describe("privacy-scan denylist", () => {
  const scan = (args: string[], env: Record<string, string>) =>
    exec("node", ["scripts/privacy-scan.mjs", ...args], { env: { PATH: process.env.PATH ?? "", ...env } })
      .then((r) => ({ code: 0, text: r.stdout + r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, text: e.stdout + e.stderr }));

  it("passes without a denylist, fails on variants and reports only file index and family", async () => {
    const box = await sandbox();
    try {
      const clean = join(box.root, "clean");
      await put(clean, "a.txt", "hello");
      const dirty = join(box.root, "extra");
      await put(dirty, "Zebra-Corp-notes.md", "Acme_Notes was here");
      const list = await put(box.root, "deny.txt", "# c\nacme notes\nzebracorp\n");

      expect(await scan([clean, "--extra", dirty], {})).toMatchObject({ code: 0 });
      const bad = await scan([clean, "--extra", dirty], { EVERYTURN_DENYLIST: list });
      expect(bad.code).toBe(1);
      expect(bad.text).toContain("file 2 matches denylist family");
      expect(bad.text).not.toMatch(/acme|zebra|Corp|deny\.txt|extra/i);
      expect(await scan([clean], { EVERYTURN_DENYLIST: list })).toMatchObject({ code: 0 });
      const bogus = await scan([clean], { EVERYTURN_DENYLIST: join(box.root, "nope") });
      expect(bogus.code).toBe(2);
      expect(bogus.text).not.toContain("nope");
    } finally { await box.cleanup(); }
  });
});
