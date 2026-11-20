// Claude Code `@path` imports in CLAUDE.md / CLAUDE.local.md. Pure path logic; discovery (CLI) does the reading.
import { sanitizeText } from "./rules";

/** Imports follow at most this many levels (CLAUDE.md -> a -> ... -> h); a file at level 9 is warned about, not read. */
export const MAX_IMPORT_DEPTH = 8;
const IMPORT_EXTENSION = /\.(?:md|mdc|markdown|mdx|txt)$/i;

export interface ImportSpec { line: number; spec: string }

/**
 * `@path` tokens in prose. Fenced code blocks and `code spans` are not imports, and an `@` must start a word
 * (so an email address or `user@host` never counts). The token must look like a path: it contains `/` or an extension.
 */
export function extractImports(text: string): ImportSpec[] {
  const out: ImportSpec[] = [];
  let fence: { ch: string; len: number } | null = null;
  sanitizeText(text).split("\n").forEach((line, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (f && f[1]![0] === fence.ch && f[1]!.length >= fence.len) fence = null; return; }
    if (f) { fence = { ch: f[1]![0]!, len: f[1]!.length }; return; }
    const prose = line.replace(/(`+)[\s\S]*?\1/g, " ");
    for (const m of prose.matchAll(/(?<![^\s(])@([^\s)\]>"'`]+)/g)) {
      const spec = (m[1] ?? "").replace(/[.,;:!?]+$/, "");
      if (spec && (spec.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(spec))) out.push({ line: i + 1, spec });
    }
  });
  return out;
}

export type ImportResolution = { path: string } | { skip: "absolute" | "outside" | "env" | "type" | "user" | "empty" };

/**
 * Resolve an import against the importing file's logical path (relative to the scanned repo root, or `~/...`).
 * Never absolute, never above the scanned root, never `.env*`, never `.git` or `node_modules`; `~/.claude/...`
 * only with `includeUser`, and a user file's relative imports stay inside `~/.claude/`. Only text file types
 * (.md, .mdc, .markdown, .mdx, .txt) are followed.
 */
export function resolveImport(fromLogical: string, rawSpec: string, includeUser: boolean): ImportResolution {
  const spec = rawSpec.trim();
  if (!spec) return { skip: "empty" };
  if (spec.includes("\0") || spec.includes("\\")) return { skip: "outside" };
  if (spec.startsWith("/") || /^[A-Za-z]:/.test(spec)) return { skip: "absolute" };
  const fromUser = fromLogical.startsWith("~/");
  let base: string[];
  let floor: number;
  if (spec.startsWith("~/")) { base = []; floor = 0; }
  else {
    base = fromLogical.split("/").slice(0, -1);
    floor = fromUser ? 2 : 0; // "~" and ".claude" are the root of a user file's world
  }
  const segments = spec.startsWith("~/") ? spec.split("/") : [...base, ...spec.split("/")];
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length <= (spec.startsWith("~/") ? 2 : floor)) return { skip: "outside" };
      out.pop();
    } else out.push(seg);
  }
  const user = out[0] === "~";
  if (spec.startsWith("~/") && !(out[0] === "~" && out[1] === ".claude" && out.length > 2)) return { skip: "user" };
  if (user && (!includeUser || out[1] !== ".claude")) return { skip: "user" };
  if (out.some((s) => s === ".git" || s === "node_modules")) return { skip: "outside" };
  const name = out[out.length - 1] ?? "";
  if (!name || /^\.env(\.|$)/i.test(name) || /^\.env/i.test(name)) return { skip: "env" };
  if (!IMPORT_EXTENSION.test(name)) return { skip: "type" };
  return { path: out.join("/") };
}
