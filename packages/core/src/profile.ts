import type { Activation, Agent, Source } from "./types";

export const AGENT_NAME: Record<Agent, string> = {
  "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", copilot: "Copilot", windsurf: "Windsurf",
};

/**
 * A source belongs to its own agent's profile, and to the Claude Code profile when CLAUDE.md or CLAUDE.local.md
 * imports it with `@path` (the file is still one physical source; the import is an occurrence).
 */
export const inProfile = (s: Source, agent: Agent): boolean =>
  s.agent === agent || (agent === "claude-code" && s.claudeActivation !== undefined);

/** Activation of a source inside one agent's profile (an imported foreign file takes its importer's activation). */
export const activationIn = (s: Source, agent: Agent): Activation =>
  s.agent === agent ? s.activation : agent === "claude-code" && s.claudeActivation !== undefined ? s.claudeActivation : s.activation;
