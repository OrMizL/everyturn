import { describe, expect, it } from "vitest";
import { activationOf, buildReport, classify, skillListing } from "../src/index";

describe("classify", () => {
  it.each([
    ["CLAUDE.md", "claude-md"], ["apps/web/CLAUDE.md", "claude-md"], ["CLAUDE.local.md", "claude-local-md"],
    ["AGENTS.md", "agents-md"], [".claude/skills/x/SKILL.md", "skill-listing"], [".cursor/rules/a.mdc", "cursor-rule"],
    [".cursorrules", "cursor-rule"], [".github/copilot-instructions.md", "copilot-instructions"], [".windsurfrules", "windsurf-rules"],
    [".claude/settings.json", "settings"], [".claude/settings.local.json", "settings"], [".mcp.json", "mcp"],
    ["README.md", null], ["docs/SKILL.md", null],
  ])("%s -> %s", (p, k) => expect(classify(p)).toBe(k));
});

describe("activation", () => {
  const fm = (body: string) => `---\n${body}\n---\nrule`;
  it.each([
    ["CLAUDE.md", "project", "x", "always"], ["CLAUDE.local.md", "project", "x", "always"], ["~/.claude/CLAUDE.md", "user", "x", "always"],
    ["apps/web/CLAUDE.md", "nested", "x", "nested"], ["packages/api/AGENTS.md", "nested", "x", "nested"],
    ["AGENTS.md", "project", "x", "always"], ["AGENTS.override.md", "project", "x", "always"], ["~/.codex/AGENTS.md", "user", "x", "always"],
    [".claude/skills/a/SKILL.md", "project", fm("name: a"), "always"], ["apps/x/.claude/skills/a/SKILL.md", "nested", fm("name: a"), "nested"],
    [".claude/rules/a.md", "project", "no frontmatter", "always"], [".claude/rules/a.md", "project", fm("description: d"), "always"],
    [".claude/rules/a.md", "project", fm('paths:\n  - "src/**"'), "conditional"], [".claude/rules/a.md", "project", fm("paths: src/**/*.ts"), "conditional"],
    [".claude/rules/a.md", "project", fm('globs: ["a/**"]'), "conditional"],
    // a `paths:`/`globs:` key in ANY form makes the rule conditional (comment lines, quoted keys, empty values).
    [".claude/rules/a.md", "project", fm("globs:"), "conditional"], [".claude/rules/a.md", "project", fm('globs: ""'), "conditional"],
    [".claude/rules/a.md", "project", fm("# only for the web app\npaths:\n  # first\n  - \"web/**\""), "conditional"],
    [".claude/rules/a.md", "project", fm('"paths": ["web/**"]'), "conditional"], [".claude/rules/a.md", "project", fm("'paths': web/**"), "conditional"],
    [".claude/rules/a.md", "project", fm("paths: # none yet"), "conditional"], [".claude/rules/a.md", "project", fm("paths: []"), "conditional"],
    [".claude/rules/a.md", "project", fm("description: paths: are mentioned here only"), "always"],
    ["~/.claude/rules/a.md", "user", fm("paths: a"), "conditional"],
    // Cursor: inline comments and quoted values.
    [".cursor/rules/a.mdc", "project", fm("alwaysApply: true # global"), "always"], [".cursor/rules/a.mdc", "project", fm("alwaysApply: \"true\" # global"), "always"],
    [".cursor/rules/a.mdc", "project", fm("# header\nalwaysApply: TRUE"), "always"], [".cursor/rules/a.mdc", "project", fm("alwaysApply: false # true"), "conditional"],
    [".cursor/rules/a.mdc", "project", fm("description: alwaysApply: true"), "conditional"],
    // Skills: disable-model-invocation keeps the listing out of the always-loaded hero.
    [".claude/skills/a/SKILL.md", "project", fm("name: a\ndisable-model-invocation: true"), "inactive"],
    [".claude/skills/a/SKILL.md", "project", fm("name: a\n\"disable-model-invocation\": true # manual only"), "inactive"],
    [".claude/skills/a/SKILL.md", "project", fm("name: a\ndisable-model-invocation: false"), "always"],
    // CLAUDE.md inside .claude/ subfolders is not the always-loaded project memory file; .claude/CLAUDE.md is.
    [".claude/skills/ex/CLAUDE.md", "project", "x", "nested"], [".claude/rules/CLAUDE.md", "project", "x", "nested"], [".claude/CLAUDE.md", "project", "x", "always"],
    ["~/.claude/skills/x/CLAUDE.md", "user", "x", "nested"],
    // Codex: .codex/AGENTS.md is not a project file Codex loads (only ~/.codex/AGENTS.md, with --include-user).
    [".codex/AGENTS.md", "project", "x", "inactive"], [".codex/AGENTS.override.md", "project", "x", "inactive"], [".claude/skills/ex/AGENTS.md", "project", "x", "inactive"],
    [".cursor/rules/a.mdc", "project", fm("alwaysApply: true"), "always"], [".cursor/rules/a.mdc", "project", fm("alwaysApply: false"), "conditional"],
    [".cursor/rules/a.mdc", "project", fm("alwaysApply: true\nglobs: a"), "always"], [".cursor/rules/a.mdc", "project", fm("globs: a"), "conditional"],
    [".cursor/rules/a.mdc", "project", "alwaysApply: true", "conditional"], [".cursorrules", "project", "x", "always"],
    [".github/copilot-instructions.md", "project", "x", "always"], [".windsurfrules", "project", "x", "always"],
    [".claude/settings.json", "project", "{}", "config"], [".mcp.json", "project", "{}", "config"], ["~/.claude/settings.json", "user", "{}", "config"],
  ] as const)("%s (%s) -> %s", (path, scope, text, expected) => {
    const kind = classify(path)!;
    expect(activationOf(kind, scope, path, text)).toBe(expected);
    expect(buildReport([{ logicalPath: path, text, scope }]).sources[0]?.activation).toBe(expected);
  });
  it("is part of the report JSON", () => {
    const json = JSON.parse(JSON.stringify(buildReport([{ logicalPath: "CLAUDE.md", text: "x", scope: "project" }, { logicalPath: ".mcp.json", text: "{}", scope: "project" }])));
    expect(json.sources.map((s: { activation: string }) => s.activation).sort()).toEqual(["always", "config"]);
  });
});

describe("skills", () => {
  it("represents a skill by its listing line, not its body", () => {
    const text = "---\nname: demo\ndescription: Does a thing.\n---\n# Long body\n" + "x".repeat(1000);
    expect(skillListing(text)).toEqual({ name: "demo", description: "Does a thing." });
    const r = buildReport([{ logicalPath: ".claude/skills/demo/SKILL.md", text, scope: "project" }]);
    expect(r.sources[0]?.represented).toBe("- demo: Does a thing.");
    expect(r.sources[0]?.bytes).toBeLessThan(r.sources[0]!.rawBytes);
  });
});

describe("buildReport", () => {
  it("sorts by size desc, numbers ids, totals, and skips non-sources", () => {
    const r = buildReport([
      { logicalPath: "AGENTS.md", text: "- a\n", scope: "project" },
      { logicalPath: "CLAUDE.md", text: "- a much longer rule here\n", scope: "project" },
      { logicalPath: "README.md", text: "ignored", scope: "project" },
    ]);
    expect(r.sources.map((s) => [s.id, s.logicalPath])).toEqual([["s1", "CLAUDE.md"], ["s2", "AGENTS.md"]]);
    expect(r.totals.sources).toBe(2);
    expect(r.totals.bytes).toBe(r.sources[0]!.bytes + r.sources[1]!.bytes);
  });
  it("is deterministic", () => {
    const raw = [{ logicalPath: "CLAUDE.md", text: "x", scope: "project" as const }, { logicalPath: "AGENTS.md", text: "y", scope: "project" as const }];
    expect(JSON.stringify(buildReport(raw))).toBe(JSON.stringify(buildReport([...raw].reverse())));
  });
});

