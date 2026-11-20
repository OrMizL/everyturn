import { activationOf, agentFor, classify, KIND_LABEL } from "./classify";
import { configSummary } from "./configSummary";
import { countFindings, detectFindings, settingsLayer, type SettingsInput } from "./findings";
import { extractImports, MAX_IMPORT_DEPTH, resolveImport } from "./imports";
import { redact, type Denylist } from "./redact";
import { ESTIMATOR, measure } from "./size";
import { listingLine, maskUserSkillDirs, skillListing } from "./skills";
import { AGENTS, type Activation, type RawSource, type Report, type Source, type SourceKind } from "./types";

// 1.1.0 added Source.activation; 1.2.0 adds Source.importedBy, findings and findingCounts;
// 1.3.0 adds the "inactive" Activation, Finding.crossAgent and findingCounts.headline.overrides.
export const SCHEMA_VERSION = "1.3.0";
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Kinds whose text is instruction text: the only kinds a Claude Code import can pull into the profile. */
const TEXT_KINDS = new Set<SourceKind>(["claude-md", "claude-local-md", "agents-md", "cursor-rule", "copilot-instructions", "windsurf-rules", "claude-rule", "claude-import"]);

export interface ReportOptions {
  denylist?: Denylist;
  warnings?: string[];
  /** Show MCP server names and other user-chosen names in config summaries. Default: aliases and counts. */
  showNames?: boolean;
  /** Run finding detection (default true). `false` leaves `findings` empty and `findingCounts.checked` false. */
  findings?: boolean;
  /** "sample" disables the private-identifier snippet check (synthetic fixtures only). Default "real". */
  dataset?: "sample" | "real";
  /** Imports are resolved among the given sources; this decides whether `~/.claude/...` imports count. */
  includeUser?: boolean;
}

interface Entry {
  source: Source; originalPath: string; text: string; imports: { to: Entry; line: number }[]; reached: Activation | null;
  /** Unredacted text the source represents (instructions, or a skill's listing line). Matched in memory only, never exported. */
  matchText: string;
}

/**
 * Resolve `@path` imports among the discovered sources (depth <= MAX_IMPORT_DEPTH, cycle-safe). Roots are CLAUDE.md and
 * CLAUDE.local.md files; an imported file takes its importer's activation inside the Claude Code profile.
 * `warn` hears about the files whose imports the depth limit left unfollowed.
 */
function resolveImports(entries: Entry[], includeUser: boolean, warn: (message: string) => void): void {
  const byPath = new Map(entries.map((e) => [e.originalPath, e]));
  const edges = (e: Entry) => {
    const found: { to: Entry; line: number }[] = [];
    for (const { line, spec } of extractImports(e.text)) {
      const r = resolveImport(e.originalPath, spec, includeUser);
      const to = "path" in r ? byPath.get(r.path) : undefined;
      if (to && to !== e && TEXT_KINDS.has(to.source.kind)) found.push({ to, line });
    }
    return found;
  };
  const roots = entries.filter((e) => e.source.kind === "claude-md" || e.source.kind === "claude-local-md");
  // Two passes so "always" wins over "nested" for a file reachable both ways.
  for (const activation of ["always", "nested"] as const) {
    const start = roots.filter((r) => r.source.activation === activation).sort((a, b) => compare(a.originalPath, b.originalPath));
    const depth = new Map<Entry, number>(start.map((r) => [r, 0]));
    let frontier = start;
    for (let level = 0; frontier.length && level < MAX_IMPORT_DEPTH; level++) {
      const next: Entry[] = [];
      for (const e of frontier) {
        e.imports = e.imports.length ? e.imports : edges(e);
        for (const { to } of e.imports) {
          if (!depth.has(to)) { depth.set(to, level + 1); next.push(to); }
        }
      }
      frontier = next;
    }
    // Files at the depth limit whose own imports would reach something new: say so instead of dropping the evidence silently.
    for (const e of frontier) {
      e.imports = e.imports.length ? e.imports : edges(e);
      if (e.imports.some(({ to }) => !depth.has(to))) warn(`${e.source.logicalPath}: @import depth limit (${MAX_IMPORT_DEPTH}) reached; deeper imports were not followed`);
    }
    for (const e of depth.keys()) if (e.reached === null || activation === "always") e.reached = activation;
  }
}

/**
 * Size safe summaries/listings or instruction text, then redact every exported string.
 * The second argument is either the discovery warnings (legacy form) or options.
 */
export function buildReport(raw: RawSource[], options: string[] | ReportOptions = {}): Report {
  const opts: ReportOptions = Array.isArray(options) ? { warnings: options } : options;
  const { denylist, showNames, warnings: discoveryWarnings = [] } = opts;
  const scrub = (s: string) => redact(s, { denylist });
  const warnings = [...discoveryWarnings];
  // A user-level skill's directory is shown only when it IS the skill's name and that name survives the denylist and redaction unchanged.
  const shownPath = (path: string, listingName: string | null) =>
    maskUserSkillDirs(path, (dir) => listingName !== null && dir === listingName && /^[A-Za-z0-9._-]+$/.test(dir) && scrub(dir) === dir);
  const entries: Entry[] = [];
  for (const r of raw) {
    const kind = classify(r.logicalPath) ?? (r.viaImport ? "claude-import" : null);
    if (!kind) continue;
    let represented = r.text;
    let label: string = KIND_LABEL[kind];
    let represents: Source["represents"] = "instructions";
    let listingName: string | null = null;
    if (kind === "mcp" || kind === "settings") {
      const summary = configSummary(r.text, kind, { denylist, showNames });
      represented = summary.text;
      represents = "config-summary";
      if (summary.warning) warnings.push(`${r.logicalPath}: ${summary.warning}`);
    } else if (kind === "skill-listing") {
      const l = skillListing(r.text);
      if (!l) {
        warnings.push(`${r.logicalPath}: SKILL.md without name frontmatter, skipped`);
        continue;
      }
      represented = listingLine(l);
      listingName = l.name;
      label = `Skill: ${l.name}`;
      represents = "skill-listing";
    }
    entries.push({ originalPath: r.logicalPath, text: r.text, matchText: represented, imports: [], reached: null, source: {
      id: "", kind, agent: agentFor(kind, r.logicalPath), represents,
      label: scrub(label), logicalPath: scrub(shownPath(r.logicalPath, listingName)), scope: r.scope, activation: kind === "claude-import" ? "nested" : activationOf(kind, r.scope, r.logicalPath, r.text),
      importedBy: [], represented: scrub(represented), rawBytes: r.rawBytes ?? measure(r.text).bytes, ...measure(represented),
    } });
  }
  // Codex loads ONE file per directory: AGENTS.override.md wins over AGENTS.md. The shadowed AGENTS.md is listed, not counted.
  const overridden = new Set(entries.filter((e) => /(^|\/)AGENTS\.override\.md$/.test(e.originalPath)).map((e) => e.originalPath.replace(/AGENTS\.override\.md$/, "")));
  for (const e of entries) {
    if (e.source.kind === "agents-md" && /(^|\/)AGENTS\.md$/.test(e.originalPath) && overridden.has(e.originalPath.replace(/AGENTS\.md$/, ""))) e.source.activation = "inactive";
  }
  const importWarnings = new Set<string>();
  resolveImports(entries, !!opts.includeUser, (m) => importWarnings.add(m));
  warnings.push(...[...importWarnings].sort(compare));
  // A file only an import could have reached, with no importer in the scan, is in no profile: leave it out.
  const kept = entries.filter((e) => e.source.kind !== "claude-import" || e.reached !== null);
  for (const e of kept) {
    if (e.reached === null) continue;
    if (e.source.agent === "claude-code") { if (e.reached === "always") e.source.activation = "always"; }
    else e.source.claudeActivation = e.reached;
    if (e.source.kind === "claude-import") e.source.activation = e.reached;
  }
  kept.sort((a, b) => b.source.bytes - a.source.bytes || compare(a.originalPath, b.originalPath));
  kept.forEach((e, i) => { e.source.id = `s${i + 1}`; });
  const keptSet = new Set(kept);
  for (const e of kept) {
    for (const { to, line } of e.imports) if (keptSet.has(to) && !to.source.importedBy.some((r) => r.by === e.source.id && r.line === line)) to.source.importedBy.push({ by: e.source.id, line });
  }
  const sources = kept.map((e) => ({ ...e.source, importedBy: [...e.source.importedBy].sort((a, b) => compare(a.by, b.by) || a.line - b.line) }));
  // Imported files only exist in the Claude profile through their importers: reachability requires an importer in the scan.
  const totals = sources.reduce(
    (t, s) => ({ sources: t.sources + 1, bytes: t.bytes + s.bytes, chars: t.chars + s.chars, estTokens: t.estTokens + s.estTokens }),
    { sources: 0, bytes: 0, chars: 0, estTokens: 0 },
  );
  const byAgent: Report["byAgent"] = {};
  for (const agent of AGENTS) {
    const own = sources.filter((s) => s.agent === agent);
    if (own.length) byAgent[agent] = own.reduce((t, s) => ({ sources: t.sources + 1, bytes: t.bytes + s.bytes, estTokens: t.estTokens + s.estTokens }), { sources: 0, bytes: 0, estTokens: 0 });
  }
  // Findings: rules are matched on the RAW text in memory (so denylisted names do not collapse into one "[redacted]" and invent
  // a conflict); evidence excerpts are redacted and safety-checked before they leave detection. Settings facts come from
  // the raw JSON and are never exported as such.
  const detect = opts.findings !== false;
  const texts = new Map(kept.map((e) => [e.source.id, e.matchText]));
  const settings: SettingsInput[] = [];
  for (const e of kept) {
    if (e.source.kind !== "settings") continue;
    const layer = settingsLayer(e.originalPath, e.source.scope);
    if (layer) settings.push({ sourceId: e.source.id, layer, text: e.text });
  }
  const findings = detect ? detectFindings({ sources }, { denylist, dataset: opts.dataset, settings, texts, warn: (m) => warnings.push(m) }) : [];
  return {
    schemaVersion: SCHEMA_VERSION, estimator: ESTIMATOR, totals, byAgent, sources, findings, findingCounts: countFindings(findings, detect),
    // Warnings name files before their skill is known: a user skill's directory is never shown in them.
    warnings: warnings.map((w) => scrub(maskUserSkillDirs(w))).sort(compare),
  };
}
