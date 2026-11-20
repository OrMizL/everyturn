// Pure page logic: files in, report and poster out. No DOM, network, storage, Date or random.
// Everything analytical is packages/core, the same code the CLI runs.
import {
  AGENTS, MAX_IMPORT_DEPTH, SKILL_HEAD_BYTES, buildPosterModel, buildReport, classify, extractImports, frontmatterCloses, headFrontmatterCloses, isRootInstruction,
  posterFindings, projectScope, redact, renderPosterSvg, resolveImport, skillListing, trimSplitChar,
} from "@everyturn/core";
import type { Agent, PosterDataset, PosterFindings, PosterModel, RawSource, Report, SourceKind } from "@everyturn/core";
import { version as WEB_VERSION } from "../package.json";

export type { Agent, PosterDataset };

/** Same limits as the CLI discovery (packages/cli/src/discover.ts); a test keeps them equal. */
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_RUN_BYTES = 5 * 1024 * 1024;
/** Footer version on the poster: the CLI prints its own package version, which is kept equal to this one. */
export const ANALYZER_VERSION: string = WEB_VERSION;
export const PROFILE_VERSION = "0.1";

/**
 * The agents the page offers, in the spec's order. All five have activation rules (classify.activationOf and the
 * report's AGENTS.override.md / import handling), a poster profile (inProfile / activationIn) and tests, so none is dropped.
 */
export const AGENT_OPTIONS: readonly { value: Agent; label: string }[] = [
  { value: "claude-code", label: "Claude Code" }, { value: "codex", label: "Codex" }, { value: "cursor", label: "Cursor" },
  { value: "copilot", label: "GitHub Copilot" }, { value: "windsurf", label: "Windsurf" },
];
export const agentLabel = (agent: Agent): string => AGENT_OPTIONS.find((a) => a.value === agent)?.label ?? agent;
/**
 * Is a render that has just finished out of date? It was started under `started` (the workspace revision and the agent it was made for); `now` is
 * what the page holds when it finishes. A list change or a different agent selected meanwhile leaves the page out of date, and the poster is not claimed as current.
 */
export const staleRender = (started: { revision: number; agent: Agent }, now: { revision: number; agent: Agent }): boolean =>
  started.revision !== now.revision || started.agent !== now.agent;
export const isAgent = (value: string): value is Agent => (AGENTS as readonly string[]).includes(value);

/** A file the user supplied: where it is, how big, and how to read its bytes later (a File handle in the browser). */
export interface Candidate {
  path: string;
  size: number;
  /** Bytes of the file; `max` asks for only the first `max` bytes (an oversized SKILL.md's head). */
  read: (max?: number) => Promise<Uint8Array>;
  /** Picked or dropped as a file (a reason is shown when it is not usable). Folder contents are filtered silently. */
  direct: boolean;
  /** Set only by the bundled sample's own candidates (sample.ts). */
  sample?: true;
}
/** `size` is the bytes read (what counts against the run limit); `rawBytes` is the file's own size when only its head was read. */
export interface InputFile { path: string; text: string; size: number; rawBytes?: number }

/** One row of the file list. `skip` is the reason shown in place of the kind; `note` is a muted remark on a usable row. */
export interface Row { path: string; size: number; kind: string; skip?: string; note?: string }

/** Shown on a SKILL.md row over the file cap: the CLI reads only its head too. */
export const HEAD_NOTE = `read first ${SKILL_HEAD_BYTES / 1024} KiB`;
/** An oversized SKILL.md is read up to its first SKILL_HEAD_BYTES instead of being skipped (same rule as the CLI). */
export const isHeadOnly = (path: string, size: number): boolean => size > MAX_FILE_BYTES && classify(path) === "skill-listing";

export const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".vercel", "coverage"]);
const isEnv = (path: string) => /^\.env/i.test(path.split("/").pop() ?? "");

/** Repo-relative logical path from user text or a picker path. Null when it is absolute, climbs out, or is empty. */
export function normalizePath(raw: string): string | null {
  let p = raw.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (!p || p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:/.test(p) || p.includes("\0")) return null;
  if (p.split("/").some((s) => s === ".." || s === "." || s === "")) return null;
  return p;
}

/** webkitRelativePath / dropped-folder path: the first segment is the chosen folder's own name, not part of the repo. */
export const stripPickedRoot = (relativePath: string): string => {
  const parts = relativePath.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : relativePath;
};

/** True when the path is somewhere a scan never looks (the CLI walk's skipped directories). */
export const inSkippedDirectory = (path: string): boolean => path.split("/").slice(0, -1).some((s) => SKIPPED_DIRS.has(s));

const KIND_NAME: Record<SourceKind, string> = {
  "claude-md": "instructions", "claude-local-md": "instructions", "agents-md": "instructions", "copilot-instructions": "instructions",
  "windsurf-rules": "instructions", "claude-import": "instructions", "cursor-rule": "rule", "claude-rule": "rule",
  "skill-listing": "skill", settings: "settings", mcp: "MCP servers",
};
export const kindName = (path: string): string => { const k = classify(path); return k ? KIND_NAME[k] : "file"; };

export const fmt = (n: number): string => n.toLocaleString("en-US");
export const plural = (n: number, word: string): string => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;
/** `780 B`, `402.3 KiB`, `1.2 MiB`. */
export function formatSize(n: number): string {
  if (n < 1024) return `${fmt(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/** 1-based line of the first JSON syntax error, or null when the text parses. Engine-independent (V8 messages vary). */
export function jsonErrorLine(text: string): number | null {
  try { JSON.parse(text); return null; } catch { /* locate it below */ }
  let i = 0;
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i]!)) i++; };
  const literal = (word: string) => { if (!text.startsWith(word, i)) throw i; i += word.length; };
  const string = () => {
    i++;
    for (;;) {
      const c = text[i];
      if (c === undefined || c < " ") throw i;
      i++;
      if (c === '"') return;
      if (c === "\\") i++;
    }
  };
  const value = (depth: number): void => {
    if (depth > 200) throw i;
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++; ws();
      if (text[i] === close) { i++; return; }
      for (;;) {
        ws();
        if (c === "{") {
          if (text[i] !== '"') throw i;
          string(); ws();
          if (text[i] !== ":") throw i;
          i++;
        }
        value(depth + 1); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === close) { i++; return; }
        throw i;
      }
    }
    if (c === '"') return string();
    if (c === "t") return literal("true");
    if (c === "f") return literal("false");
    if (c === "n") return literal("null");
    const num = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    num.lastIndex = i;
    const m = num.exec(text);
    if (!m) throw i;
    i += m[0].length;
  };
  let offset = text.length;
  try { value(0); ws(); if (i < text.length) offset = i; } catch (e) { offset = typeof e === "number" ? e : 0; }
  const at = Math.min(offset, text.trimEnd().length);
  return text.slice(0, at).split("\n").length;
}

/** Reason a file can be rejected from its name and size alone, before a byte is read; undefined when it may be read. */
export function precheck(path: string, size: number, direct: boolean): string | undefined {
  if (isEnv(path)) return ".env is never read";
  if (classify(path) === null) return direct ? "not an instruction file" : undefined;
  if (size > MAX_FILE_BYTES && !isHeadOnly(path, size)) return "over 256 KiB";
  return undefined;
}

/**
 * `dropped` is a SKILL.md that was read but has no listing (no name): the CLI hands it to buildReport, which skips it with its own warning,
 * so the page does the same (the row shows the skip; the report says why).
 */
export type Ingested = { file: InputFile } | { skipped: string; warning?: string; dropped?: InputFile };

export const NO_NAME = "no name in front matter";

/**
 * Apply the CLI's read rules to raw bytes (size cap, no NUL, valid UTF-8), then the page's own: JSON and frontmatter must read.
 * `fullSize` is the file's size when `bytes` is only its head (an oversized SKILL.md): the head is trimmed at a character
 * boundary and its frontmatter must close inside it, exactly as in the CLI.
 */
export function ingestBytes(path: string, bytes: Uint8Array, fullSize = bytes.length): Ingested {
  const early = precheck(path, fullSize, true);
  if (early) return { skipped: early };
  const head = isHeadOnly(path, fullSize);
  const read = head ? bytes.subarray(0, SKILL_HEAD_BYTES) : bytes;
  if (read.includes(0)) return { skipped: "not UTF-8 text" };
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(head ? trimSplitChar(read) : read); }
  catch { return { skipped: "not UTF-8 text" }; }
  if (head) {
    if (!headFrontmatterCloses(text)) {
      return { skipped: "frontmatter unreadable", warning: `${path}: over ${MAX_FILE_BYTES} bytes and its frontmatter does not close within the first ${SKILL_HEAD_BYTES} bytes, skipped` };
    }
    const file: InputFile = { path, text, size: read.length, rawBytes: fullSize };
    return skillListing(text) === null ? { skipped: NO_NAME, dropped: file } : { file };
  }
  const kind = classify(path);
  if (kind === "settings" || kind === "mcp") {
    const line = jsonErrorLine(text);
    if (line !== null) return { skipped: `invalid JSON, line ${line}` };
  }
  const file: InputFile = { path, text, size: bytes.length };
  if (kind === "skill-listing" && skillListing(text) === null) {
    // Frontmatter that opens but never closes is unreadable; anything else without a name (none at all, or an empty block) is just nameless.
    return { skipped: /^﻿?---[ \t]*\r?\n/.test(text) && !frontmatterCloses(text) ? "frontmatter unreadable" : NO_NAME, dropped: file };
  }
  return { file };
}

/** A row for a file that was read: its own size, and the head note when only the head was read. */
const usableRow = (file: InputFile, kind: string): Row => ({ path: file.path, size: file.rawBytes ?? file.size, kind, ...(file.rawBytes === undefined ? {} : { note: HEAD_NOTE }) });

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The CLI's own warning wording for the three read failures it reports (so same inputs give the same JSON). */
const cliWarning = (path: string, reason: string): string | undefined =>
  reason === "over 256 KiB" ? `${path}: over ${MAX_FILE_BYTES} bytes, skipped` : reason === "not UTF-8 text" ? `${path}: invalid UTF-8, skipped` : undefined;

/**
 * Everything the user has added: the list rows (usable and skipped), the usable files' text, and files from folder
 * drops that are not instruction sources (kept as handles, read only if CLAUDE.md `@imports` them).
 */
export class Workspace {
  rows: Row[] = [];
  private files = new Map<string, InputFile>();
  /** Nameless SKILL.md files: skipped rows, but still passed to the report so its warning matches the CLI's. */
  private dropped = new Map<string, InputFile>();
  private extras = new Map<string, Candidate>();
  /** Reasons that CLI discovery would put in the report warnings. */
  private warnings = new Map<string, string>();

  get usable(): number { return this.files.size; }
  get skipped(): number { return this.rows.length - this.files.size; }
  get usableBytes(): number { let n = 0; for (const f of this.files.values()) n += f.size; return n; }

  /**
   * Workspace generation. `clear()` (which `loadSample` starts with) moves it on; an `add()` that began under an older generation drops
   * the reads still in flight when it finds that out, so a slow folder read can never land in a workspace that was cleared or replaced
   * by the sample after the read started.
   */
  generation = 0;
  /** Moves on every change of the list (added, replaced, removed, cleared): a render that began under an older revision is out of date. */
  revision = 0;
  /** Bytes of reads in flight that passed the run limit but are not stored yet: overlapping adds count them, so they cannot together pass the cap. */
  private reserved = 0;
  /** Which paths came from the bundled sample (rows, and unclassified files kept for imports). */
  private fromSample = new Set<string>();
  private extraFromSample = new Set<string>();

  /**
   * True only when the workspace is the bundled sample: it has files and every one of them (rows and import-only extras) was added from the
   * sample. Derived from the contents, never a flag set by the caller: a pasted file, a dropped file, or any replacement of a sample file makes it false.
   */
  get sample(): boolean {
    return this.rows.length > 0 && this.rows.every((r) => this.fromSample.has(r.path)) && [...this.extras.keys()].every((p) => this.extraFromSample.has(p));
  }

  /** A change that is not in the list but still makes a render in flight out of date (the selected agent changed): advances the revision. */
  touch(): void {
    this.revision++;
  }

  clear(): void {
    this.generation++;
    this.revision++;
    this.rows = []; this.files.clear(); this.dropped.clear(); this.extras.clear(); this.warnings.clear(); this.fromSample.clear(); this.extraFromSample.clear();
  }

  remove(path: string): void {
    this.revision++;
    this.rows = this.rows.filter((r) => r.path !== path);
    this.files.delete(path);
    this.dropped.delete(path);
    this.warnings.delete(path);
    this.fromSample.delete(path);
  }

  /**
   * The list in display order: always-loaded instruction files at the repo root (CLAUDE.md, AGENTS.md and the other agents' root files;
   * derived from core's activation rules, never from the selected agent) first, then everything else; each group sorted by path. Files in
   * folders (.github/copilot-instructions.md) and skipped files (no text) fall in the second group.
   */
  orderedRows(): Row[] {
    const top = new Set(this.rows.filter((r) => { const f = this.files.get(r.path); return f !== undefined && !r.path.includes("/") && isRootInstruction(r.path, f.text); }).map((r) => r.path));
    return [...this.rows].sort((a, b) => Number(top.has(b.path)) - Number(top.has(a.path)) || compare(a.path, b.path));
  }

  private put(row: Row, file?: InputFile, warning?: string, sample = false, dropped?: InputFile): void {
    this.remove(row.path);
    this.rows.push(row);
    if (sample) this.fromSample.add(row.path);
    if (file) this.files.set(file.path, file);
    else if (dropped) this.dropped.set(dropped.path, dropped);
    else { const w = warning ?? cliWarning(row.path, row.skip ?? ""); if (w) this.warnings.set(row.path, w); }
  }

  /** Add one pasted file. Field errors name the field; a bad type or content becomes a skipped row like any other. */
  addText(rawPath: string, text: string): { error: "path" | "text" } | { replaced: boolean; overLimit: boolean } {
    const path = normalizePath(rawPath);
    if (path === null) return { error: "path" };
    if (!text.trim()) return { error: "text" };
    const bytes = new TextEncoder().encode(text);
    const replaced = this.rows.some((r) => r.path === path);
    const early = precheck(path, bytes.length, true);
    if (early) { this.put({ path, size: bytes.length, kind: kindName(path), skip: early }); return { replaced, overLimit: false }; }
    const others = this.usableBytes + this.reserved - (this.files.get(path)?.size ?? 0);
    if (others + (isHeadOnly(path, bytes.length) ? SKILL_HEAD_BYTES : bytes.length) > MAX_RUN_BYTES) return { replaced: false, overLimit: true };
    const got = ingestBytes(path, bytes);
    if ("skipped" in got) this.put({ path, size: bytes.length, kind: kindName(path), skip: got.skipped }, undefined, got.warning, false, got.dropped);
    else this.put(usableRow(got.file, kindName(path)), got.file);
    return { replaced, overLimit: false };
  }

  /**
   * Add files from pickers and drops, in path order. Stops at the run limit (that file and the rest are not added).
   * `gen` is the generation the caller saw when the user acted (the drop or picker event): a folder that took a while to walk is dropped when the
   * workspace was cleared or replaced since. Default: the generation now.
   */
  async add(candidates: readonly Candidate[], gen: number = this.generation): Promise<{ added: number; replaced: string[]; overLimit: boolean; stale?: true }> {
    if (gen !== this.generation) return { added: 0, replaced: [], overLimit: false, stale: true };
    let added = 0;
    const replaced: string[] = [];
    const list = candidates.flatMap((c) => { const path = normalizePath(c.path); return path === null || (!c.direct && inSkippedDirectory(path)) ? [] : [{ ...c, path }]; })
      .sort((a, b) => compare(a.path, b.path));
    for (const c of list) {
      const kind = kindName(c.path);
      const sample = c.sample === true;
      const early = precheck(c.path, c.size, c.direct);
      if (early) { this.put({ path: c.path, size: c.size, kind, skip: early }, undefined, undefined, sample); added++; continue; }
      if (classify(c.path) === null) { this.revision++; this.extras.set(c.path, c); if (sample) this.extraFromSample.add(c.path); else this.extraFromSample.delete(c.path); continue; }
      const head = isHeadOnly(c.path, c.size);
      const need = head ? SKILL_HEAD_BYTES : c.size;
      const existing = () => this.files.get(c.path)?.size ?? 0;
      // Reads in flight count against the cap (reserved before the await, released after it), so overlapping adds cannot together pass it.
      if (this.usableBytes + this.reserved - existing() + need > MAX_RUN_BYTES) return { added, replaced, overLimit: true };
      if (this.rows.some((r) => r.path === c.path)) replaced.push(c.path);
      let bytes: Uint8Array | undefined;
      this.reserved += need;
      try { bytes = await c.read(head ? SKILL_HEAD_BYTES : undefined); } catch { bytes = undefined; } finally { this.reserved -= need; }
      // The workspace was cleared or replaced while this file was being read: the read belongs to a workspace that no longer exists.
      if (gen !== this.generation) return { added, replaced, overLimit: false, stale: true };
      if (!bytes) { this.put({ path: c.path, size: c.size, kind, skip: "couldn’t be read" }, undefined, undefined, sample); added++; continue; }
      // Checked again at the commit, with what was really read.
      if (this.usableBytes - existing() + bytes.length > MAX_RUN_BYTES) return { added, replaced, overLimit: true };
      const got = ingestBytes(c.path, bytes, c.size);
      if ("skipped" in got) this.put({ path: c.path, size: c.size, kind, skip: got.skipped }, undefined, got.warning, sample, got.dropped);
      else this.put(usableRow(got.file, kind), got.file, undefined, sample);
      added++;
    }
    return { added, replaced, overLimit: false };
  }

  /**
   * Claude Code `@path` imports among files that are not instruction sources themselves (docs/style.md imported by
   * CLAUDE.md). Same resolver and depth as the CLI; such a file is read only when imported.
   */
  async prepare(): Promise<{ files: InputFile[]; imported: InputFile[]; warnings: string[]; read: number; gen: number }> {
    // Everything comes from a snapshot taken before the first await, and `gen` is the generation it belongs to: a Clear (or the sample) while the
    // imports are being read cannot mix an old import into a new workspace, and the caller can tell that the result is out of date.
    const gen = this.generation;
    const files = new Map(this.files);
    const extras = new Map(this.extras);
    const dropped = [...this.dropped.values()];
    const warnings = [...this.warnings.values()];
    const known = new Map(files);
    const imported: InputFile[] = [];
    const tried = new Set<string>();
    let total = this.usableBytes;
    let frontier = [...files.values()].filter((f) => { const k = classify(f.path); return k === "claude-md" || k === "claude-local-md"; }).sort((a, b) => compare(a.path, b.path));
    const seen = new Set(frontier.map((f) => f.path));
    for (let level = 0; frontier.length && level < MAX_IMPORT_DEPTH; level++) {
      const next: InputFile[] = [];
      for (const f of frontier) {
        for (const { spec } of extractImports(f.text)) {
          const r = resolveImport(f.path, spec, false);
          if (!("path" in r) || tried.has(r.path)) continue;
          tried.add(r.path);
          let target = known.get(r.path);
          const candidate = extras.get(r.path);
          if (!target && candidate && candidate.size <= MAX_FILE_BYTES && total + candidate.size <= MAX_RUN_BYTES) {
            const bytes = await candidate.read().catch(() => undefined);
            if (bytes && !bytes.includes(0)) {
              total += bytes.length;
              try { target = { path: r.path, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), size: bytes.length }; } catch { target = undefined; }
              if (target) { known.set(r.path, target); imported.push(target); }
            }
          }
          if (target && !seen.has(target.path)) { seen.add(target.path); next.push(target); }
        }
      }
      frontier = next;
    }
    return { files: [...files.values(), ...dropped].sort((a, b) => compare(a.path, b.path)), imported, warnings, read: files.size, gen };
  }
}

export function toRawSources(files: readonly InputFile[], imported: readonly InputFile[] = []): RawSource[] {
  return [
    ...files.map((f): RawSource => ({ logicalPath: f.path, text: f.text, scope: projectScope(f.path), ...(f.rawBytes === undefined ? {} : { rawBytes: f.rawBytes }) })),
    // An unclassified file only counts if an instruction file imports it; buildReport drops it otherwise.
    ...imported.filter((f) => classify(f.path) === null).map((f): RawSource => ({ logicalPath: f.path, text: f.text, scope: projectScope(f.path), viaImport: true })),
  ];
}

/** Badge, same logic as the CLI without a denylist: the bundled sample is a sample setup; anything else is unreviewed. */
export const datasetFor = (sample: boolean): PosterDataset => (sample ? "SAMPLE SETUP" : "UNREVIEWED REAL SET");

export interface FindingChoice {
  id: string;
  group: "conflict" | "duplicate";
  /** `CLAUDE.md:13 ≠ AGENTS.md:6` or `×3 · CLAUDE.md:4, AGENTS.md:5, general.mdc:5`. */
  label: string;
}

export interface AnalyzeInput {
  files: readonly InputFile[];
  imported?: readonly InputFile[];
  agent: Agent;
  /** True only while the bundled sample is loaded, untouched. */
  sample: boolean;
  warnings?: readonly string[];
  /** Id of the finding shown on the poster (see FindingChoice.id). Default: the first. */
  choice?: string;
}

export interface Analysis {
  agent: Agent;
  dataset: PosterDataset;
  report: Report;
  choices: FindingChoice[];
  selected: string | undefined;
  model: PosterModel;
  /** Source SVG with <text>; identical to the CLI's `everyturn.source.svg` for the same inputs. */
  svg: string;
  /** Hero numbers, as drawn on the poster. */
  hero: { tokens: number; sources: number; conflicts: number; duplicates: number };
  alt: string;
}

const ref = (r: { path: string; line: number }) => `${r.path}:${r.line}`;
const clip = (s: string, n: number) => { const a = Array.from(s); return a.length > n ? `${a.slice(0, n - 1).join("").trimEnd()}…` : s; };
const MAX_REFS = 3;

export function analyze(input: AnalyzeInput): Analysis {
  const dataset = datasetFor(input.sample);
  const report = buildReport(toRawSources(input.files, input.imported), {
    warnings: [...(input.warnings ?? [])], findings: true, dataset: dataset === "SAMPLE SETUP" ? "sample" : "real",
  });
  // Always defined: detection is on.
  const base: PosterFindings = posterFindings(report, input.agent) ?? { conflicts: [], duplicates: [] };
  const conflicts = base.conflicts.filter((c) => c.confidence !== "low" && !c.override);
  const choices: FindingChoice[] = [
    ...conflicts.map((c, i): FindingChoice => ({ id: `c${i}`, group: "conflict", label: `${ref(c.a.ref)} ≠ ${ref(c.b.ref)}` })),
    ...base.duplicates.map((d, i): FindingChoice => ({
      id: `d${i}`, group: "duplicate",
      label: `${d.similarity === undefined ? `×${d.refs.length}` : `≈${d.similarity.toFixed(2)}`} · ${d.refs.slice(0, MAX_REFS).map(ref).join(", ")}${d.refs.length > MAX_REFS ? ` +${d.refs.length - MAX_REFS}` : ""}`,
    })),
  ];
  const selected = choices.some((c) => c.id === input.choice) ? input.choice : choices[0]?.id;
  // The chosen finding goes first in its list: the poster highlights the first conflict and the first duplicate group.
  // Choices index the shown conflicts (no low confidence, no overrides), so pick by identity, not by position in base.
  const first = <T>(list: T[], item: T | undefined): T[] => (item === undefined || list[0] === item ? list : [item, ...list.filter((x) => x !== item)]);
  const index = selected ? Number(selected.slice(1)) : 0;
  const findings: PosterFindings = {
    ...base,
    conflicts: selected?.startsWith("c") ? first(base.conflicts, conflicts[index]) : base.conflicts,
    duplicates: selected?.startsWith("d") ? first(base.duplicates, base.duplicates[index]) : base.duplicates,
  };
  const model = buildPosterModel(report, { agent: input.agent, dataset, version: ANALYZER_VERSION, findings });
  const svg = renderPosterSvg(model);
  const hero = { tokens: model.totals.tokens, sources: model.totals.sources, conflicts: conflicts.length, duplicates: base.duplicates.length };
  const top = model.rows.find((r) => r.kind === "source");
  const top1 = findings.conflicts[0];
  const said = (q: { text: string; withheld?: boolean }) => (q.withheld || !q.text ? "text withheld" : `“${clip(q.text, 80)}”`);
  const alt = redact([
    `Poster for ${agentLabel(input.agent)}: about ${hero.tokens} estimated tokens from ${plural(hero.sources, "always-loaded source")}, before you type anything.`,
    top ? `Largest source ${top.label}, about ${top.tokens} tokens.` : "",
    `${plural(hero.conflicts, "possible conflict")}, ${plural(hero.duplicates, "duplicate")}.`,
    model.totals.listed ? `${plural(model.totals.listed, "more file")} found, not counted.` : "",
    top1 ? `Highlighted: ${top1.a.ref.path} line ${top1.a.ref.line} says ${said(top1.a)}; ${top1.b.ref.path} line ${top1.b.ref.line} says ${said(top1.b)}.` : "",
  ].filter(Boolean).join(" ")).replace(/\s+/g, " ");
  return { agent: input.agent, dataset, report, choices, selected, model, svg, hero, alt };
}

/** The same JSON the CLI writes to everyturn.json. */
export const reportJson = (report: Report): string => JSON.stringify(report, null, 2) + "\n";

export interface Alert { title: string; body: string }

/** The summary under the file list for skipped files (null when everything added is usable). */
export function skipSummary(total: number, usable: number): Alert | null {
  const skipped = total - usable;
  if (skipped === 0) return null;
  if (usable === 0) {
    return {
      title: total === 1 ? "This file can’t be used." : `None of these ${total} files can be used.`,
      body: "The reason is next to each one. Remove them, then add CLAUDE.md, AGENTS.md, a rule, a skill or a settings file.",
    };
  }
  return { title: `${skipped} of ${total} files skipped.`, body: `The reason is next to each one. The poster will use the other${usable === 1 ? "" : ` ${usable}`}.` };
}

export const ALERTS = {
  nothing: { title: "Nothing to render yet.", body: "Drop your repo folder, or try the sample setup." },
  tooBig: { title: "That would pass 5 MiB in all.", body: "Remove some files first." },
  noRenderer: { title: "The renderer didn’t load.", body: "Reload the page. Nothing you added was sent anywhere." },
  threw: { title: "The poster couldn’t be drawn.", body: "Your files are still here. Try Render poster again." },
} satisfies Record<string, Alert>;

const POSTER_READY = "Poster ready.";

export const STATUS = {
  loading: "Getting the renderer ready…",
  ready: (n: number) => `${plural(n, "file")} ready.`,
  rendering: (n: number) => `Rendering ${plural(n, "file")}…`,
  done: (usable: number, total: number) => (usable === total ? `Rendered ${plural(usable, "file")}.` : `Rendered ${usable} of ${total} files. ${total - usable} skipped.`),
  /** The done line plus "Poster ready.", for a render the user asked for (focus moves to the poster). */
  doneReady: (usable: number, total: number) => `${STATUS.done(usable, total)} ${POSTER_READY}`,
  saved: (name: string) => `Saved ${name}.`,
  replaced: (path: string) => `Replaced ${path}.`,
  agentChanged: "Agent changed. Render again to update.",
};

/** After a render the user asked for, focus goes to the "Poster" heading and the page jumps there: never a smooth scroll. */
export const POSTER_SCROLL = { block: "start", behavior: "instant" } as const;

/** Mono label above the frame, left: what the frame shows. A render of anything but the pure sample (a mixed workspace included) is the user's own files. */
export const FRAME_LABEL = { sample: "Sample · synthetic data", own: "Your files · redacted" } as const;
export const frameLabel = (rendered: { sample: boolean } | undefined): string => (rendered && !rendered.sample ? FRAME_LABEL.own : FRAME_LABEL.sample);

/** Caption above the frame, right, after a render: files read (usable) and the always-loaded sources the poster counts. Numbers are mono-spanned by the page. */
export const frameCaption = (read: number, sources: number): string => `${plural(read, "file")} read · ${plural(sources, "source")}`;

/** "13 files · 2,798 bytes": usable files only. */
export const countLabel = (ws: Workspace): string => `${plural(ws.rows.length, "file")} · ${ws.usable ? `${fmt(ws.usableBytes)} bytes` : "none usable"}`;
