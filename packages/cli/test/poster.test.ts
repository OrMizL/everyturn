import { cp, lstat, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fontFiles, run } from "../src/index";
import { j, put, sandbox } from "./helpers";

afterEach(() => vi.restoreAllMocks());
function capture() {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
  return logs;
}
const FILES = ["everyturn.json", "everyturn-sources.html", "everyturn.svg", "everyturn.source.svg", "everyturn.png", "everyturn.html"];

describe("poster outputs", () => {
  it("writes outlined svg, source svg, 1600x2000 png and html, privately", async () => {
    const box = await sandbox();
    const logs = capture();
    try {
      await put(box.repo, "CLAUDE.md", "- Always run tests.\n".repeat(20));
      await put(box.repo, "AGENTS.md", "- Be brief.\n".repeat(10));
      const out = join(box.root, "output");
      expect(await run([box.repo, "--out", out], box)).toBe(0);
      for (const f of FILES) {
        expect((await lstat(join(out, f))).mode & 0o777).toBe(0o600);
        expect(logs.join("\n")).toContain(f);
      }
      const outlined = await readFile(join(out, "everyturn.svg"), "utf8");
      expect(outlined.startsWith("<svg")).toBe(true);
      expect(outlined.match(/<text/g)).toBeNull();
      const source = await readFile(join(out, "everyturn.source.svg"), "utf8");
      expect(source).toContain("<text");
      expect(source).toContain("WHAT CLAUDE CODE IS TOLD EVERY TURN");
      // A sandbox repo is not the bundled fixture, so the default (auto) never says SAMPLE SETUP.
      expect(source).toContain("UNREVIEWED REAL SET");
      expect(source).not.toContain("SAMPLE SETUP");
      const png = await readFile(join(out, "everyturn.png"));
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1600, 2000]);
      const html = await readFile(join(out, "everyturn.html"), "utf8");
      expect(html).toContain("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
      expect(html).not.toContain("<script");
      expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
      // Repeats inside one file are not duplicates (distinct files only), so nothing is found here.
      expect(source).toContain("No possible conflicts or duplicates found by the heuristics.");
      expect(source).toContain(">No conflicts or duplicates found<");
      expect(source).not.toContain("POSSIBLE CONFLICT");
    } finally { await box.cleanup(); }
  }, 30_000);

  it("honors --agent and --dataset, with one profile per poster", async () => {
    const box = await sandbox();
    capture();
    try {
      await put(box.repo, "CLAUDE.md", "- Claude only rule.\n");
      await put(box.repo, "AGENTS.md", "- Codex only rule.\n".repeat(5));
      const out = join(box.root, "output");
      expect(await run([box.repo, "--out", out, "--agent", "codex", "--dataset", "real"], box)).toBe(0);
      const source = await readFile(join(out, "everyturn.source.svg"), "utf8");
      expect(source).toContain("WHAT CODEX IS TOLD EVERY TURN");
      expect(source).toContain("UNREVIEWED REAL SET");
      expect(source).toContain(">AGENTS.md<");
      expect(source).not.toContain(">CLAUDE.md<");
      expect(source).toContain("Codex profile · 1 source · ");
      expect(source).not.toContain("SAMPLE SETUP");
    } finally { await box.cleanup(); }
  }, 30_000);

  it("card says how many of the header line's conflicts it shows (line 5 vs card 1)", async () => {
    const fixture = fileURLToPath(new URL("../../../fixtures/demo-repo", import.meta.url));
    const box = await sandbox();
    capture();
    try {
      const out = join(box.root, "shown");
      expect(await run([fixture, "--out", out], box)).toBe(0);
      const source = await readFile(join(out, "everyturn.source.svg"), "utf8");
      const badge = /(\d+) possible conflicts?[ <]/.exec(source);
      expect(badge).not.toBeNull();
      expect(source).toContain(`1 of ${badge![1]} shown · `);
    } finally { await box.cleanup(); }
  }, 30_000);

  describe("dataset badge", () => {
    const fixture = fileURLToPath(new URL("../../../fixtures/demo-repo", import.meta.url));
    const badge = async (out: string) => {
      const source = await readFile(join(out, "everyturn.source.svg"), "utf8");
      return ["SAMPLE SETUP", "REDACTED REAL SET", "UNREVIEWED REAL SET"].filter((b) => source.includes(`>${b}<`));
    };

    it("defaults to auto: the bundled demo fixture is SAMPLE SETUP, a symlink to it too", async () => {
      const box = await sandbox();
      const logs = capture();
      try {
        const out = join(box.root, "o1");
        expect(await run([fixture, "--out", out], box)).toBe(0);
        expect(await badge(out)).toEqual(["SAMPLE SETUP"]);
        expect(logs.join("\n")).not.toContain("without a denylist");
        const link = join(box.root, "link-to-fixture");
        await symlink(fixture, link);
        const out2 = join(box.root, "o2");
        expect(await run([link, "--out", out2], box)).toBe(0);
        expect(await badge(out2)).toEqual(["SAMPLE SETUP"]);
        expect(await run([fixture, "--out", join(box.root, "o3"), "--dataset", "sample"], box)).toBe(0);
      } finally { await box.cleanup(); }
    }, 30_000);

    it("labels a real repo UNREVIEWED REAL SET with a warning, or REDACTED REAL SET when a denylist was loaded", async () => {
      const box = await sandbox();
      const logs = capture();
      try {
        await put(box.repo, "CLAUDE.md", "- Be brief.\n");
        const out = join(box.root, "o1");
        expect(await run([box.repo, "--out", out], box)).toBe(0);
        expect(await badge(out)).toEqual(["UNREVIEWED REAL SET"]);
        expect(logs.join("\n")).toContain("warning: real dataset without a denylist; private names may appear");
        logs.length = 0;
        const out2 = join(box.root, "o2");
        expect(await run([box.repo, "--out", out2, "--deny", "zebracorp"], box)).toBe(0);
        expect(await badge(out2)).toEqual(["REDACTED REAL SET"]);
        expect(logs.join("\n")).not.toContain("without a denylist");
        const out3 = join(box.root, "o3");
        expect(await run([box.repo, "--out", out3, "--dataset", "real", "--deny", "zebracorp"], box)).toBe(0);
        expect(await badge(out3)).toEqual(["REDACTED REAL SET"]);
      } finally { await box.cleanup(); }
    }, 30_000);

    it("refuses --dataset sample on a root that is not a bundled fixture (exit 2) and writes nothing", async () => {
      const box = await sandbox();
      const logs = capture();
      try {
        await put(box.repo, "CLAUDE.md", "- Be brief.\n");
        const copy = join(box.root, "copy-of-fixture");
        await cp(fixture, copy, { recursive: true });
        for (const root of [box.repo, copy]) {
          const out = join(box.root, "refused");
          expect(await run([root, "--out", out, "--dataset", "sample"], box)).toBe(2);
          expect(await lstat(out).catch(() => null)).toBeNull();
        }
        expect(logs.join("\n")).toContain("--dataset sample is only for the bundled sample fixtures");
        // The same copy under auto is simply a real set.
        const out = join(box.root, "auto");
        expect(await run([copy, "--out", out], box)).toBe(0);
        expect(await badge(out)).toEqual(["UNREVIEWED REAL SET"]);
      } finally { await box.cleanup(); }
    }, 30_000);
  });

  it("rejects bad --agent/--dataset values and refuses to overwrite poster files without the flag", async () => {
    const box = await sandbox();
    const logs = capture();
    try {
      await put(box.repo, "CLAUDE.md");
      const out = join(box.root, "output");
      expect(await run([box.repo, "--out", out, "--agent", "gemini"], box)).toBe(2);
      expect(await run([box.repo, "--out", out, "--dataset", "toString"], box)).toBe(2);
      expect(await run([box.repo, "--out", out, "--agent"], box)).toBe(2);
      expect(logs.join("\n")).toContain("--agent must be one of");
      await put(out, "everyturn.png", "marker");
      expect(await run([box.repo, "--out", out], box)).toBe(2);
      expect(await readFile(join(out, "everyturn.png"), "utf8")).toBe("marker");
      expect(await lstat(join(out, "everyturn.json")).catch(() => null)).toBeNull();
    } finally { await box.cleanup(); }
  }, 30_000);

  it("keeps canaries out of every poster artifact", async () => {
    const box = await sandbox();
    const logs = capture();
    try {
      const ghCanary = j("gh", "p_abcdefghijklmnopqrstuv12");
      const email = j("private", "@", "company.test");
      await put(box.repo, ".claude/skills/leak/SKILL.md", `---\nname: leak ${email}\ndescription: ${ghCanary}\n---\n`);
      const out = join(box.root, "output");
      expect(await run([box.repo, "--out", out], box)).toBe(0);
      for (const f of ["everyturn.svg", "everyturn.source.svg", "everyturn.html"]) {
        const text = await readFile(join(out, f), "utf8");
        for (const c of [ghCanary, email, box.repo]) expect(text).not.toContain(c);
      }
      expect(logs.join("\n")).not.toContain(ghCanary);
    } finally { await box.cleanup(); }
  }, 30_000);

  it("resolves the six bundled fonts inside the core package", async () => {
    expect(fontFiles).toHaveLength(6);
    for (const f of fontFiles) {
      expect(f).toMatch(/packages[\\/]core[\\/]assets[\\/]fonts[\\/](inter|jetbrains-mono)[\\/].+\.ttf$/);
      expect((await lstat(f)).isFile()).toBe(true);
    }
  });
});
