/** `~/.claude/skills/<dir>/SKILL.md` and the .codex / .agents equivalents: the tool's logical path for a user-level skill. */
const USER_SKILL_PATH = /(~\/\.(?:claude|codex|agents)\/skills\/)([^/\s]+)(\/SKILL\.md)/g;
/**
 * The directory of a user-level skill is chosen by the user (it can be a handle or a private project name), so it is not shown as such:
 * `~/.claude/skills/[name]/SKILL.md`. It stays only when `keep` says so (the caller checks that it equals the frontmatter name and that
 * the name passes the denylist and redaction). Project skill paths are repo-relative and are not touched.
 */
export function maskUserSkillDirs(text: string, keep: (dir: string) => boolean = () => false): string {
  return text.replace(USER_SKILL_PATH, (m, head: string, dir: string, tail: string) => (keep(dir) ? m : `${head}[name]${tail}`));
}

/** Extract `name` and `description` from SKILL.md YAML frontmatter (including indented description continuations). */
export function skillListing(text: string): { name: string; description: string } | null {
  // Same fences as the oversize-head guard in the CLI and the frontmatter reader: the closing `---` (or `...`) is alone on its line.
  const m = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m || m[1] === undefined) return null;
  const fields: Record<string, string> = {};
  let current = "";
  // Quote character of a multi-line quoted description whose closing quote is on a later line.
  let openQuote = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):[ \t]*(.*)$/.exec(line);
    if (kv && kv[1] && kv[2] !== undefined) {
      current = kv[1];
      const value = kv[2].trim();
      if (current === "description") openQuote = /^["']/.test(value) && !(value.length > 1 && value.endsWith(value[0]!)) ? value[0]! : "";
      fields[current] = /^[>|][+-]?$/.test(value) ? "" : kv[2].replace(/^["']|["']$/g, "").trim();
    } else if (current === "description" && /^[ \t]+\S/.test(line)) {
      fields.description = [fields.description, line.trim()].filter(Boolean).join(" ");
    } else if (line.trim()) {
      current = "";
    }
  }
  if (openQuote && fields.description?.endsWith(openQuote)) fields.description = fields.description.slice(0, -1).trimEnd();
  if (!fields.name) return null;
  return { name: fields.name, description: fields.description ?? "" };
}

/** The line an agent sees in its skill listing (not the skill body). */
export function listingLine(l: { name: string; description: string }): string {
  return `- ${l.name}: ${l.description}`;
}
