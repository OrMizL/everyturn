import { cp, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPosterModel, buildReport, posterFindings, renderPosterSvg } from "@everyturn/core";
import { discover } from "../src/discover";
import { run } from "../src/index";
import { put, sandbox } from "./helpers";

afterEach(() => vi.restoreAllMocks());
const quiet = () => { vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); };
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
const texts = (svg: string) => [...svg.matchAll(/<text [^>]*>(.*?)<\/text>/g)].map((m) => decode(m[1]!.replace(/<[^>]+>/g, "")));
const scan = async (repo: string, home: string, dataset: "sample" | "real" = "real") => {
  const d = await discover({ repo, home });
  return { ...d, report: buildReport(d.sources, { warnings: d.warnings, dataset }) };
};

describe("hero activation edges, end to end through discovery", () => {
  const SKILL = (name: string, extra = "") => `---\nname: ${name}\ndescription: demo skill\n${extra}---\nBody.\n`;
  async function repoWithEdges() {
    const box = await sandbox();
    const files: [string, string][] = [
      ["CLAUDE.md", "- Be kind.\n"],
      [".claude/skills/ex/CLAUDE.md", "- Example memory, not the project memory.\n"],
      [".claude/skills/ex/SKILL.md", SKILL("ex")],
      [".claude/skills/manual/SKILL.md", SKILL("manual", "disable-model-invocation: true # user only\n")],
      [".claude/rules/a.md", "---\n# scoped\npaths:\n  # web only\n  - \"web/**\"\n---\n- Rule A.\n"],
      [".claude/rules/b.md", "---\n\"paths\": [\"web/**\"]\n---\n- Rule B.\n"],
      [".claude/rules/c.md", "---\ndescription: c\n---\n- Rule C.\n"],
      ["AGENTS.md", "- Root agents file.\n"], ["AGENTS.override.md", "- Override file.\n"], [".codex/AGENTS.md", "- Not a project file Codex loads.\n"],
      [".cursor/rules/g.mdc", "---\nalwaysApply: true # global\n---\n- Global rule.\n"],
      [".cursor/rules/s.mdc", "---\nglobs: \"*.ts\"\nalwaysApply: false\n---\n- Scoped rule.\n"],
    ];
    for (const [path, text] of files) await put(box.repo, path, text);
    return box;
  }
  it("counts what each agent really loads, and lists the rest", async () => {
    const box = await repoWithEdges();
    try {
      const { report } = await scan(box.repo, box.home);
      const act = (p: string) => report.sources.find((s) => s.logicalPath === p)!.activation;
      expect(act("CLAUDE.md")).toBe("always");
      expect(act(".claude/skills/ex/CLAUDE.md")).toBe("nested");
      expect(report.sources.find((s) => s.logicalPath === ".claude/skills/ex/CLAUDE.md")!.scope).toBe("nested");
      expect(act(".claude/skills/ex/SKILL.md")).toBe("always");
      expect(act(".claude/skills/manual/SKILL.md")).toBe("inactive");
      expect(act(".claude/rules/a.md")).toBe("conditional"); // paths: with a comment line
      expect(act(".claude/rules/b.md")).toBe("conditional"); // quoted "paths" key
      expect(act(".claude/rules/c.md")).toBe("always");
      expect(act("AGENTS.md")).toBe("inactive"); // shadowed by AGENTS.override.md
      expect(act("AGENTS.override.md")).toBe("always");
      expect(act(".codex/AGENTS.md")).toBe("inactive");
      expect(act(".cursor/rules/g.mdc")).toBe("always"); // alwaysApply: true # global
      expect(act(".cursor/rules/s.mdc")).toBe("conditional");

      const claude = buildPosterModel(report, { agent: "claude-code" });
      expect(claude.totals).toMatchObject({ sources: 3, listed: 4 }); // not "from 6 always-loaded"
      expect(claude.rows.filter((r) => r.counted).map((r) => r.label).sort()).toEqual(["CLAUDE.md", "Claude rule", "Skill: ex"]);
      const codex = buildPosterModel(report, { agent: "codex" });
      expect(codex.totals).toMatchObject({ sources: 1, listed: 2 });
      expect(buildPosterModel(report, { agent: "cursor" }).totals).toMatchObject({ sources: 1, listed: 1 });
      const svg = texts(renderPosterSvg(codex));
      expect(svg).toContain("from 1 always-loaded source, before you type anything");
      expect(svg).toContain("Also found, not counted: 2");
      expect(svg).toContain("2 not auto-loaded · not in the total");
    } finally { await box.cleanup(); }
  });
});

describe("the flagship negative repo with settings, end to end", () => {
  it("zero conflicts from discovery through the report, findings, JSON and the poster SVG", async () => {
    quiet();
    const box = await sandbox();
    try {
      // Generated at test time: fixtures cannot hold .claude/settings.local.json (ignored by the repo's rules).
      await cp(resolve("fixtures/negative-repo"), box.repo, { recursive: true });
      const hooks = (cmd: string) => ({ Stop: [{ hooks: [{ type: "command", command: cmd }] }] });
      await put(box.repo, ".claude/settings.json", JSON.stringify({ model: "sonnet", permissions: { allow: ["Bash(npm test:*)"], deny: ["Bash(rm -rf:*)"] }, hooks: hooks("echo one"), env: { FOO: "1" } }, null, 2));
      await put(box.repo, ".claude/settings.local.json", JSON.stringify({ model: "sonnet", permissions: { allow: ["Bash(npm run lint:*)"], deny: ["Read(./secrets/**)"] }, hooks: hooks("echo two"), env: { BAR: "2" } }, null, 2));
      await put(box.repo, ".mcp.json", JSON.stringify({ mcpServers: { docs: { command: "npx" } } }));
      const out = join(box.root, "o");
      expect(await run([box.repo, "--out", out], box)).toBe(0);
      const json = JSON.parse(await readFile(join(out, "everyturn.json"), "utf8"));
      const kinds = json.sources.map((s: { kind: string }) => s.kind);
      expect(kinds.filter((k: string) => k === "settings")).toHaveLength(2);
      expect(kinds).toContain("mcp");
      expect(json.findings.filter((f: { kind: string }) => f.kind === "conflict" || f.kind === "setting-conflict")).toEqual([]);
      expect(json.findingCounts).toMatchObject({ conflicts: 0, settingConflicts: 0, headline: { conflicts: 0, overrides: 0 } });
      const svg = texts(await readFile(join(out, "everyturn.source.svg"), "utf8"));
      expect(svg.some((t) => /POSSIBLE CONFLICT|SETTING CONFLICT|intentional override/.test(t))).toBe(false);
      expect(svg).toContain("No conflicts or duplicates found");
      expect(svg).toContain("No possible conflicts or duplicates found by the heuristics.");
      const html = await readFile(join(out, "everyturn-sources.html"), "utf8");
      expect(html).not.toContain("Setting conflict");
      // The in-process chain agrees (sample dataset too).
      for (const dataset of ["sample", "real"] as const) {
        const { report } = await scan(box.repo, box.home, dataset);
        expect(report.findings.filter((f) => f.kind === "conflict" || f.kind === "setting-conflict")).toEqual([]);
        const pf = posterFindings(report, "claude-code")!;
        expect([pf.conflicts.length, pf.overrides!.length]).toEqual([0, 0]);
      }
    } finally { await box.cleanup(); }
  }, 60_000);
});

describe("import depth 8, warned beyond", () => {
  async function chain(length: number) {
    const box = await sandbox();
    await put(box.repo, "CLAUDE.md", "@d1.md\n");
    for (let i = 1; i <= length; i++) await put(box.repo, `d${i}.md`, i === length ? "- End of the chain.\n" : `@d${i + 1}.md\n`);
    return box;
  }
  it("reaches depth 8 and warns that depth 9 was not followed", async () => {
    const box = await chain(9);
    try {
      const { sources, warnings } = await discover({ repo: box.repo, home: box.home });
      expect(sources.map((s) => s.logicalPath).sort()).toEqual(["CLAUDE.md", ...Array.from({ length: 8 }, (_, i) => `d${i + 1}.md`)].sort());
      expect(warnings.filter((w) => w.includes("depth limit"))).toEqual(["d8.md:1: @import depth limit (8) reached; deeper imports were not followed"]);
    } finally { await box.cleanup(); }
  });
  it("a chain ending at depth 8 is complete and silent", async () => {
    const box = await chain(8);
    try {
      const { sources, warnings } = await discover({ repo: box.repo, home: box.home });
      expect(sources).toHaveLength(9);
      expect(warnings.filter((w) => w.includes("depth limit"))).toEqual([]);
    } finally { await box.cleanup(); }
  });
});

describe("a fixture mixed with user files is not a SAMPLE SETUP", () => {
  it("--include-user with real user files on a bundled fixture says UNREVIEWED/REDACTED REAL SET", async () => {
    quiet();
    const box = await sandbox();
    try {
      await put(box.home, ".claude/CLAUDE.md", "- Be brief in every answer.\n");
      const poster = async (extra: string[], name: string) => {
        const out = join(box.root, name);
        expect(await run(["fixtures/demo-repo", "--include-user", "--out", out, ...extra], box)).toBe(0);
        return texts(await readFile(join(out, "everyturn.source.svg"), "utf8"));
      };
      const mixed = await poster([], "a");
      expect(mixed).toContain("UNREVIEWED REAL SET");
      expect(mixed).not.toContain("SAMPLE SETUP");
      expect(await poster(["--deny", "zephyrion"], "b")).toContain("REDACTED REAL SET");
      expect(await run(["fixtures/demo-repo", "--include-user", "--dataset", "sample", "--out", join(box.root, "c")], box)).toBe(2);
      // Without user files the fixture is still a sample.
      const out = join(box.root, "d");
      expect(await run(["fixtures/demo-repo", "--out", out], box)).toBe(0);
      expect(texts(await readFile(join(out, "everyturn.source.svg"), "utf8"))).toContain("SAMPLE SETUP");
    } finally { await box.cleanup(); }
  }, 60_000);
});

describe("HOME identity for descendant mounts", () => {
  it("refuses a root, and prunes a walked directory, whose identity is a descendant of ~/.claude", async () => {
    const box = await sandbox();
    try {
      await put(box.home, ".claude/skills/s1/SKILL.md", "---\nname: s1\ndescription: demo\n---\n");
      const ident = async (path: string) => { const i = await stat(path, { bigint: true }); return `${i.dev}:${i.ino}`; };
      const skills = await ident(join(box.home, ".claude", "skills", "s1"));
      // A bind mount of ~/.claude/skills/s1 elsewhere: another path, the same (st_dev, st_ino).
      const mount = join(box.root, "mnt-skill");
      await mkdir(mount);
      await put(mount, "CLAUDE.md", "- Reached through a bind mount.\n");
      const identity = async (path: string) => (path === mount ? skills : ident(path).catch(() => null));
      await expect(discover({ repo: mount, home: box.home, identity })).rejects.toThrow("--include-user");
      // The same directory is an ordinary project folder when it is not an alias.
      expect((await discover({ repo: mount, home: box.home })).sources.map((s) => s.logicalPath)).toEqual(["CLAUDE.md"]);
      // A walked directory with that identity is not entered.
      const repo = join(box.root, "proj");
      await put(repo, "CLAUDE.md", "- Mine.\n");
      await put(repo, "shadow/deep/CLAUDE.md", "- Reached through an alias.\n");
      const shadow = join(repo, "shadow");
      const walked = await discover({ repo, home: box.home, identity: async (path) => (path === shadow ? skills : ident(path).catch(() => null)) });
      expect(walked.sources.map((s) => s.logicalPath)).toEqual(["CLAUDE.md"]);
    } finally { await box.cleanup(); }
  });
});
