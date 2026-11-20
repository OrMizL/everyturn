import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { MAX_IMPORT_DEPTH, SKILL_HEAD_BYTES, classify, extractImports, headFrontmatterCloses, projectScope, redact, resolveImport, trimSplitChar } from "@everyturn/core";
import type { Denylist, RawSource, Scope } from "@everyturn/core";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".vercel", "coverage"]);
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_RUN_BYTES = 5 * 1024 * 1024;
/** A SKILL.md over MAX_FILE_BYTES is not skipped: only its first SKILL_HEAD_BYTES (64 KiB, shared with the web page) are read. */
export { SKILL_HEAD_BYTES };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

// Child links are never followed, including every component of the user allowlist.
async function children(dir: string) {
  return (await readdir(dir, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
}

/** The account database's home directory, which can differ from $HOME. */
function accountHome(): string | undefined {
  try { return userInfo().homedir || undefined; } catch { return undefined; }
}

export interface DiscoverOptions {
  repo: string;
  includeUser?: boolean;
  home?: string;
  denylist?: Denylist;
  /** Filesystem identity of a path, or null if unknown. Defaults to `st_dev:st_ino`; tests replace it to simulate bind mounts. */
  identity?: (path: string) => Promise<string | null>;
}

/** `st_dev:st_ino` of a path (following links), or null when it cannot be read. */
async function fsIdentity(path: string): Promise<string | null> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.dev}:${info.ino}`;
  } catch { return null; }
}

export async function discover(opts: DiscoverOptions): Promise<{ sources: RawSource[]; warnings: string[]; canonicalRepo: string }> {
  const sources: RawSource[] = [];
  const warnings: string[] = [];
  let canonicalRepo: string;
  try {
    canonicalRepo = await realpath(opts.repo);
    if (!(await stat(canonicalRepo)).isDirectory()) throw new Error();
    await children(canonicalRepo); // A bad root is an error, not an empty inventory.
  } catch {
    throw new Error("Cannot read repo root (missing, unreadable, or not a directory)");
  }
  const home = opts.home ?? homedir();
  // Every HOME the process knows about: the one in use, os.homedir() and the account database's.
  const homes = [...new Set([home, homedir(), accountHome()].filter((h): h is string => !!h))];
  const canonicalHomes = [...new Set(await Promise.all(homes.map((h) => realpath(h).catch(() => h))))];
  const protectedRoots = [...new Set(await Promise.all(canonicalHomes.flatMap((h) => [".claude", ".codex", ".agents"].map(async (name) => {
    const path = join(h, name);
    return realpath(path).catch(() => path);
  }))))];
  // HOME itself, anything that contains HOME (its parent, /home, /Users, /), and the protected roots are
  // user configuration roots: a walk from there would reach ~/.claude etc. under a relative-looking path.
  // Paths can name the same directory without matching as strings (bind mounts, case-insensitive aliases), so the
  // check also compares filesystem identity (st_dev, st_ino) of HOME, its ancestors and the protected roots against
  // the scan root, its ancestors and every walked directory. Identities are cached per path.
  const identities = new Map<string, Promise<string | null>>();
  const identify = (path: string) => {
    let id = identities.get(path);
    if (!id) identities.set(path, id = (opts.identity ?? fsIdentity)(path));
    return id;
  };
  const chain = async (start: string): Promise<string[]> => {
    const ids: string[] = [];
    for (let path = start; ; path = dirname(path)) {
      const id = await identify(path);
      if (id) ids.push(id);
      if (dirname(path) === path) return ids;
    }
  };
  const idSet = async (paths: string[]) => new Set((await Promise.all(paths.map(identify))).filter((id): id is string => !!id));
  const homeIds = await idSet(canonicalHomes);
  const protectedIds = await idSet(protectedRoots);
  // Subdirectories of the protected roots count too (bounded, links never followed): a bind mount of ~/.claude/skills somewhere
  // else has the same st_dev:st_ino as the original, so it is recognised by identity even though its path says nothing.
  const MAX_PROTECTED_DIRS = 2000;
  for (let queue = [...protectedRoots], seen = 0; queue.length && seen < MAX_PROTECTED_DIRS;) {
    const dir = queue.shift()!;
    const kids = await children(dir).catch(() => []);
    for (const kid of kids) {
      if (!kid.isDirectory() || seen >= MAX_PROTECTED_DIRS) continue;
      seen++;
      const path = join(dir, kid.name);
      const id = await identify(path);
      if (id) protectedIds.add(id);
      queue.push(path);
    }
  }
  const aboveHomeIds = new Set((await Promise.all(canonicalHomes.map(chain))).flat());
  const repoChain = await chain(canonicalRepo);
  const userRoot = canonicalHomes.some((h) => inside(canonicalRepo, h)) || protectedRoots.some((root) => inside(root, canonicalRepo))
    || (repoChain[0] !== undefined && aboveHomeIds.has(repoChain[0])) // HOME or one of its ancestors, by identity
    || repoChain.some((id) => protectedIds.has(id)); // inside ~/.claude, ~/.codex or ~/.agents, by identity
  if (userRoot && !opts.includeUser) throw new Error("User configuration roots require --include-user (allowlisted files only)");
  // Whatever the flags, a walk never enters HOME or a protected root; --include-user reads the allowlist instead.
  const pruned = async (abs: string, real: string) => {
    if (canonicalHomes.includes(real) || protectedRoots.some((root) => inside(root, real))) return true;
    const id = await identify(abs);
    return id !== null && (homeIds.has(id) || protectedIds.has(id));
  };
  let total = 0;
  let stopped = false;
  const warn = (message: string) => warnings.push(redact(message, { denylist: opts.denylist }));
  async function read(abs: string, logicalPath: string, scope: Scope, viaImport = false): Promise<RawSource | undefined> {
    if (stopped) return;
    try {
      const info = await lstat(abs);
      if (!info.isFile()) return;
      // An oversized SKILL.md still contributes its frontmatter listing: only a bounded head is read (the body is never analysed).
      const headOnly = info.size > MAX_FILE_BYTES && classify(logicalPath) === "skill-listing";
      if (info.size > MAX_FILE_BYTES && !headOnly) { warn(`${logicalPath}: over ${MAX_FILE_BYTES} bytes, skipped`); return; }
      if (total + (headOnly ? SKILL_HEAD_BYTES : info.size) > MAX_RUN_BYTES) {
        stopped = true;
        warn(`Run limit ${MAX_RUN_BYTES} bytes reached; stopped discovery`);
        return;
      }
      // Bound the actual read too, even if the file grew after lstat.
      const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
      let buf: Buffer;
      try {
        const storage = Buffer.alloc(headOnly ? SKILL_HEAD_BYTES : MAX_FILE_BYTES + 1);
        const result = await handle.read(storage, 0, storage.length, 0);
        buf = storage.subarray(0, result.bytesRead);
      } finally { await handle.close(); }
      if (!headOnly && buf.length > MAX_FILE_BYTES) { warn(`${logicalPath}: over ${MAX_FILE_BYTES} bytes, skipped`); return; }
      if (total + buf.length > MAX_RUN_BYTES) { stopped = true; warn(`Run limit ${MAX_RUN_BYTES} bytes reached; stopped discovery`); return; }
      total += buf.length;
      if (buf.includes(0)) { warn(`${logicalPath}: binary, skipped`); return; }
      // A head cut in the middle of a multi-byte character loses at most that character.
      if (headOnly) buf = Buffer.from(trimSplitChar(buf));
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
      catch { warn(`${logicalPath}: invalid UTF-8, skipped`); return; }
      if (headOnly && !headFrontmatterCloses(text)) {
        warn(`${logicalPath}: over ${MAX_FILE_BYTES} bytes and its frontmatter does not close within the first ${SKILL_HEAD_BYTES} bytes, skipped`);
        return;
      }
      const base: RawSource = { logicalPath, text, scope, ...(headOnly ? { rawBytes: info.size } : {}) };
      const source: RawSource = viaImport ? { ...base, viaImport: true } : base;
      sources.push(source);
      return source;
    } catch {
      warn(`${logicalPath}: unreadable, skipped`);
    }
  }
  async function walk(dir: string) {
    if (stopped) return;
    let entries;
    try { entries = await children(dir); }
    catch { warn(`${relative(canonicalRepo, dir)}: unreadable directory, skipped`); return; }
    for (const entry of entries) {
      if (stopped) break;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const real = await realpath(abs).catch(() => null);
        if (real === null) warn(`${relative(canonicalRepo, abs)}: unreadable directory, skipped`);
        else if (!(await pruned(abs, real))) await walk(abs);
      } else if (entry.isFile() && !/^\.env(\.|$)/.test(entry.name)) {
        const rel = relative(canonicalRepo, abs).split(sep).join("/");
        if (classify(rel)) await read(abs, rel, projectScope(rel));
      }
    }
  }
  async function allowedFile(parts: string[], viaImport = false): Promise<RawSource | undefined> {
    if (stopped) return;
    let abs = home;
    try {
      for (const [i, part] of parts.entries()) {
        abs = join(abs, part);
        const info = await lstat(abs);
        if (i < parts.length - 1 && !info.isDirectory()) return;
        if (info.isSymbolicLink()) return;
      }
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) warn(`~/${parts.join("/")}: unreadable, skipped`);
      return;
    }
    return read(abs, `~/${parts.join("/")}`, "user", viaImport);
  }
  async function allowedChildren(parts: string[], skills: boolean) {
    if (stopped) return;
    let dir = home;
    try {
      for (const part of parts) {
        dir = join(dir, part);
        if (!(await lstat(dir)).isDirectory()) return;
      }
      for (const entry of await children(dir)) {
        if (stopped) break;
        if (skills && entry.isDirectory()) await allowedFile([...parts, entry.name, "SKILL.md"]);
        if (!skills && entry.isFile() && entry.name.endsWith(".md")) await allowedFile([...parts, entry.name]);
      }
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) warn(`~/${parts.join("/")}: unreadable directory, skipped`);
    }
  }
  if (!userRoot) await walk(canonicalRepo);
  if (opts.includeUser && !stopped) {
    for (const parts of [[".claude", "CLAUDE.md"], [".claude", "settings.json"], [".codex", "AGENTS.md"], [".codex", "AGENTS.override.md"]]) await allowedFile(parts);
    await allowedChildren([".claude", "rules"], false);
    for (const name of [".claude", ".codex", ".agents"]) await allowedChildren([name, "skills"], true);
  }
  await followImports();
  return { sources, warnings: warnings.sort(compare), canonicalRepo };

  /**
   * Claude Code `@path` imports in CLAUDE.md and CLAUDE.local.md, followed to depth 8 and cycle-safe. Only files inside the
   * scanned repo root (no symlinked path component) or, with --include-user, under ~/.claude. Never absolute paths, never .env.
   * A file that is already a source is not read twice; the report records the import as an occurrence.
   */
  async function followImports() {
    const known = new Map(sources.map((s) => [s.logicalPath, s]));
    const visited = new Set<string>();
    let frontier = sources.filter((s) => /(^|\/)CLAUDE(\.local)?\.md$/.test(s.logicalPath)).sort((a, b) => compare(a.logicalPath, b.logicalPath));
    for (const s of frontier) visited.add(s.logicalPath);
    for (let level = 0; frontier.length && level < MAX_IMPORT_DEPTH && !stopped; level++) {
      const next: RawSource[] = [];
      for (const from of frontier) {
        for (const { line, spec } of extractImports(from.text)) {
          const r = resolveImport(from.logicalPath, spec, !!opts.includeUser);
          if ("skip" in r) {
            if (r.skip !== "empty" && r.skip !== "type") warn(`${from.logicalPath}:${line}: @import skipped (not an allowed location)`);
            continue;
          }
          let target = known.get(r.path);
          if (!target) {
            target = await readImport(r.path);
            if (target) known.set(r.path, target);
          }
          if (target && !visited.has(target.logicalPath)) { visited.add(target.logicalPath); next.push(target); }
        }
      }
      frontier = next;
    }
    // Files at the depth limit that still import something new: warn instead of dropping that evidence silently.
    if (frontier.length && !stopped) {
      for (const from of frontier) {
        for (const { line, spec } of extractImports(from.text)) {
          const r = resolveImport(from.logicalPath, spec, !!opts.includeUser);
          if ("skip" in r || visited.has(r.path)) continue;
          const exists = known.has(r.path) || (!r.path.startsWith("~/") && !userRoot && !!(await lstat(join(canonicalRepo, ...r.path.split("/"))).catch(() => null)));
          if (exists) { warn(`${from.logicalPath}:${line}: @import depth limit (${MAX_IMPORT_DEPTH}) reached; deeper imports were not followed`); break; }
        }
      }
    }
  }
  async function readImport(logicalPath: string): Promise<RawSource | undefined> {
    if (logicalPath.startsWith("~/")) {
      return opts.includeUser ? allowedFile(logicalPath.slice(2).split("/"), true) : undefined;
    }
    if (userRoot) return undefined; // the repo itself is not scanned when the root is a user configuration root
    const kind = classify(logicalPath);
    if (kind === "skill-listing" || kind === "settings" || kind === "mcp") return undefined;
    const abs = join(canonicalRepo, ...logicalPath.split("/"));
    const real = await realpath(abs).catch(() => null);
    // Any symlink in the path would make the real path differ: refuse it, along with anything outside the repo or in a protected root.
    if (real !== abs || !inside(canonicalRepo, real) || (await pruned(abs, real))) return undefined;
    return read(abs, logicalPath, "project", !kind);
  }
}
