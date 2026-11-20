import { DENY_TOKEN, redact, type Denylist } from "./redact";
import { light as t, poster as P } from "./theme";
import { AGENT_NAME, activationIn, inProfile } from "./profile";
import type { Activation, Agent, Report, Source, SourceKind } from "./types";

// Poster layout follows the design spec. Pure: no fs, env, Date or random.
//
// Denylisted names arrive as the literal "[redacted]" in every string. The model keeps that literal
// (rows, meta, items), and renderPosterSvg draws it as a solid ink bar instead of text, everywhere:
// labels, paths, eyebrow and wrapped rule text alike, because each wrapped line is its own text item
// and is split into text spans and bars at render time. Cap-height bars keep the redaction visible
// without spelling anything out.

export const POSTER_AGENT_LABEL: Record<Agent, string> = AGENT_NAME;
export type PosterDataset = "SAMPLE SETUP" | "REDACTED REAL SET" | "UNREVIEWED REAL SET";

export interface PosterRef { path: string; line: number }
/** `withheld`: the snippet failed the privacy check, so only path:line is drawn and the card says "text withheld (privacy)". */
export interface PosterQuote { text: string; ref: PosterRef; withheld?: boolean }
/** The first conflict is the highlighted one; the list is every medium/high conflict in the profile (it feeds the badge count). Low confidence is never shown. */
export interface PosterConflict {
  a: PosterQuote;
  b: PosterQuote;
  confidence: "high" | "medium" | "low";
  /** Precedence note: "likely wins: <path> (<reason>)" or "which one wins is unknown". */
  note: string;
  /** Labels the badge SETTING CONFLICT instead of POSSIBLE CONFLICT. */
  setting?: boolean;
  /** Likely intentional override: the badge is outlined instead of filled. */
  override?: boolean;
}
export interface PosterDuplicate { text: string; refs: PosterRef[]; /** 0..1; set for near-duplicates. */ similarity?: number; withheld?: boolean }
export interface PosterFindings {
  conflicts: PosterConflict[];
  duplicates: PosterDuplicate[];
  /** Likely intentional overrides (a higher settings layer replacing a lower one). Listed with their own count, never in the conflict badge. */
  overrides?: PosterConflict[];
}

export interface PosterOptions {
  /** Profile on the poster. Never a sum across agents. Default "claude-code". */
  agent?: Agent;
  dataset?: PosterDataset;
  /** Analyzer version for the footer. */
  version?: string;
  /** Undefined means "not checked": no badges or flags, and the card shows its not-checked state. */
  findings?: PosterFindings;
  /** Applied to strings that do not come from the report (findings text, version, eyebrow). */
  denylist?: Denylist;
}

export type PosterZone = "eyebrow" | "hero" | "list" | "card" | "footer";
export interface PosterText {
  type: "text"; zone: PosterZone; x: number; y: number; text: string; size: number;
  mono: boolean; weight: number; fill: string; anchor?: "end" | "middle"; spacing?: number;
  /** A trailing run in its own weight (wordmark), optionally in mono (a number inside a sentence). */
  tail?: { text: string; weight: number; mono?: boolean };
}
export interface PosterShape { type: "shape"; zone: PosterZone; svg: string }
export type PosterItem = PosterText | PosterShape;

export interface PosterRow {
  /** "not-counted" is the single muted row for everything found but not counted (nested, conditional, config, not auto-loaded). */
  kind: "source" | "more" | "group" | "not-counted";
  label: string;
  /** Meta line as displayed (truncated path plus scope, the kind breakdown, or what was not counted). */
  meta: string;
  tokens: number;
  /** Share of the always-loaded total, or "—" for the not-counted row. */
  share: string;
  /** False only for the not-counted row: it has no bar and its tokens are not in the total. */
  counted: boolean;
  flags: ("conflict" | "duplicate")[];
}
export interface PosterModel {
  kind: "poster-model";
  width: number;
  height: number;
  agent: Agent;
  dataset: PosterDataset;
  mode: "flat" | "grouped";
  /** sources/tokens count always-loaded sources only (the hero); bytes and inventorySources cover every listed source. */
  totals: { sources: number; bytes: number; tokens: number; listed: number; inventorySources: number };
  rows: PosterRow[];
  card: "unchecked" | "checked";
  items: PosterItem[];
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const fmt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const num = (n: number) => String(Number(n.toFixed(2)));
/** Drop a placeholder cut in half by truncation, so a stray "[reda…" never replaces a bar. */
const dropFragment = (s: string, end: "start" | "end") => {
  for (let k = DENY_TOKEN.length - 1; k > 0; k--) {
    if (end === "end" && s.endsWith(DENY_TOKEN.slice(0, k))) return s.slice(0, -k);
    if (end === "start" && s.startsWith(DENY_TOKEN.slice(-k))) return s.slice(k);
  }
  return s;
};
/** Longest label, path or text measured or laid out. Anything longer is cut first, so layout work per string is bounded. */
const LABEL_CAP = 512;
/** Slice without leaving half a surrogate pair at either end. */
const slice = (s: string, from: number, to?: number) => {
  let out = s.slice(from, to);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(out)) out = out.slice(1);
  return out;
};
const cleaner = (denylist?: Denylist) => {
  const base = (s: string) => redact(s, { denylist }).replace(/\s+/g, " ").trim();
  /** Labels and text keep their start. */
  const clean = (s: string) => { const r = base(s); return r.length > LABEL_CAP ? dropFragment(slice(r, 0, LABEL_CAP), "end") : r; };
  /** Paths keep both ends, so the file name survives. */
  const path = (s: string) => {
    const r = base(s);
    return r.length > LABEL_CAP ? dropFragment(slice(r, 0, LABEL_CAP / 2 - 1), "end") + "…" + dropFragment(slice(r, r.length - LABEL_CAP / 2), "start") : r;
  };
  return Object.assign(clean, { path });
};
// XML 1.0 forbids most control characters and lone surrogates; map them to U+FFFD.
const esc = (s: string) => s
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
  .replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Per-character Inter advance approximation (em), slightly conservative. resvg does not measure for us. */
function advance(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (" ".includes(ch)) return 0.28;
  if ("il.,:;'|!`·".includes(ch)) return 0.27;
  if ("jtfr()[]{}\"“”‘’-/\\I".includes(ch)) return 0.36;
  if ("mM".includes(ch)) return ch === "m" ? 0.88 : 0.9;
  if ("wW@".includes(ch)) return ch === "w" ? 0.78 : 0.92;
  if (ch >= "0" && ch <= "9") return 0.62;
  if (ch >= "A" && ch <= "Z") return 0.66;
  if (cp >= 0x2e80) return 1.05;
  if (cp > 0xffff) return 1.1;
  return 0.57;
}
const scaleOf = (size: number, weight: number) => size * (weight >= 600 ? 1.04 : 1);
function interWidth(text: string, size: number, weight = 400): number {
  let w = 0;
  for (const ch of text) w += advance(ch);
  return w * scaleOf(size, weight);
}

/** How many leading code points fit in maxW. One pass: prefix widths accumulate, nothing is re-measured. */
function fitPrefix(chars: readonly string[], size: number, maxW: number, weight: number): number {
  const scale = scaleOf(size, weight);
  let width = 0, count = 0;
  for (const ch of chars) {
    width += advance(ch) * scale;
    if (width > maxW) break;
    count++;
  }
  return count;
}

/** End-truncate with an ellipsis. Text is cut to LABEL_CAP first, then every character is measured once. */
function truncateInter(text: string, size: number, maxW: number, weight = 400): string {
  const capped = text.length > LABEL_CAP;
  const input = capped ? slice(text, 0, LABEL_CAP) : text;
  if (!capped && interWidth(input, size, weight) <= maxW) return input;
  const chars = Array.from(input);
  const count = fitPrefix(chars, size, maxW - interWidth("…", size, weight), weight);
  return dropFragment(chars.slice(0, count).join(""), "end").trimEnd() + "…";
}

function wrapText(text: string, size: number, maxW: number, maxLines: number, weight = 400): string[] {
  text = slice(text, 0, LABEL_CAP * 4);
  const lines: string[] = [];
  let line = "";
  const push = () => { if (line) lines.push(line); line = ""; };
  for (const word of text.split(" ").filter(Boolean)) {
    let w = word;
    while (interWidth(w, size, weight) > maxW) { // break overlong tokens by character
      const chars = Array.from(w);
      const head = chars.slice(0, Math.max(1, fitPrefix(chars, size, maxW, weight))).join("");
      push();
      lines.push(head);
      w = w.slice(head.length);
    }
    const next = line ? `${line} ${w}` : w;
    if (interWidth(next, size, weight) > maxW) { push(); line = w; } else line = next;
  }
  push();
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines - 1);
  const chars = Array.from(lines.slice(maxLines - 1).join(" "));
  const count = fitPrefix(chars, size, maxW - interWidth("…", size, weight), weight);
  return [...kept, dropFragment(chars.slice(0, count).join(""), "end").trimEnd() + "…"];
}

/** Keep the last segment whole; collapse the middle to "…/". */
export function middleTruncate(path: string, maxChars: number): string {
  if (maxChars < 2) return "…";
  if (path.length <= maxChars) return path;
  const parts = path.split("/");
  const last = parts.pop()!;
  if (last.length + 2 >= maxChars) return "…" + dropFragment(last.slice(-(maxChars - 1)), "start");
  const kept: string[] = [];
  let used = 0;
  for (const p of parts) {
    if (used + p.length + 1 + 2 + last.length > maxChars) break;
    kept.push(p);
    used += p.length + 1;
  }
  return kept.map((p) => `${p}/`).join("") + "…/" + last;
}

type Group = "instructions" | "skills" | "rules" | "settings";
const GROUPS: Group[] = ["instructions", "skills", "rules", "settings"];
const GROUP_OF: Record<SourceKind, Group> = {
  "claude-md": "instructions", "claude-local-md": "instructions", "agents-md": "instructions",
  "copilot-instructions": "instructions", "windsurf-rules": "instructions",
  "skill-listing": "skills", "cursor-rule": "rules", "claude-rule": "rules", "claude-import": "instructions", settings: "settings", mcp: "settings",
};
const GROUP_LABEL: Record<Group, string> = { instructions: "Instructions", skills: "Skills", rules: "Rules", settings: "Settings & MCP" };
const GROUP_NOTE: Record<Group, string> = { instructions: "", skills: " · listings only", rules: "", settings: " · metadata" };
const NOUN: Record<Group, [string, string]> = { instructions: ["instruction", "instructions"], skills: ["skill", "skills"], rules: ["rule", "rules"], settings: ["setting", "settings"] };

interface Entry { label: string; path: string; scope: Source["scope"]; imported: boolean; activation: Activation; tokens: number; group: Group; flags: ("conflict" | "duplicate")[] }

const WITHHELD = "text withheld (privacy)";

const pct = (tokens: number, total: number) => {
  const v = total > 0 ? (tokens / total) * 100 : 0;
  return v > 0 && v < 1 ? "<1%" : `${Math.round(v)}%`;
};

/** Build all poster coordinates. Pure and deterministic; the source list is sorted here. */
export function buildPosterModel(report: Report, opts: PosterOptions = {}): PosterModel {
  const agent = opts.agent ?? "claude-code";
  const agentLabel = POSTER_AGENT_LABEL[agent];
  const clean = cleaner(opts.denylist);
  const cleanPath = clean.path;
  const dataset = opts.dataset ?? "SAMPLE SETUP";
  const version = clean(opts.version ?? "0.0.0");
  const M = P.margin, W = P.width, R = W - M;
  const items: PosterItem[] = [];
  const text = (zone: PosterZone, x: number, y: number, s: string, o: Partial<PosterText> & { size: number; fill: string }) => {
    items.push({ type: "text", zone, x, y, text: s, mono: false, weight: 400, ...o });
  };
  const shape = (zone: PosterZone, svg: string) => items.push({ type: "shape", zone, svg });
  const rect = (zone: PosterZone, x: number, y: number, w: number, h: number, fill: string, extra = "") =>
    shape(zone, `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="${fill}"${extra}/>`);
  const line = (zone: PosterZone, x1: number, x2: number, y: number, stroke: string, sw = 2, dash = "") =>
    shape(zone, `<line x1="${num(x1)}" x2="${num(x2)}" y1="${num(y)}" y2="${num(y)}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`);

  // Findings: low confidence never appears on the poster.
  const findings = opts.findings && {
    conflicts: opts.findings.conflicts.filter((c) => c.confidence !== "low" && !c.override),
    duplicates: opts.findings.duplicates,
    overrides: (opts.findings.overrides ?? []).length + opts.findings.conflicts.filter((c) => c.confidence !== "low" && c.override).length,
  };
  const topConflict = findings?.conflicts[0];
  const topDuplicate = findings?.duplicates[0];
  const conflictPaths = new Set(topConflict ? [topConflict.a.ref.path, topConflict.b.ref.path].map(cleanPath) : []);
  const duplicatePaths = new Set((topDuplicate?.refs ?? []).map((r) => cleanPath(r.path)));

  // Only this agent's profile is on the poster; the hero is never a cross-agent sum.
  // The hero counts only always-loaded text; nested, conditional, inactive and config rows are listed but not counted.
  const isCounted = (e: Entry) => e.activation === "always";
  // Counted rows first, largest first; listed-but-not-counted rows (hollow bars) follow, so a big settings row never sits among them.
  const entries: Entry[] = report.sources.filter((s) => inProfile(s, agent)).map((s) => {
    const path = cleanPath(s.logicalPath);
    return {
      label: clean(s.label), path, scope: s.scope, imported: agent === "claude-code" && s.importedBy.length > 0, activation: activationIn(s, agent), tokens: s.estTokens, group: GROUP_OF[s.kind],
      flags: [...(conflictPaths.has(path) ? ["conflict" as const] : []), ...(duplicatePaths.has(path) ? ["duplicate" as const] : [])],
    };
  }).sort((a, b) => Number(!isCounted(a)) - Number(!isCounted(b)) || b.tokens - a.tokens || compare(a.path, b.path) || compare(a.label, b.label));
  const counted = entries.filter(isCounted);
  const notCounted = entries.filter((e) => !isCounted(e));
  const totalTokens = counted.reduce((s, e) => s + e.tokens, 0);
  const totalBytes = report.sources.filter((s) => inProfile(s, agent)).reduce((s, x) => s + x.bytes, 0);
  const listed = entries.length - counted.length;
  const totals = { sources: counted.length, bytes: totalBytes, tokens: totalTokens, listed, inventorySources: entries.length };

  // ---- Icons, badges ----
  const conflictIcon = (x: number, y: number, s: number, fg: string, inner: string) =>
    `<path d="M${num(x + s / 2)} ${num(y)} L${num(x + s)} ${num(y + s * 0.9)} L${num(x)} ${num(y + s * 0.9)} Z" fill="${fg}" stroke="${fg}" stroke-width="${num(s * 0.08)}" stroke-linejoin="round"/>`
    + `<rect x="${num(x + s * 0.455)}" y="${num(y + s * 0.3)}" width="${num(s * 0.09)}" height="${num(s * 0.32)}" rx="${num(s * 0.04)}" fill="${inner}"/><circle cx="${num(x + s / 2)}" cy="${num(y + s * 0.74)}" r="${num(s * 0.055)}" fill="${inner}"/>`;
  const duplicateIcon = (x: number, y: number, s: number, fg: string) => {
    const w = s * 0.62, sw = s * 0.1;
    const sq = (qx: number, qy: number) => `<rect x="${num(qx)}" y="${num(qy)}" width="${num(w)}" height="${num(w)}" rx="${num(s * 0.1)}" fill="none" stroke="${fg}" stroke-width="${num(sw)}"/>`;
    return sq(x + sw, y + sw) + sq(x + s - w - sw / 2, y + s - w - sw / 2);
  };
  const badge = (zone: PosterZone, kind: "conflict" | "duplicate", x: number, y: number, label: string, anchor: "start" | "end" = "start", outlined = false): number => {
    const h = P.badgeHeight;
    const w = Math.round(interWidth(label, P.badge, 700) + label.length * 1.5 + 54 + 14);
    const bx = anchor === "end" ? x - w : x;
    if (kind === "conflict" && outlined) {
      // Likely intentional override: same triangle icon, solid outline, no fill.
      shape(zone, `<rect x="${num(bx + 1.5)}" y="${num(y + 1.5)}" width="${w - 3}" height="${h - 3}" rx="${P.badgeRadius}" fill="${t.surface}" stroke="${t.conflict}" stroke-width="3"/>${conflictIcon(bx + 14, y + 9, 28, t.conflict, t.surface)}`);
    } else if (kind === "conflict") {
      shape(zone, `<rect x="${num(bx)}" y="${num(y)}" width="${w}" height="${h}" rx="${P.badgeRadius}" fill="${t.conflict}"/>${conflictIcon(bx + 14, y + 9, 28, t.onConflict, t.conflict)}`);
    } else {
      shape(zone, `<rect x="${num(bx + 1.5)}" y="${num(y + 1.5)}" width="${w - 3}" height="${h - 3}" rx="${P.badgeRadius}" fill="${t.duplicateTint}" stroke="${t.duplicate}" stroke-width="3" stroke-dasharray="${P.badgeDash}"/>${duplicateIcon(bx + 14, y + 8, 28, t.duplicate)}`);
    }
    text(zone, bx + 54, y + 30, label, { size: P.badge, weight: 700, spacing: 1.5, fill: kind === "conflict" ? (outlined ? t.conflict : t.onConflict) : t.duplicate });
    return w;
  };

  // ---- Eyebrow (top band, not crop-critical) ----
  text("eyebrow", M, 136, clean(`WHAT ${agentLabel.toUpperCase()} IS TOLD EVERY TURN · REPO ROOT`), { size: P.eyebrow, mono: true, weight: 500, spacing: 2, fill: t.muted });
  const dw = dataset.length * 16 + 36;
  shape("eyebrow", `<rect x="${R - dw + 1}" y="105" width="${dw - 2}" height="42" rx="6" fill="none" stroke="${t.muted}" stroke-width="2"/>`);
  text("eyebrow", R - dw / 2, 134, dataset, { size: 22, mono: true, weight: 500, spacing: 1.5, fill: t.muted, anchor: "middle" });

  // ---- Hero ----
  const heroNum = `~${fmt(totalTokens)}`;
  text("hero", M - 8, 388, heroNum, { size: P.heroNumber, weight: 700, spacing: -6, fill: t.ink });
  // Inter Bold hero digits: "1" is narrow, "~" and the rest are wide; letter-spacing is -6 per glyph.
  const heroEm = Array.from(heroNum).reduce((s, c) => s + (c === "~" ? 0.6 : c === "," ? 0.3 : c === "1" ? 0.5 : c === "7" ? 0.6 : 0.68), 0);
  text("hero", M - 8 + heroEm * P.heroNumber - 6 * heroNum.length + 28, 388, "est. tokens", { size: P.heroUnit, weight: 600, fill: t.ink });
  // Header: the big number, one quiet ink mono line for the findings, then the muted "from N sources" line.
  // No badges, override line or not-counted line here: colour lives in the findings card, and not-counted sources have their own row.
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const findingsLine = !findings ? "Conflicts and duplicates not checked"
    : [findings.conflicts.length && plural(findings.conflicts.length, "possible conflict", "possible conflicts"),
      findings.duplicates.length && plural(findings.duplicates.length, "duplicate", "duplicates")].filter(Boolean).join(" · ") || "No conflicts or duplicates found";
  text("hero", M, 456, findingsLine, { size: P.findingsLine, mono: true, fill: t.ink });
  text("hero", M, 500, `from ${counted.length} always-loaded source${counted.length === 1 ? "" : "s"}, before you type anything`, { size: P.subline, fill: t.muted });

  // ---- Column header ----
  const top0 = 560; // leaves room for the findings line and the muted subline above the column header
  const head = (x: number, s: string, anchor?: "end") => text("list", x, top0 - 14, s, { size: 22, mono: true, spacing: 1.5, fill: t.muted, anchor });
  head(M, "SOURCE");
  if (findings) head(P.flagsX, "FLAGS");
  head(P.barX, "SIZE, LARGEST FIRST");
  head(R, "EST. TOKENS", "end");
  line("list", M, R, top0, t.ink);

  // ---- Rows ----
  const rows: PosterRow[] = [];
  const pathMax = Math.floor((P.barX - 16 - M) / (P.path * P.monoAdvance));
  interface Draw {
    kind: PosterRow["kind"]; label: string; metaMono: boolean; meta: string; tokens: number; bar: number[][]; barFill: string;
    flags: ("conflict" | "duplicate")[]; indent: number; labelWeight: number; ruleInk: boolean;
  }
  const drawRow = (i: number, d: Draw) => {
    const y = top0 + i * P.rowHeight;
    text("list", M + d.indent, y + 38, truncateInter(d.label, P.label, P.flagsX - 16 - M - d.indent, d.labelWeight), { size: P.label, weight: d.labelWeight, fill: t.ink });
    // Row flags are drawn in ink: colour belongs to the findings card (vermilion) and the duplicate strip (blue) only.
    d.flags.forEach((f, k) => shape("list", f === "conflict" ? conflictIcon(P.flagsX + k * 38, y + 12, 28, t.ink, t.paper) : duplicateIcon(P.flagsX + k * 38, y + 12, 28, t.ink)));
    text("list", M + d.indent, y + 66, d.meta, { size: P.path, mono: d.metaMono, fill: t.muted });
    shape("list", `<rect x="${P.barX}" y="${y + 24}" width="${P.barW}" height="${P.barH}" rx="3" fill="${t.track}"/>`);
    for (const [bx, bw] of d.bar) shape("list", `<rect x="${num(bx!)}" y="${y + 24}" width="${num(bw!)}" height="${P.barH}"${d.kind === "more" ? "" : ` rx="3"`} fill="${d.barFill}"/>`);
    text("list", R, y + 40, `~${fmt(d.tokens)}`, { size: P.number, mono: true, weight: 500, fill: t.ink, anchor: "end" });
    const share = pct(d.tokens, totalTokens);
    text("list", R, y + 66, share, { size: P.share, mono: true, fill: t.muted, anchor: "end" });
    line("list", M, R, y + P.rowHeight, d.ruleInk ? t.ink : t.rule);
    rows.push({ kind: d.kind, label: d.label, meta: d.meta, tokens: d.tokens, share, counted: true, flags: d.flags });
  };
  const barFor = (tokens: number, max: number) => [[P.barX, Math.max(P.barMin, max > 0 ? (tokens / max) * P.barW : 0)]];
  // `.claude/skills/x/CLAUDE.md` is nested scope but not a memory file at all: say so instead of "nested".
  const isNotMemory = (e: Entry) => /(^|\/)\.claude\/.+\/CLAUDE(\.local)?\.md$/.test(e.path);
  const pathMeta = (e: Entry, indent: number) => {
    // An imported file says so.
    const place = isNotMemory(e) ? "not memory" : e.scope;
    const scope = e.imported ? ` · @import${e.activation === "nested" ? ` · ${place}` : ""}` : e.scope === "project" ? "" : ` · ${place}`;
    return middleTruncate(e.path, pathMax - scope.length - Math.ceil(indent / (P.path * P.monoAdvance))) + scope;
  };

  // The list is counted sources only. Everything found but not counted (nested, conditional, config, not auto-loaded) collapses into one
  // muted row after them, and that row takes one of the P.maxRows slots.
  const slots = P.maxRows - (notCounted.length ? 1 : 0);
  const maxTokens = Math.max(0, ...counted.map((e) => e.tokens));
  let individual = counted.length > slots ? counted.slice(0, slots - 1) : counted;
  let rest = counted.slice(individual.length);
  // Sources in the highlighted findings always get a row; they replace the smallest unflagged row.
  if (rest.length) {
    for (const e of [...rest].filter((r) => r.flags.length)) {
      let victim = -1;
      for (let i = individual.length - 1; i >= 0; i--) if (!individual[i]!.flags.length) { victim = i; break; }
      if (victim < 0) break;
      const out = individual[victim]!;
      const rowOrder = (a: Entry, b: Entry) => b.tokens - a.tokens || compare(a.path, b.path);
      individual = [...individual.slice(0, victim), ...individual.slice(victim + 1), e].sort(rowOrder);
      rest = [...rest.filter((r) => r !== e), out].sort(rowOrder);
    }
  }
  const restTokens = rest.reduce((s, e) => s + e.tokens, 0);
  const grouped = counted.length > P.groupAbove || (rest.length > 0 && totalTokens > 0 && restTokens / totalTokens > P.groupMoreShare);
  let drawn = 0; // rows drawn so far (the not-counted row included once it is drawn)

  if (!entries.length) {
    text("list", M, top0 + 52, `No ${agentLabel} sources found.`, { size: P.label, weight: 500, fill: t.muted });
    drawn = 1;
  } else if (!grouped) {
    individual.forEach((e, i) => drawRow(i, {
      kind: "source", label: e.label, metaMono: true, meta: pathMeta(e, 0), tokens: e.tokens, bar: barFor(e.tokens, maxTokens),
      barFill: t.bar, flags: e.flags, indent: 0, labelWeight: 500, ruleInk: !rest.length && i === individual.length - 1,
    }));
    drawn = individual.length;
    if (rest.length) {
      const counts = GROUPS.map((g) => [g, rest.filter((r) => r.group === g).length] as const).filter(([, n]) => n > 0);
      const breakdown = counts.map(([g, n]) => `${n} ${NOUN[g][n === 1 ? 0 : 1]}`).join(", ");
      const under = ` · each under ${Math.floor((rest[0]!.tokens / totalTokens) * 100) + 1}%`;
      // Segments share the bar scale; shrink only if the hidden sources would overflow the track.
      const scale = Math.max(maxTokens, restTokens);
      let bx = P.barX;
      const segs = rest.map((r) => { const w = (r.tokens / scale) * P.barW; const seg = [bx, Math.max(1, w - 3)]; bx += w; return seg; });
      drawRow(drawn++, {
        kind: "more", label: `+ ${rest.length} more source${rest.length === 1 ? "" : "s"}`, metaMono: false, meta: `${breakdown}${under}`,
        tokens: restTokens, bar: segs, barFill: t.muted, flags: [], indent: 0, labelWeight: 600, ruleInk: true,
      });
    }
  } else {
    // Kind-grouped mode: subtotal bars per kind, then the largest sources of each kind.
    const groups = GROUPS.map((g) => ({ g, list: counted.filter((e) => e.group === g) })).filter((x) => x.list.length)
      .map((x) => ({ ...x, tokens: x.list.reduce((s, e) => s + e.tokens, 0) }))
      .sort((a, b) => b.tokens - a.tokens || GROUPS.indexOf(a.g) - GROUPS.indexOf(b.g));
    // Row budget is the same 10 rows as flat mode so the list stays above the card.
    let budget = slots - groups.length;
    const shown = groups.map(() => 0);
    for (const cap of [2, Infinity]) {
      for (let moved = true; moved && budget > 0;) {
        moved = false;
        groups.forEach((x, i) => { if (budget > 0 && shown[i]! < x.list.length && shown[i]! < cap) { shown[i]!++; budget--; moved = true; } });
      }
    }
    const groupMax = Math.max(...groups.map((x) => x.tokens));
    groups.forEach((x, gi) => {
      const hidden = x.list.length - shown[gi]!;
      const meta = `${x.list.length} source${x.list.length === 1 ? "" : "s"}${GROUP_NOTE[x.g]}${hidden ? ` · ${hidden} more not shown` : ""}`;
      drawRow(drawn++, { kind: "group", label: GROUP_LABEL[x.g], metaMono: false, meta, tokens: x.tokens, bar: barFor(x.tokens, groupMax), barFill: t.bar, flags: [], indent: 0, labelWeight: 700, ruleInk: false });
      x.list.slice(0, shown[gi]).forEach((e) => drawRow(drawn++, {
        kind: "source", label: e.label, metaMono: true, meta: pathMeta(e, 28), tokens: e.tokens, bar: barFor(e.tokens, groupMax),
        barFill: t.muted, flags: e.flags, indent: 28, labelWeight: 500, ruleInk: false,
      }));
    });
  }

  // One muted row for everything found but not counted: no bar, share "—", the summed tokens muted.
  if (notCounted.length) {
    const y = top0 + drawn * P.rowHeight, sum = notCounted.reduce((s, e) => s + e.tokens, 0);
    // The counted rows end on an ink rule (grouped mode has none of its own).
    if (grouped) line("list", M, R, y, t.ink);
    const n = (a: Activation, notMemory = false) => notCounted.filter((e) => e.activation === a && (a !== "nested" || isNotMemory(e) === notMemory)).length;
    const why = ([[n("nested"), "nested"], [n("nested", true), "not memory"], [n("conditional"), "conditional"], [n("config"), "config (settings, MCP)"], [n("inactive"), "not auto-loaded"]] as const)
      .filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`).concat("not in the total").join(" · ");
    text("list", M, y + 38, "Also found, not counted: ", { size: P.label, weight: 500, fill: t.muted, tail: { text: String(notCounted.length), weight: 500, mono: true } });
    text("list", M, y + 66, why, { size: P.path, fill: t.muted });
    text("list", R, y + 40, `~${fmt(sum)}`, { size: P.number, mono: true, weight: 500, fill: t.muted, anchor: "end" });
    text("list", R, y + 66, "—", { size: P.share, mono: true, fill: t.muted, anchor: "end" });
    line("list", M, R, y + P.rowHeight, t.rule);
    rows.push({ kind: "not-counted", label: `Also found, not counted: ${notCounted.length}`, meta: why, tokens: sum, share: "—", counted: false, flags: [] });
    drawn++;
  }

  // ---- Findings card: same size in both states. It sits midway between the end of the table and the footer rule, so the gap above it
  // equals the gap below it and a crop to y 200-1800 ends on the card, not on an empty band. A full 10-row table leaves 22 px each side. ----
  const fy = 1812; // footer rule
  const tableEnd = top0 + Math.max(1, drawn) * P.rowHeight;
  // Layout rule: each gap (table to card, card to footer rule) is at least 40 poster units for tables up to 9 rows (60 at 9); at the 10-row
  // maximum the measured 22 / 22 is accepted. The card is never made smaller to buy room: what does not fit inside it is left out (CARD_PAD).
  const ch = 448, cy = (tableEnd + fy - ch) / 2, bx0 = M + 40, cardR = R - 40;
  const CARD_PAD = 40; // room kept inside the card, top and bottom, for the content that is shown
  shape("card", `<rect x="${M + 1}" y="${cy + 1}" width="${W - 2 * M - 2}" height="${ch - 2}" rx="${P.radius}" fill="${t.surface}" stroke="${t.rule}" stroke-width="2"/>`);
  const ref = (r: PosterRef, maxChars: number) => {
    const suffix = `:${r.line}`;
    return middleTruncate(cleanPath(r.path), maxChars - suffix.length) + suffix;
  };
  const hasFindings = !!findings && (findings.conflicts.length > 0 || findings.duplicates.length > 0);
  if (!findings) {
    text("card", bx0, cy + 66, "CONFLICTS & DUPLICATES", { size: P.badge, weight: 700, spacing: 1.5, fill: t.muted });
    text("card", bx0, cy + 140, "Not checked in this run (findings off).", { size: P.ruleText, weight: 500, fill: t.muted });
  } else if (!hasFindings) {
    text("card", bx0, cy + 66, "CONFLICTS & DUPLICATES", { size: P.badge, weight: 700, spacing: 1.5, fill: t.muted });
    text("card", bx0, cy + 140, "No possible conflicts or duplicates found by the heuristics.", { size: P.ruleText, weight: 500, fill: t.muted });
    // Overrides are not counted in the header line; with nothing else to show, the card says how many were left out.
    if (findings.overrides) text("card", bx0, cy + 196, `${findings.overrides} likely intentional override${findings.overrides === 1 ? "" : "s"} listed, not counted.`, { size: P.ruleMeta, fill: t.muted });
  } else {
    // Blocks are centred vertically; relative offsets are tight enough for 3-line quotes plus a duplicate strip.
    const colW = P.quoteW, gap = W - 2 * M - 80 - 2 * colW;
    const quotes = topConflict && ([topConflict.a, topConflict.b].map((q) => ({
      q, lines: q.withheld ? [WITHHELD] : wrapText(`“${clean(q.text)}”`, P.ruleText, colW - 32, P.ruleMaxLines, 500),
    })));
    const lines = quotes ? Math.max(...quotes.map((x) => x.lines.length)) : 0;
    const conflictH = quotes ? 64 + lines * P.ruleLine + 80 : 56;
    // The duplicate strip is dropped, never squeezed, when the card cannot hold it with the conflict above it (the "1 of N" note and the
    // picker cover what is not shown). Today's tallest content (3-line quotes plus the strip) is 408 = ch - CARD_PAD, so this never fires yet.
    const dupH = topDuplicate && conflictH + 26 + 112 <= ch - CARD_PAD ? 26 + 112 : 0;
    const top = cy + Math.max(28, (ch - (conflictH + dupH)) / 2);
    if (topConflict && quotes) {
      const label = topConflict.setting ? "SETTING CONFLICT" : "POSSIBLE CONFLICT";
      badge("card", "conflict", bx0, top, label, "start", !!topConflict.override);
      // The hero badge counts every headline conflict, the card shows one. Say so on the card
      // ("1 of N shown") rather than shrinking the badge, so the total stays honest and the card reads as a sample.
      const nConflicts = findings!.conflicts.length;
      const shownNote = nConflicts > 1 ? `1 of ${nConflicts} shown · ` : "";
      text("card", cardR, top + 30, `${shownNote}${topConflict.confidence} confidence · heuristic`, { size: P.ruleMeta, fill: t.muted, anchor: "end" });
      const qy = top + 64, barH = lines * P.ruleLine + 40;
      const xs = [bx0, bx0 + colW + gap];
      quotes.forEach(({ q, lines: ls }, k) => {
        const x = xs[k]!;
        rect("card", x, qy, P.quoteBar, barH, t.conflict);
        ls.forEach((l, i) => text("card", x + 28, qy + 30 + i * P.ruleLine, l, { size: P.ruleText, weight: 500, fill: q.withheld ? t.muted : t.ink }));
        text("card", x + 28, qy + lines * P.ruleLine + 30, ref(q.ref, Math.floor((colW - 28) / (P.ruleMeta * P.monoAdvance))), { size: P.ruleMeta, mono: true, fill: t.muted });
      });
      const mx = bx0 + colW + gap / 2, my = qy + barH / 2;
      line("card", bx0 + colW + 8, xs[1]! - 8, my, t.conflict, P.connector);
      shape("card", `<circle cx="${num(mx)}" cy="${num(my)}" r="26" fill="${t.conflict}"/>`
        + [[-12, -6, 12, -6], [-12, 6, 12, 6], [-8, 14, 8, -14]].map(([a, b, c, d]) => `<line x1="${num(mx + a!)}" x2="${num(mx + c!)}" y1="${num(my + b!)}" y2="${num(my + d!)}" stroke="${t.onConflict}" stroke-width="4"/>`).join(""));
      text("card", bx0, qy + lines * P.ruleLine + 72, truncateInter(clean(topConflict.note), P.ruleMeta, cardR - bx0), { size: P.ruleMeta, fill: t.muted });
    } else {
      text("card", bx0, top + 30, "No possible conflicts found by the heuristics.", { size: P.ruleText, weight: 500, fill: t.muted });
    }
    if (topDuplicate && dupH) {
      const dy = top + conflictH + 26;
      line("card", bx0, cardR, dy, t.rule);
      const near = topDuplicate.similarity !== undefined;
      const label = near ? `NEAR-DUPLICATE ≈${topDuplicate.similarity!.toFixed(2)}` : `DUPLICATE ×${topDuplicate.refs.length}`;
      const bw = badge("card", "duplicate", bx0, dy + 20, label);
      const tx = bx0 + bw + 20;
      text("card", tx, dy + 52, topDuplicate.withheld ? WITHHELD : truncateInter(`“${clean(topDuplicate.text)}”`, P.ruleText, cardR - tx, 500), { size: P.ruleText, weight: 500, fill: topDuplicate.withheld ? t.muted : t.ink });
      let chx = bx0;
      const chy = dy + 76;
      const nDuplicates = findings!.duplicates.length;
      const dupNoteRaw = nDuplicates > 1 ? `1 of ${nDuplicates} shown`.length * P.ruleMeta * P.monoAdvance : 0;
      const dupNoteW = nDuplicates > 1 ? dupNoteRaw + 24 : 0;
      if (nDuplicates > 1) text("card", cardR, chy + 26, `1 of ${nDuplicates} shown`, { size: P.ruleMeta, mono: true, fill: t.muted, anchor: "end" });
      const chipR = cardR - dupNoteW;
      topDuplicate.refs.forEach((r, i) => {
        const label = ref(r, 30);
        const w = label.length * P.ruleMeta * P.monoAdvance + 28;
        if (chx + w > chipR) {
          // "+N more files" counts files in this group; "1 of M shown" counts groups. At least 16 px stay clear of that note.
          const room = (nDuplicates > 1 ? cardR - dupNoteRaw : cardR) - 16 - chx;
          const more = [`+${topDuplicate.refs.length - i} more files`, `+${topDuplicate.refs.length - i}`].find((m) => m.length * P.ruleMeta * P.monoAdvance <= room);
          if (more) text("card", chx, chy + 26, more, { size: P.ruleMeta, mono: true, fill: t.muted });
          chx = Infinity;
          return;
        }
        if (!Number.isFinite(chx)) return;
        if (i) line("card", chx - 44, chx - 4, chy + 18, t.duplicate, P.connector, P.dupDash);
        rect("card", chx, chy, w, 36, t.duplicateTint, ` rx="6"`);
        text("card", chx + 14, chy + 26, label, { size: P.ruleMeta, mono: true, fill: t.ink });
        chx += w + 48;
      });
    }
  }

  // ---- Footer (bottom band, outside the 1:1 crop). No date; URL slot intentionally empty. ----
  line("footer", M, R, fy, t.rule);
  [30, 22, 15, 9].forEach((w, i) => rect("footer", M, fy + 27 + i * 9, w, 6, t.ink, ` rx="1"`));
  text("footer", M + 44, fy + 58, "every", { size: P.footerMark, spacing: -0.5, fill: t.ink, tail: { text: "turn", weight: 700 } });
  text("footer", R, fy + 58, "@OrMiz", { size: P.footerHandle, weight: 600, fill: t.ink, anchor: "end" });
  text("footer", M, fy + 98, "Static scan, not a recording of a live turn. Tokens estimated (UTF-8 bytes ÷ 4). Conflicts are heuristic; check the evidence.", { size: P.footer, fill: t.muted });
  // A duplicate strip counts distinct files only; repeats inside one file are listed in the report, not here.
  const meta = `everyturn ${version} · ${agentLabel} profile · ${entries.length} source${entries.length === 1 ? "" : "s"} · ${fmt(totalBytes)} bytes`;
  const note = " · duplicates: distinct files only";
  const fits = (meta + note).length * P.footerMeta * P.monoAdvance <= W - 2 * M;
  text("footer", M, fy + 134, topDuplicate && fits ? meta + note : meta, { size: P.footerMeta, mono: true, fill: t.muted });

  return {
    kind: "poster-model", width: W, height: P.height, agent, dataset, mode: grouped ? "grouped" : "flat",
    totals, rows, card: findings ? "checked" : "unchecked", items,
  };
}

const isModel = (x: Report | PosterModel): x is PosterModel => (x as PosterModel).kind === "poster-model";

/** Source SVG with <text>. The CLI outlines it through resvg for the exported SVG. */
export function renderPosterSvg(input: Report | PosterModel, opts: PosterOptions = {}): string {
  const model = isModel(input) ? input : buildPosterModel(input, opts);
  const family = (m: boolean) => (m ? "JetBrains Mono NL" : "Inter");
  const body = model.items.map((it) => {
    if (it.type === "shape") return it.svg;
    const style = ` font-family="${family(it.mono)}"`
      + `${it.weight !== 400 ? ` font-weight="${it.weight}"` : ""} font-size="${it.size}"${it.spacing ? ` letter-spacing="${it.spacing}"` : ""} fill="${it.fill}"`;
    if (it.text.includes(DENY_TOKEN) && !it.tail) {
      // Split into text spans and bars. Spans are placed by estimated advance (exact for mono,
      // the conservative Inter table otherwise), so anchored runs are positioned from the total width.
      const parts = it.text.split(DENY_TOKEN);
      const width = (s: string) => (it.mono ? Array.from(s).length * it.size * P.monoAdvance : interWidth(s, it.size, it.weight))
        + Array.from(s).length * (it.spacing ?? 0);
      const barW = width(DENY_TOKEN), cap = it.size * 0.73;
      const total = parts.reduce((sum, p) => sum + width(p), 0) + barW * (parts.length - 1);
      let x = it.anchor === "end" ? it.x - total : it.anchor === "middle" ? it.x - total / 2 : it.x;
      const out: string[] = [];
      parts.forEach((p, i) => {
        if (p.trim()) out.push(`<text x="${num(x)}" y="${num(it.y)}"${style}>${esc(p)}</text>`);
        x += width(p);
        if (i < parts.length - 1) {
          out.push(`<rect class="redacted" x="${num(x)}" y="${num(it.y - cap)}" width="${num(barW)}" height="${num(cap)}" rx="4" fill="${t.ink}"/>`);
          x += barW;
        }
      });
      return out.join("\n");
    }
    const attrs = `x="${num(it.x)}" y="${num(it.y)}"${it.anchor ? ` text-anchor="${it.anchor}"` : ""}${style}`;
    const tail = it.tail ? `<tspan${it.tail.mono ? ` font-family="${family(true)}"` : ""} font-weight="${it.tail.weight}">${esc(it.tail.text)}</tspan>` : "";
    return `<text ${attrs}>${esc(it.text)}${tail}</text>`;
  }).join("\n");
  const title = `Every Turn poster: ~${fmt(model.totals.tokens)} estimated tokens from ${model.totals.sources} always-loaded ${POSTER_AGENT_LABEL[model.agent]} source${model.totals.sources === 1 ? "" : "s"}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}"><title>${esc(title)}</title>\n`
    + `<rect width="${model.width}" height="${model.height}" fill="${t.paper}"/>\n${body}\n</svg>\n`;
}
