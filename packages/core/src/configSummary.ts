import { redact, type Denylist } from "./redact";
import { measure } from "./size";

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
/** Cut to `max` characters without splitting a placeholder such as "[redacted]". */
const truncate = (s: string, max: number) => {
  if (s.length <= max) return s;
  for (const m of s.matchAll(/\[(?:redacted|secret|email|host|path|credentials)\]/g)) {
    if (m.index < max && m.index + m[0].length > max) return s.slice(0, m.index);
  }
  return s.slice(0, max);
};

/** Claude Code settings keys that may be shown by name. Anything else is only counted. */
export const KNOWN_SETTINGS_KEYS: readonly string[] = [
  "model", "permissions", "hooks", "env", "apiKeyHelper", "includeCoAuthoredBy", "cleanupPeriodDays", "statusLine",
  "outputStyle", "enableAllProjectMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers", "theme",
  "forceLoginMethod", "awsAuthRefresh", "awsCredentialExport", "enabledPlugins", "alwaysThinkingEnabled",
  "spinnerTipsEnabled", "additionalDirectories",
];
export const KNOWN_HOOK_EVENTS: readonly string[] = [
  "PreToolUse", "PostToolUse", "Notification", "UserPromptSubmit", "Stop", "SubagentStop", "PreCompact", "SessionStart", "SessionEnd",
];
const KNOWN_NAMES = new Set(KNOWN_SETTINGS_KEYS);
const KNOWN_EVENTS = new Set(KNOWN_HOOK_EVENTS);
/**
 * Known public model names only: aliases (opus, sonnet, haiku, default, opusplan) and Anthropic model IDs
 * (claude-<family>-N[-N][-YYYYMMDD], the older claude-N[-N]-<family>[-YYYYMMDD|-latest]), each with an optional [1m] suffix.
 * Anything else (private suffixes, fine-tune names, paths, ARNs) is "[custom]".
 */
const PUBLIC_MODEL = /^(?:(?:claude-(?:opus|sonnet|haiku)-\d{1,2}(?:-\d{1,2})?|claude-\d{1,2}(?:-\d{1,2})?-(?:opus|sonnet|haiku))(?:-\d{8}|-latest)?|opus|sonnet|haiku|default|opusplan)(?:\[1m\])?$/;

/** True for a known public model name (alias or Anthropic model ID); anything else is shown as [custom]. */
export const publicModel = (value: string): boolean => PUBLIC_MODEL.test(value);

export interface ConfigSummaryOptions {
  denylist?: Denylist;
  /** Show user-chosen names (MCP servers, unknown settings keys and hook events). Default: aliases and counts. */
  showNames?: boolean;
}

/**
 * Only explicitly permitted metadata can cross this boundary; never stringify config values.
 * Default output is counts, transports and known-schema key names; MCP servers become server-1, server-2, ...
 * (numbered by sorted original name) unless `showNames`.
 */
export function configSummary(text: string, kind: "settings" | "mcp", options: ConfigSummaryOptions = {}): { text: string; warning?: string } {
  const { denylist, showNames = false } = options;
  const safeName = (name: string) => truncate(redact(name, { denylist }), 40).replace(/[\r\n\t]/g, " ");
  let config: Record<string, unknown>;
  try {
    config = object(JSON.parse(text));
  } catch {
    return { text: `unparseable JSON, ${measure(text).bytes} bytes`, warning: "unparseable JSON; config values omitted" };
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (kind === "mcp") {
    const servers = object(config.mcpServers);
    const lines = Object.keys(servers).sort(compare).map((name, i) => {
      const server = object(servers[name]);
      const type = server.type === "http" || server.type === "sse" || server.type === "stdio"
        ? server.type : "url" in server ? "http" : "stdio";
      return `${showNames ? safeName(name) : `server-${i + 1}`} (${type})`;
    });
    return { text: `MCP servers: ${lines.length}${lines.length ? `; ${lines.join("; ")}` : ""}` };
  }
  const permissions = object(config.permissions);
  const hooks = object(config.hooks);
  const eventNames = Object.keys(hooks).sort(compare);
  const events = eventNames.filter((name) => KNOWN_EVENTS.has(name) || showNames).map((name) => {
    const entries = hooks[name];
    const n = Array.isArray(entries) ? entries.reduce((sum: number, entry: unknown) => sum + count(object(entry).hooks), 0) : 0;
    return `${KNOWN_EVENTS.has(name) ? name : safeName(name)}: ${n}`;
  });
  const otherEvents = showNames ? 0 : eventNames.filter((name) => !KNOWN_EVENTS.has(name)).length;
  const keys = Object.keys(config).sort(compare);
  const shown = keys.filter((key) => KNOWN_NAMES.has(key) || showNames).map((key) => KNOWN_NAMES.has(key) ? key : safeName(key));
  if ("defaultMode" in permissions) shown.push("permissions.defaultMode");
  if ("additionalDirectories" in permissions && !shown.includes("additionalDirectories")) shown.push("additionalDirectories");
  const otherKeys = showNames ? 0 : keys.filter((key) => !KNOWN_NAMES.has(key)).length;
  const lines = [
    // Labels must not look like secret keys ("Settings keys:" would be masked by the shared key matcher): "fields", "API key helper".
    `Settings fields: ${[...shown, ...(otherKeys ? [`${otherKeys} other ${otherKeys === 1 ? "key" : "keys"}`] : [])].join(", ") || "none"}`,
    `Permissions: allow ${count(permissions.allow)}, deny ${count(permissions.deny)}, ask ${count(permissions.ask)}`,
    `Hooks: ${[...events, ...(otherEvents ? [plural(otherEvents, "other event")] : [])].join("; ") || "0"}`,
    `Environment variables: ${Object.keys(object(config.env)).length}`,
  ];
  if ("model" in config) lines.push(`Model: ${typeof config.model === "string" && PUBLIC_MODEL.test(config.model) ? config.model : "[custom]"}`);
  if ("apiKeyHelper" in config) lines.push("API key helper: set");
  return { text: redact(lines.join("\n"), { denylist }) };
}
