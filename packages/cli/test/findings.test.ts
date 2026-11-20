import { readFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReport } from "@everyturn/core";
import { discover } from "../src/discover";
import { run } from "../src/index";
import { put, sandbox } from "./helpers";

afterEach(() => vi.restoreAllMocks());
const quiet = () => { vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); };
const scan = async (repo: string, options: Parameters<typeof discover>[0] extends infer O ? Partial<O> : never = {}) => {
  const d = await discover({ repo, home: resolve("fixtures/basic"), ...options });
  return { ...d, report: buildReport(d.sources, { warnings: d.warnings, dataset: "sample", includeUser: !!options.includeUser }) };
};

describe("fixtures", () => {
  it("the negative-control repo yields zero conflicts, and its import is resolved", async () => {
    const { report } = await scan("fixtures/negative-repo");
    expect(report.findings.filter((f) => f.kind === "conflict" || f.kind === "setting-conflict")).toEqual([]);
    expect(report.sources.find((s) => s.logicalPath === "docs/style.md")).toMatchObject({ kind: "claude-import", activation: "always" });
  });

  it("the demo repo: AGENTS.md joins the Claude profile by import, and the comments conflict is the headline", async () => {
    const { report } = await scan("fixtures/demo-repo");
    const agents = report.sources.find((s) => s.logicalPath === "AGENTS.md")!;
    expect(agents.importedBy).toHaveLength(1);
    expect(agents.claudeActivation).toBe("always");
    expect(report.totals.sources).toBe(13); // physical files, AGENTS.md counted once
    const conflicts = report.findings.filter((f) => f.kind === "conflict" && f.confidence !== "low" && f.agents.includes("claude-code"));
    const first = conflicts[0]!;
    expect(first.rule).toBe("curated:comments");
    expect(first.evidence.map((e) => [e.path, e.excerpt])).toEqual([
      ["CLAUDE.md", "Don't add comments to code; write self-explanatory names instead."],
      ["AGENTS.md", "Document as you go: add a comment above every non-obvious function."],
    ]);
    expect(first.applicability).toBe("Both load at repo root.");
    const dup = report.findings.find((f) => f.kind === "duplicate" && f.evidence[0]!.excerpt === "Always run `npm test` before committing.")!;
    expect(dup.agents).toEqual(["claude-code"]);
  });

  it("writes the demo poster with the comments conflict, the npm test duplicate and flags, and --findings off says not checked", async () => {
    quiet();
    const box = await sandbox();
    try {
      const out = join(box.root, "o");
      expect(await run(["fixtures/demo-repo", "--out", out], box)).toBe(0);
      const svg = await readFile(join(out, "everyturn.source.svg"), "utf8");
      expect(svg).toContain("SAMPLE SETUP");
      for (const needle of [">POSSIBLE CONFLICT<", ">DUPLICATE ×2<", ">4 possible conflicts · 1 duplicate<", ">from 5 always-loaded sources, before you type anything<", ">Also found, not counted: <", "1 nested · 3 config (settings, MCP) · not in the total", "1 of 4 shown", "self-explanatory names", "Document as you go", "Both load at repo root. No clear precedence"])
        expect(svg).toContain(needle);
      expect(svg).not.toContain("likely intentional override"); // the header no longer carries the override line
      expect(svg).not.toContain("POTENTIAL");
      expect(svg).toContain("CLAUDE.md:15");
      expect(svg).toContain("AGENTS.md:6");
      const json = JSON.parse(await readFile(join(out, "everyturn.json"), "utf8"));
      expect(json.schemaVersion).toBe("1.3.0");
      // the demo reads 4 conflicts; the opus -> sonnet settings.local.json override is listed with its own count.
      expect(json.findingCounts.headline).toEqual({ conflicts: 4, duplicates: 1, overrides: 1 });
      const off = join(box.root, "off");
      expect(await run(["fixtures/demo-repo", "--out", off, "--findings", "off"], box)).toBe(0);
      const offSvg = await readFile(join(off, "everyturn.source.svg"), "utf8");
      expect(offSvg).toContain("Not checked in this run (findings off).");
      expect(offSvg).toContain(">Conflicts and duplicates not checked<");
      expect(offSvg).not.toContain("POSSIBLE CONFLICT");
      expect(JSON.parse(await readFile(join(off, "everyturn.json"), "utf8")).findings).toEqual([]);
      expect(await run(["fixtures/demo-repo", "--out", join(box.root, "bad"), "--findings", "maybe"], box)).toBe(2);
    } finally { await box.cleanup(); }
  }, 60_000);
});

describe("@import discovery", () => {
  it("follows imports inside the repo only: no absolute paths, no escapes, no .env, no symlinked paths", async () => {
    quiet();
    const box = await sandbox();
    try {
      await put(box.root, "outside.md", "- Outside the repo.\n");
      await put(box.repo, ".env.md", "- Env.\n");
      await put(box.repo, "docs/ok.md", "- Fine.\n@deep/two.md\n");
      await put(box.repo, "docs/deep/two.md", "- Two.\n");
      await put(box.repo, "real/in.md", "- Linked.\n");
      await symlink(join(box.repo, "real"), join(box.repo, "link"));
      await symlink(join(box.root, "outside.md"), join(box.repo, "docs/sym.md"));
      await put(box.repo, "CLAUDE.md", ["@docs/ok.md", "@../outside.md", "@/etc/hosts.md", "@.env.md", "@link/in.md", "@docs/sym.md", "@missing.md", "`@docs/code.md`", ""].join("\n"));
      await put(box.repo, "docs/code.md", "- Code span only.\n");
      const { sources, warnings } = await scan(box.repo);
      expect(sources.map((s) => s.logicalPath).sort()).toEqual(["CLAUDE.md", "docs/deep/two.md", "docs/ok.md"]);
      expect(sources.filter((s) => s.viaImport).map((s) => s.logicalPath).sort()).toEqual(["docs/deep/two.md", "docs/ok.md"]);
      expect(warnings.filter((w) => w.includes("@import skipped"))).toHaveLength(3);
      expect(JSON.stringify(warnings)).not.toContain(box.root);
    } finally { await box.cleanup(); }
  });

  it("imports ~/.claude files only with --include-user", async () => {
    quiet();
    const box = await sandbox();
    try {
      await put(box.home, ".claude/shared/rules.md", "- Shared.\n");
      await put(box.repo, "CLAUDE.md", "@~/.claude/shared/rules.md\n");
      expect((await scan(box.repo, { home: box.home })).sources.map((s) => s.logicalPath)).toEqual(["CLAUDE.md"]);
      const withUser = await scan(box.repo, { home: box.home, includeUser: true });
      expect(withUser.sources.map((s) => s.logicalPath).sort()).toEqual(["CLAUDE.md", "~/.claude/shared/rules.md"]);
      // only fixed names keep their `~/.claude/...` path in the report; an import target shows as `~/.claude/[path]`
      expect(withUser.report.sources.find((s) => s.logicalPath === "~/.claude/[path]")).toMatchObject({ kind: "claude-import", scope: "user", activation: "always" });
    } finally { await box.cleanup(); }
  });

  it("a file already discovered (AGENTS.md) is read once and only gains an import occurrence", async () => {
    const box = await sandbox();
    try {
      await put(box.repo, "CLAUDE.md", "See @AGENTS.md\n");
      await put(box.repo, "AGENTS.md", "- Be brief.\n");
      const { sources, report } = await scan(box.repo);
      expect(sources.filter((s) => s.logicalPath === "AGENTS.md")).toHaveLength(1);
      expect(report.totals.sources).toBe(2);
      expect(report.sources.find((s) => s.logicalPath === "AGENTS.md")!.importedBy).toHaveLength(1);
    } finally { await box.cleanup(); }
  });
});
