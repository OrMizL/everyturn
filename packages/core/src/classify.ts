import { isTrue, parseFrontmatter } from "./frontmatter";
import type { Activation, Agent, Scope, SourceKind } from "./types";

/** Classify a logical path into a source kind, or null if it is not an instruction source. */
export function classify(logicalPath: string): SourceKind | null {
  const p = logicalPath.replace(/\\/g, "/");
  const base = p.split("/").pop() ?? "";
  if (base === "CLAUDE.local.md") return "claude-local-md";
  if (base === "CLAUDE.md") return "claude-md";
  if (base === "AGENTS.md" || base === "AGENTS.override.md") return "agents-md";
  if (base === "SKILL.md" && /(^|\/)\.(claude|agents|codex)\/skills\//.test(p)) return "skill-listing";
  if (/(^|\/)\.cursor\/rules\/.+\.mdc$/.test(p) || base === ".cursorrules") return "cursor-rule";
  if (/(^|\/)\.github\/copilot-instructions\.md$/.test(p)) return "copilot-instructions";
  if (base === ".windsurfrules") return "windsurf-rules";
  if (/(^|\/)\.claude\/rules\/.+\.md$/.test(p)) return "claude-rule";
  if (/(^|\/)\.claude\/settings[^/]*\.json$/.test(p)) return "settings";
  if (base === ".mcp.json") return "mcp";
  return null;
}

/**
 * Scope of a repo-relative logical path (never `~/`): files directly at the root and in the known root config directories
 * are project scope; anything deeper is nested. Shared by the CLI walk and the browser page.
 */
export function projectScope(rel: string): Scope {
  if (!rel.includes("/")) return "project";
  // Only known root config directories belong to project scope.
  if (/^\.(claude|codex|agents|cursor|github)\//.test(rel) && !rel.split("/").slice(1, -1).some((part) => part.startsWith("."))) {
    // ...and a CLAUDE.md / CLAUDE.local.md deeper inside .claude/ (".claude/skills/x/CLAUDE.md") is not the project memory file.
    if (/^\.claude\/.+\/CLAUDE(\.local)?\.md$/.test(rel)) return "nested";
    return "project";
  }
  return "nested";
}

export const KIND_LABEL: Record<SourceKind, string> = {
  "claude-md": "CLAUDE.md",
  "claude-local-md": "CLAUDE.local.md",
  "agents-md": "AGENTS.md",
  "skill-listing": "Skill listing",
  "cursor-rule": "Cursor rule",
  "copilot-instructions": "Copilot instructions",
  "windsurf-rules": "Windsurf rules",
  "claude-rule": "Claude rule",
  "claude-import": "Imported file",
  settings: "Settings",
  mcp: "MCP servers",
};

/** Directory names of a logical path (without the file name). */
const dirsOf = (logicalPath: string) => logicalPath.replace(/\\/g, "/").split("/").slice(0, -1);
const isHidden = (dir: string) => dir.startsWith(".") && dir !== "." && dir !== "..";

/**
 * Which sources are always-loaded instruction text at the repo root (user files count when included).
 * Nested files, glob-scoped or non-alwaysApply rules, config summaries and files an agent does not auto-load are listed but
 * not counted. Frontmatter is parsed (comments, quoted keys, inline comments), not pattern-matched:
 * - a Claude rule with a `paths:` (or `globs:`) key in any form is conditional;
 * - a Cursor rule is always only with `alwaysApply: true` (an inline `# comment` is fine);
 * - a skill with `disable-model-invocation: true` is not injected into the listing: inactive;
 * - CLAUDE.md under a `.claude/` subfolder (`.claude/skills/x/CLAUDE.md`) is not a project memory file: nested;
 * - AGENTS.md in a hidden folder (`.codex/AGENTS.md`) is not a file Codex loads from a project: inactive.
 *   (Per-directory AGENTS.override.md precedence needs the whole file set and is applied in buildReport.)
 */
export function activationOf(kind: SourceKind, scope: Scope, logicalPath: string, text: string): Activation {
  if (kind === "settings" || kind === "mcp") return "config";
  if (kind === "skill-listing" && isTrue(parseFrontmatter(text).get("disable-model-invocation"))) return "inactive";
  if (scope === "nested") return "nested";
  const dirs = dirsOf(logicalPath);
  const hidden = dirs.findIndex(isHidden);
  if (kind === "agents-md" && scope !== "user" && hidden >= 0) return "inactive";
  if ((kind === "claude-md" || kind === "claude-local-md") && hidden >= 0 && dirs.length - 1 - hidden > 0) return "nested";
  if (kind === "cursor-rule" && !logicalPath.endsWith(".cursorrules")) {
    return isTrue(parseFrontmatter(text).get("alwaysapply")) ? "always" : "conditional";
  }
  if (kind === "claude-rule") {
    const fm = parseFrontmatter(text);
    return fm.has("paths") || fm.has("globs") ? "conditional" : "always";
  }
  return "always";
}

/** The agent a source kind belongs to (Claude Code is the default for CLAUDE.md, rules, settings and MCP). */
export function agentFor(kind: SourceKind, path: string): Agent {
  if (kind === "agents-md" || (kind === "skill-listing" && /\.(codex|agents)\/skills\//.test(path))) return "codex";
  if (kind === "cursor-rule") return "cursor";
  if (kind === "copilot-instructions") return "copilot";
  if (kind === "windsurf-rules") return "windsurf";
  return "claude-code";
}

/** Kinds that are instruction files (as opposed to rules, skills and config). */
const INSTRUCTION_KINDS = new Set<SourceKind>(["claude-md", "claude-local-md", "agents-md", "copilot-instructions", "windsurf-rules"]);

/**
 * True for the always-loaded instruction files at the repo root for one agent: CLAUDE.md, CLAUDE.local.md, AGENTS.md,
 * .github/copilot-instructions.md, .windsurfrules. A file the agent does not load (CLAUDE.md for Codex) is false.
 * Per-directory AGENTS.override.md precedence needs the whole file set and is applied by buildReport, not here.
 */
export function isRootAlways(logicalPath: string, text: string, agent: Agent): boolean {
  const kind = classify(logicalPath);
  return kind !== null && agentFor(kind, logicalPath) === agent && isRootInstruction(logicalPath, text);
}

/**
 * True for an always-loaded instruction file at the repo root, whichever agent it belongs to (CLAUDE.md, CLAUDE.local.md, AGENTS.md,
 * AGENTS.override.md, copilot-instructions.md, .windsurfrules). Used for list order, where the selected agent must not matter.
 */
export function isRootInstruction(logicalPath: string, text: string): boolean {
  const kind = classify(logicalPath);
  if (kind === null || !INSTRUCTION_KINDS.has(kind)) return false;
  const scope = projectScope(logicalPath);
  return scope === "project" && activationOf(kind, scope, logicalPath, text) === "always";
}
