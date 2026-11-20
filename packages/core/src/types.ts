export type SourceKind =
  | "claude-md"
  | "claude-local-md"
  | "agents-md"
  | "skill-listing"
  | "cursor-rule"
  | "copilot-instructions"
  | "windsurf-rules"
  | "claude-rule"
  | "claude-import"
  | "settings"
  | "mcp";

export const AGENTS = ["claude-code", "codex", "cursor", "copilot", "windsurf"] as const;
export type Agent = typeof AGENTS[number];
export type AgentInventory = { sources: number; bytes: number; estTokens: number };

export type Scope = "project" | "nested" | "user";

/**
 * Whether a source is injected text on every turn at the repo root.
 * - always: root (or user) instruction text, skill listings, always-on rules
 * - nested: instruction file in a subdirectory (loaded only when working there)
 * - conditional: rule scoped by globs, or a Cursor rule without alwaysApply: true
 * - config: settings or MCP summary (configuration metadata, not injected text)
 * - inactive: listed, but the agent does not auto-load it: a skill with `disable-model-invocation: true`, `.codex/AGENTS.md` in a
 *   project, or an AGENTS.md next to an AGENTS.override.md (Codex loads one file per directory)
 */
export type Activation = "always" | "nested" | "conditional" | "config" | "inactive";

/** One input file, already read by an adapter (CLI fs or browser paste). */
export interface RawSource {
  /** Logical path, relative to the repo root, or "~/..." for user-level. Never absolute. */
  logicalPath: string;
  text: string;
  scope: Scope;
  /** Set by discovery for a file reached only through a Claude Code `@path` import (not a source kind of its own). */
  viaImport?: boolean;
  /** Original size in bytes when `text` is only the bounded head of an oversized SKILL.md (its frontmatter listing). */
  rawBytes?: number;
}

/** A Claude Code `@path` import occurrence: the importing source and the 1-based line of the import. */
export interface ImportRef { by: string; line: number }

export interface Source {
  id: string;
  kind: SourceKind;
  agent: Agent;
  represents: "config-summary" | "instructions" | "skill-listing";
  label: string;
  logicalPath: string;
  scope: Scope;
  /** Only "always" sources count toward the poster hero. */
  activation: Activation;
  /**
   * Import occurrences: a file imported by CLAUDE.md or CLAUDE.local.md (directly or through other imports) is one
   * physical source and appears in the Claude Code profile through these references. Never double counted in totals.
   */
  importedBy: ImportRef[];
  /** Activation inside the Claude Code profile when this source belongs to another agent but is imported (else absent). */
  claudeActivation?: Activation;
  /** What is represented as injected text (instructions, config summary, or a skill's listing line). */
  represented: string;
  rawBytes: number;
  bytes: number;
  chars: number;
  /** Estimated tokens: UTF-8 bytes / 4, rounded up. An estimate, not a tokenizer. */
  estTokens: number;
}

export type Confidence = "high" | "medium" | "low";
export type FindingKind = "conflict" | "setting-conflict" | "duplicate" | "near-duplicate" | "repeated-in-file";

export interface Evidence {
  sourceId: string;
  /** Logical path (redacted). */
  path: string;
  line: number;
  /** Original excerpt (redacted); null when withheld for privacy (only path:line is shown). */
  excerpt: string | null;
  /** Heading context, present only when the excerpt is shown. */
  heading?: string;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  confidence: Confidence;
  /** Why it fired, e.g. "polarity", "curated:comments", "numeric:indent", "exact", "jaccard". */
  rule: string;
  /** Similarity for near-duplicates (token-set Jaccard) and the threshold it was held to. */
  score?: number;
  threshold?: number;
  /** Secondary word-shingle similarity, recorded for long rules. */
  shingleScore?: number;
  evidence: Evidence[];
  /** E.g. "Both load at repo root", "Applies when working in apps/web", "Different agents: Claude Code vs Codex". */
  applicability: string;
  /** E.g. "No clear precedence; which one wins is unknown." */
  precedence: string;
  /** Setting conflicts only: a higher-precedence layer overrides a shared one. */
  intentionalOverride?: boolean;
  /**
   * Agent profiles that contain all of the evidence sources (a duplicate group: at least two). For a cross-agent finding
   * (no single profile has all of it) the agents the evidence belongs to.
   */
  agents: Agent[];
  /**
   * True when no single agent profile contains all of the evidence (e.g. CLAUDE.md vs AGENTS.md): the files may never be
   * co-active, so the finding is low confidence and never counted in a headline. An explicit @import between the files
   * puts them in one profile and clears this.
   */
  crossAgent?: boolean;
}

export interface FindingCounts {
  /** False when detection was switched off (`--findings off`). */
  checked: boolean;
  conflicts: number;
  settingConflicts: number;
  duplicates: number;
  nearDuplicates: number;
  repeatedInFile: number;
  byConfidence: Record<Confidence, number>;
  /**
   * Medium and high findings that share an agent profile; low confidence, cross-agent findings and repeats are excluded.
   * Intentional model overrides (a higher settings layer overriding a lower one) are not conflicts: they have their own count.
   */
  headline: { conflicts: number; duplicates: number; overrides: number };
}

export interface Report {
  schemaVersion: string;
  estimator: string;
  totals: { sources: number; bytes: number; chars: number; estTokens: number };
  byAgent: Partial<Record<Agent, AgentInventory>>;
  sources: Source[];
  findings: Finding[];
  findingCounts: FindingCounts;
  warnings: string[];
}
