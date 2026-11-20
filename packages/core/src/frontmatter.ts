// A small YAML-ish frontmatter reader for the keys that decide activation (paths, globs, alwaysApply,
// disable-model-invocation). Pure: no fs, env, network, Date or random. It is not a YAML parser: it understands
// top-level keys (bare or quoted), `#` comments (whole-line and inline), inline lists, block lists and block scalars,
// which is every shape the agents' own docs use. Anything else is ignored rather than guessed at.

export interface FrontmatterEntry {
  /** The scalar after the colon, inline comment removed, quotes kept ("" for a block). */
  value: string;
  /** List items of a block list (`- a`) or an inline list (`[a, b]`), quotes removed. */
  items: string[];
}

const KEY = /^(?:"([^"\\]{1,80})"|'([^'\\]{1,80})'|([A-Za-z0-9_.-]{1,80}))[ \t]*:(?:[ \t]+(.*))?$/;

/** Cut a trailing ` # comment` that is not inside quotes. */
function stripComment(value: string): string {
  let quote = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(value[i - 1]!))) return value.slice(0, i).trimEnd();
  }
  return value.trimEnd();
}
const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");

/** Split at top-level occurrences of `sep` (outside quotes and brackets). */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === sep && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/** A frontmatter that is one flow mapping (`{"paths": ["a"], alwaysApply: true}`, possibly over several lines). */
function parseFlowMap(body: string, out: Map<string, FrontmatterEntry>): boolean {
  const m = /^\{([\s\S]*)\}$/.exec(body.trim());
  if (!m) return false;
  for (const pair of splitTop(m[1] ?? "", ",")) {
    const kv = splitTop(pair, ":");
    if (kv.length < 2) continue;
    const key = unquote(kv[0] ?? "").toLowerCase();
    if (!key) continue;
    const value = kv.slice(1).join(":").trim();
    const inline = /^\[([\s\S]*)\]$/.exec(value);
    out.set(key, { value, items: inline ? splitTop(inline[1] ?? "", ",").map(unquote).filter(Boolean) : [] });
  }
  return true;
}

/** Frontmatter keys (lower case) of a document that starts with `---`; an empty map when there is none. */
export function parseFrontmatter(text: string): Map<string, FrontmatterEntry> {
  const out = new Map<string, FrontmatterEntry>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return out;
  const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l));
  if (close < 0) return out;
  // A flow map may carry comments (`{alwaysApply: true} # why`, a `# note` inside a multi-line map): cut them before looking for the braces.
  if (parseFlowMap(lines.slice(1, close).filter((l) => !/^\s*#/.test(l)).map(stripComment).join("\n"), out)) return out;
  let current: FrontmatterEntry | null = null;
  for (const line of lines.slice(1, close)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const top = !/^[ \t]/.test(line) && !/^-(?:[ \t]|$)/.test(line);
    const key = top ? KEY.exec(line) : null;
    if (key) {
      const value = stripComment(key[4] ?? "").trim();
      const inline = /^\[(.*)\]$/.exec(value);
      current = { value, items: inline ? (inline[1] ?? "").split(",").map(unquote).filter(Boolean) : [] };
      out.set((key[1] ?? key[2] ?? key[3] ?? "").toLowerCase(), current);
    } else if (current) {
      const item = /^[ \t]*-(?:[ \t]+(.*))?$/.exec(line);
      if (item) { const v = unquote(stripComment(item[1] ?? "")); if (v) current.items.push(v); }
    }
  }
  return out;
}

/** True for `true` in any case, quoted or not. */
export const isTrue = (entry: FrontmatterEntry | undefined): boolean => !!entry && unquote(entry.value).toLowerCase() === "true";
