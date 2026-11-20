// Deterministic finding detection: duplicates, near-duplicates, conflicts, setting conflicts.
// Heuristics only. No LLM, no network, no fs, no Date or random. Output order is a pure function of the report.
import { publicModel } from "./configSummary";
import { analyze, jaccard, numericHits, topicHits, type Analysis, type Clause } from "./polarity";
import { AGENT_NAME, activationIn, inProfile } from "./profile";
import { redact, type Denylist } from "./redact";
import { extractRules, type Rule } from "./rules";
import { secretBlockLines } from "./patterns.mjs";
import { snippetSafety } from "./snippets";
import { AGENTS, type Agent, type Confidence, type Evidence, type Finding, type FindingCounts, type FindingKind, type Report, type Source, type SourceKind } from "./types";

export const NEAR_DUPLICATE_THRESHOLD = 0.85;
/** A near-duplicate needs this many meaningful tokens (so a one-token difference only passes at 6+ tokens: 6/7). */
export const NEAR_DUPLICATE_MIN_WORDS = 4;
/** Secondary check for long rules: word-trigram Jaccard must also reach this. */
export const SHINGLE_MIN = 0.5;
const SHINGLE_FROM_WORDS = 8;
const MAX_RULES_TOTAL = 20000;
const MAX_COMPARISONS = 1_500_000;
const MAX_PAIRS_PER_GROUP = 400;
const EXCERPT_CAP = 240;
const INSTRUCTION_KINDS = new Set<SourceKind>(["claude-md", "claude-local-md", "agents-md", "cursor-rule", "copilot-instructions", "windsurf-rules", "claude-rule", "claude-import"]);
/** One-token cores that are specific enough to compare ("run tests" vs "skip tests"). */
/** Scope words that merely restate a curated topic (stemmed tokens), so they do not make a rule narrower than its opposite. */
const TOPIC_CONTEXT: Record<string, Set<string>> = {
  "package-manager": new Set(["install", "installation", "dependency", "package", "project"]),
  indentation: new Set(["indentation", "indent", "formatting", "code", "file"]),
  exports: new Set(["module", "code"]),
  quotes: new Set(["string", "code"]),
};
const SINGLE_OBJECTS = new Set(["test", "lint", "format", "typecheck", "build", "mock", "log", "emoji", "semicolon"]);

/** Evidence order: Claude memory files first (root CLAUDE.md on the left of a pair), then the rest. */
const KIND_ORDER: SourceKind[] = ["claude-md", "claude-local-md", "claude-rule", "claude-import", "agents-md", "cursor-rule", "copilot-instructions", "windsurf-rules"];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const CONF_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
const KIND_RANK: Record<FindingKind, number> = { conflict: 0, "setting-conflict": 1, duplicate: 2, "near-duplicate": 3, "repeated-in-file": 4 };

export interface SettingsInput {
  sourceId: string;
  layer: "user" | "project" | "local";
  /** Raw settings JSON text. Never exported; only redacted, safety-checked excerpts reach evidence. */
  text: string;
}

export interface DetectOptions {
  denylist?: Denylist;
  /** "sample" disables the private-identifier snippet check. Default "real". */
  dataset?: "sample" | "real";
  settings?: SettingsInput[];
  /** Called with a short safe message when a limit truncated the analysis. */
  warn?: (message: string) => void;
  /**
   * Unredacted rule text by source id, matched in memory only (compare raw text, redact what is shown).
   * Without an entry the source's own (already redacted) `represented` text is used. Never exported.
   */
  texts?: ReadonlyMap<string, string>;
}

/** Agents the sources belong to, for a finding no single profile contains. */
const ownAgents = (...sources: Source[]): Agent[] => AGENTS.filter((a) => sources.some((s) => s.agent === a));

/** Settings layer of a settings file, or null when it is not comparable (nested directories). */
export function settingsLayer(logicalPath: string, scope: string): SettingsInput["layer"] | null {
  if (scope === "nested") return null;
  if (scope === "user") return "user";
  return /(^|\/)settings\.local\.json$/.test(logicalPath) ? "local" : "project";
}

// ---- Similar pairs (prefix filter) --------------------------------------------------------------
/** All index pairs (i<j) whose token sets have Jaccard >= t. Prefix filtering keeps it far below n². */
export function similarPairs(sets: readonly (readonly string[])[], t: number, budget = { left: MAX_COMPARISONS }): [number, number, number][] {
  const freq = new Map<string, number>();
  const uniq = sets.map((s) => [...new Set(s)]);
  for (const s of uniq) for (const tok of s) freq.set(tok, (freq.get(tok) ?? 0) + 1);
  const ordered = uniq.map((s) => s.sort((a, b) => (freq.get(a)! - freq.get(b)!) || compare(a, b)));
  const index = new Map<string, number[]>();
  const out: [number, number, number][] = [];
  ordered.forEach((s, i) => {
    if (!s.length) return;
    const prefix = s.slice(0, s.length - Math.ceil(t * s.length) + 1);
    const seen = new Set<number>();
    for (const tok of prefix) {
      for (const j of index.get(tok) ?? []) {
        if (seen.has(j)) continue;
        seen.add(j);
        const other = ordered[j]!;
        if (Math.min(s.length, other.length) / Math.max(s.length, other.length) < t) continue;
        if (budget.left-- <= 0) return;
        const score = jaccard(s, other);
        if (score >= t) out.push([j, i, score]);
      }
    }
    for (const tok of prefix) { const list = index.get(tok); if (list) list.push(i); else index.set(tok, [i]); }
  });
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

const shingles = (tokens: readonly string[]) => {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= tokens.length; i++) out.add(tokens.slice(i, i + 3).join(" "));
  return out;
};
const setJaccard = (a: Set<string>, b: Set<string>) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return a.size + b.size - inter === 0 ? 1 : inter / (a.size + b.size - inter);
};

// ---- Scope and applicability --------------------------------------------------------------------
/** Directory a source applies to: "" for repo root, user and root config directories. */
function scopeDir(s: Source): string {
  if (s.scope !== "nested") return "";
  const parts = s.logicalPath.split("/");
  parts.pop();
  const hidden = parts.findIndex((p) => p.startsWith("."));
  return (hidden >= 0 ? parts.slice(0, hidden) : parts).join("/");
}
const compatibleDirs = (a: string, b: string) => a === "" || b === "" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const sharedAgents = (...sources: Source[]): Agent[] => AGENTS.filter((a) => sources.every((s) => inProfile(s, a)));

interface Applicability { text: string; compatible: boolean; shared: Agent[] }
function applicabilityOf(sa: Source, sb: Source): Applicability {
  const shared = sharedAgents(sa, sb);
  if (!shared.length) {
    return { text: `Different agents: ${AGENT_NAME[sa.agent]} vs ${AGENT_NAME[sb.agent]}.`, compatible: false, shared };
  }
  const da = scopeDir(sa), db = scopeDir(sb);
  if (!compatibleDirs(da, db)) return { text: `Different directories (${da} vs ${db}); never in scope together.`, compatible: false, shared };
  const agent = shared[0]!;
  const acts = [activationIn(sa, agent), activationIn(sb, agent)];
  if (acts.includes("conditional")) return { text: "Applies only when the rule's globs match.", compatible: true, shared };
  if (acts.includes("inactive")) return { text: "At least one of these files is not auto-loaded by the agent.", compatible: true, shared };
  const nested = [sa, sb].filter((s, i) => acts[i] === "nested").map(scopeDir).filter(Boolean);
  if (nested.length) return { text: `Applies when working in ${[...new Set(nested)].join(" and ")}.`, compatible: true, shared };
  if (sa.id === sb.id) return { text: "Both are in the same file.", compatible: true, shared };
  if (sa.scope === "user" && sb.scope === "user") return { text: "Both load for every project (user level).", compatible: true, shared };
  if (sa.scope === "user" || sb.scope === "user") return { text: "Both always load (user level and repo root).", compatible: true, shared };
  return { text: "Both load at repo root.", compatible: true, shared };
}
const NO_PRECEDENCE = "No clear precedence; which one wins is unknown.";

const mixedPolarity = (a: Analysis) => new Set(a.clauses.map((c) => c.polarity)).size > 1;
/** Action+object tokens of each polarity, so a swap of objects between polarities shows up. */
const polarityCores = (a: Analysis) => (["pos", "neg", "weak"] as const)
  .map((p) => a.clauses.filter((c) => c.polarity === p).flatMap((c) => c.core).sort().join(" ")).join("|");

// ---- Assembly -----------------------------------------------------------------------------------
interface Item { rule: Rule; a: Analysis; src: Source; order: number }
type Draft = Omit<Finding, "id">;

export function detectFindings(report: Pick<Report, "sources">, options: DetectOptions = {}): Finding[] {
  const { denylist, dataset = "real", settings = [], warn, texts } = options;
  const byId = new Map(report.sources.map((s) => [s.id, s]));
  const scrub = (s: string) => redact(s, { denylist });

  // Evidence text is read from the source as redacted WHOLE, never redacted line by line: the value line of a name/value pair
  // is a secret only because of the name line above it. The redacted whole text is split into rules again (same line numbers); when redaction
  // changed the number of lines, or no rule starts on that line any more, the excerpt is withheld.
  const redactedRules = new Map<string, Map<number, string> | null>();
  const contextText = (item: Item): string | undefined => {
    let rules = redactedRules.get(item.src.id);
    if (rules === undefined) {
      const full = texts?.get(item.src.id) ?? item.src.represented;
      const red = scrub(full);
      rules = red === full ? null : new Map();
      if (rules && red.split("\n").length === full.split("\n").length) for (const r of extractRules(item.src.id, red)) rules.set(r.line, r.text);
      redactedRules.set(item.src.id, rules);
    }
    return rules === null ? item.rule.text : rules.get(item.rule.line);
  };
  // Backstop: a rule whose source lines lie in the same block as a secret key name is never shown, whatever the masker made of it.
  const blocked = new Map<string, Uint8Array>();
  const inWithheldBlock = (item: Item): boolean => {
    let lines = blocked.get(item.src.id);
    if (!lines) blocked.set(item.src.id, lines = secretBlockLines(texts?.get(item.src.id) ?? item.src.represented));
    for (let l = item.rule.line; l <= item.rule.lastLine; l++) if (lines[l - 1]) return true;
    return false;
  };
  const evidenceFor = (item: Item): Evidence => {
    if (inWithheldBlock(item)) return { sourceId: item.src.id, path: item.src.logicalPath, line: item.rule.line, excerpt: null };
    const inContext = contextText(item);
    const raw = inContext === undefined ? "" : scrub(inContext);
    if (inContext === undefined) return { sourceId: item.src.id, path: item.src.logicalPath, line: item.rule.line, excerpt: null };
    const excerpt = raw.length > EXCERPT_CAP ? `${raw.slice(0, EXCERPT_CAP - 1).trimEnd()}…` : raw;
    const ok = snippetSafety(excerpt, denylist, { dataset }) === "ok";
    const heading = ok && item.rule.heading ? scrub(item.rule.heading) : "";
    return { sourceId: item.src.id, path: item.src.logicalPath, line: item.rule.line, excerpt: ok ? excerpt : null, ...(heading && snippetSafety(heading, denylist, { dataset }) === "ok" ? { heading } : {}) };
  };
  const byPathLine = (a: Item, b: Item) => KIND_ORDER.indexOf(a.src.kind) - KIND_ORDER.indexOf(b.src.kind) || compare(a.src.logicalPath, b.src.logicalPath) || compare(a.src.id, b.src.id) || a.rule.line - b.rule.line || a.order - b.order;

  // 1. Rules
  const sources = report.sources.filter((s) => INSTRUCTION_KINDS.has(s.kind) && s.represents === "instructions")
    .sort((a, b) => compare(a.logicalPath, b.logicalPath) || compare(a.id, b.id));
  const items: Item[] = [];
  let truncated = false;
  for (const src of sources) {
    for (const rule of extractRules(src.id, texts?.get(src.id) ?? src.represented)) {
      if (items.length >= MAX_RULES_TOTAL) { truncated = true; break; }
      items.push({ rule, a: analyze(rule), src, order: items.length });
    }
  }
  if (truncated) warn?.(`findings: stopped after ${MAX_RULES_TOTAL} rules; later rules were not compared`);

  const drafts: Draft[] = [];
  const budget = { left: MAX_COMPARISONS };

  // 2. Exact duplicates across distinct sources, and repeats within one file (reported separately)
  const byNorm = new Map<string, Item[]>();
  for (const it of items) if (it.rule.tokens.length >= 2) (byNorm.get(it.rule.norm) ?? byNorm.set(it.rule.norm, []).get(it.rule.norm)!).push(it);
  for (const group of byNorm.values()) {
    const perSource = new Map<string, Item[]>();
    for (const it of [...group].sort(byPathLine)) (perSource.get(it.src.id) ?? perSource.set(it.src.id, []).get(it.src.id)!).push(it);
    if (perSource.size >= 2) {
      const firsts = [...perSource.values()].map((l) => l[0]!).slice(0, 12);
      const agents = AGENTS.filter((a) => firsts.filter((f) => inProfile(f.src, a)).length >= 2);
      const profileAgent = agents[0];
      const loadTogether = agents.length > 0;
      const acts = profileAgent ? firsts.map((f) => activationIn(f.src, profileAgent)) : [];
      drafts.push({
        kind: "duplicate", confidence: "high", rule: "exact",
        ...(loadTogether ? {} : { crossAgent: true }),
        evidence: firsts.map(evidenceFor),
        applicability: !loadTogether ? `Different agents: ${[...new Set(firsts.map((f) => AGENT_NAME[f.src.agent]))].join(" vs ")}.`
          : acts.every((a) => a === "always") ? "All load at repo root." : "Some load only when working in their directory or matching files.",
        precedence: loadTogether ? "Same text repeated; no conflict, but it is loaded more than once." : "Not loaded together.",
        agents: loadTogether ? agents : ownAgents(...firsts.map((f) => f.src)),
      });
    }
    for (const list of perSource.values()) {
      if (list.length < 2) continue;
      drafts.push({
        kind: "repeated-in-file", confidence: "high", rule: "exact-in-file",
        evidence: list.slice(0, 8).map(evidenceFor),
        applicability: "Repeated within one file.",
        precedence: "Same text; no conflict.",
        agents: AGENTS.filter((a) => inProfile(list[0]!.src, a)),
      });
    }
  }

  // 3. Near-duplicates: Jaccard >= 0.85, >= 4 meaningful tokens, EQUAL polarity. Opposite polarity is a conflict, never this.
  const uniqueNorms = [...byNorm.entries()].filter(([, g]) => new Set(g[0]!.rule.tokens).size >= NEAR_DUPLICATE_MIN_WORDS).sort((a, b) => compare(a[0], b[0]));
  const nearPairs = similarPairs(uniqueNorms.map(([, g]) => g[0]!.rule.tokens), NEAR_DUPLICATE_THRESHOLD, budget);
  for (const [i, j, score] of nearPairs) {
    const ga = [...uniqueNorms[i]![1]].sort(byPathLine), gb = [...uniqueNorms[j]![1]].sort(byPathLine);
    if (ga[0]!.a.signature !== gb[0]!.a.signature) continue;
    // "Run tests; skip lint" and "Run lint; skip tests" use the same words with the polarities swapped between objects: not a near-duplicate.
    if ((mixedPolarity(ga[0]!.a) || mixedPolarity(gb[0]!.a)) && polarityCores(ga[0]!.a) !== polarityCores(gb[0]!.a)) continue;
    let pair: [Item, Item] | undefined;
    for (const x of ga) { const y = gb.find((c) => c.src.id !== x.src.id); if (y) { pair = [x, y]; break; } }
    if (!pair) continue;
    const [x, y] = pair;
    const long = Math.min(x.rule.tokens.length, y.rule.tokens.length) >= SHINGLE_FROM_WORDS;
    const shingle = long ? setJaccard(shingles(x.rule.tokens), shingles(y.rule.tokens)) : undefined;
    if (shingle !== undefined && shingle < SHINGLE_MIN) continue;
    const app = applicabilityOf(x.src, y.src);
    drafts.push({
      kind: "near-duplicate", confidence: "medium", rule: "jaccard", score: Math.round(score * 1000) / 1000, threshold: NEAR_DUPLICATE_THRESHOLD,
      ...(shingle !== undefined ? { shingleScore: Math.round(shingle * 1000) / 1000 } : {}),
      evidence: [x, y].sort(byPathLine).map(evidenceFor),
      applicability: app.text, precedence: app.shared.length ? "Nearly the same text; no conflict, but loaded more than once." : "Not loaded together.",
      agents: app.shared.length ? app.shared : ownAgents(x.src, y.src), ...(app.shared.length ? {} : { crossAgent: true }),
    });
  }

  // 4. Conflicts
  interface Candidate { x: Item; y: Item; rule: string; base: Confidence; score?: number; topicScope?: boolean; qualified?: boolean }
  const candidates = new Map<string, Candidate>();
  const pairKey = (x: Item, y: Item) => (x.order < y.order ? `${x.order}:${y.order}` : `${y.order}:${x.order}`);
  const propose = (c: Candidate) => {
    if (c.x.order === c.y.order || c.x.rule.norm === c.y.rule.norm) return;
    const key = pairKey(c.x, c.y);
    const old = candidates.get(key);
    if (!old || CONF_RANK[c.base] < CONF_RANK[old.base]) candidates.set(key, c);
  };

  // 4a. Opposite polarity over the same normalized action+object.
  interface ClauseItem { item: Item; clause: Clause }
  const clauseItems: ClauseItem[] = [];
  for (const item of items) for (const clause of item.a.clauses) {
    if (clause.polarity === "weak") continue; // "don't always run tests" weakens, it does not oppose
    // A single code span is a literal command or file ("Never run `make deploy`"): specific enough to compare.
    if (clause.core.length >= 2 || (clause.core.length === 1 && (SINGLE_OBJECTS.has(clause.core[0]!) || clause.core[0]!.startsWith("`")))) clauseItems.push({ item, clause });
  }
  const byCore = new Map<string, ClauseItem[]>();
  for (const ci of clauseItems) { const k = [...ci.clause.core].sort().join(" "); (byCore.get(k) ?? byCore.set(k, []).get(k)!).push(ci); }
  for (const group of byCore.values()) {
    const pos = group.filter((g) => g.clause.polarity === "pos"), neg = group.filter((g) => g.clause.polarity === "neg");
    let n = 0;
    for (const p of pos) for (const q of neg) { if (n++ >= MAX_PAIRS_PER_GROUP) break; propose({ x: p.item, y: q.item, rule: "polarity", base: "high", score: 1 }); }
  }
  const longClauses = clauseItems.filter((c) => c.clause.core.length >= 3);
  for (const [i, j, score] of similarPairs(longClauses.map((c) => c.clause.core), NEAR_DUPLICATE_THRESHOLD, budget)) {
    const p = longClauses[i]!, q = longClauses[j]!;
    if (score < 1 && p.clause.polarity !== q.clause.polarity && p.clause.polarity !== "weak" && q.clause.polarity !== "weak") {
      propose({ x: p.item, y: q.item, rule: "polarity", base: "medium", score: Math.round(score * 1000) / 1000 });
    }
  }

  // 4b. Curated oppositions: same action+object, opposite stance.
  const hits = items.map((it) => ({ it, hits: topicHits(it.a) }));
  const polarityStances = new Map<string, { pos: { it: Item; q: boolean }[]; neg: { it: Item; q: boolean }[] }>();
  const choice = new Map<string, { it: Item; stance: string }[]>();
  for (const { it, hits: hs } of hits) for (const h of hs) {
    if (h.stance === "pos" || h.stance === "neg") {
      const e = polarityStances.get(h.topic) ?? polarityStances.set(h.topic, { pos: [], neg: [] }).get(h.topic)!;
      e[h.stance].push({ it, q: !!h.qualified });
    } else (choice.get(h.topic) ?? choice.set(h.topic, []).get(h.topic)!).push({ it, stance: h.stance });
  }
  for (const [topic, { pos, neg }] of [...polarityStances].sort((a, b) => compare(a[0], b[0]))) {
    let n = 0;
    for (const p of pos) for (const q of neg) { if (n++ >= MAX_PAIRS_PER_GROUP) break; propose({ x: p.it, y: q.it, rule: `curated:${topic}`, base: "medium", topicScope: true, qualified: p.q || q.q }); }
  }
  for (const [topic, list] of [...choice].sort((a, b) => compare(a[0], b[0]))) {
    let n = 0;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!, b = list[j]!;
      const pa = a.stance.startsWith("!") ? null : a.stance, pb = b.stance.startsWith("!") ? null : b.stance;
      const clash = (pa && pb && pa !== pb) || (pa && b.stance === `!${pa}`) || (pb && a.stance === `!${pb}`);
      if (!clash || n++ >= MAX_PAIRS_PER_GROUP) continue;
      propose({ x: a.it, y: b.it, rule: `curated:${topic}`, base: "medium", topicScope: true });
    }
  }

  // 4c. Numeric mismatch for the same setting phrase ("2-space" vs "4-space").
  const numeric = new Map<string, { it: Item; value: number }[]>();
  for (const { it } of hits) {
    if (it.a.signature.includes("neg") || it.a.signature.includes("weak")) continue;
    for (const h of numericHits(it.a)) (numeric.get(h.key) ?? numeric.set(h.key, []).get(h.key)!).push({ it, value: h.value });
  }
  for (const [key, list] of [...numeric].sort((a, b) => compare(a[0], b[0]))) {
    let n = 0;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (list[i]!.value === list[j]!.value || n++ >= MAX_PAIRS_PER_GROUP) continue;
      // Line length limits are a matter of taste per file type and tool ("80" vs "100" is arguable): low confidence.
      propose({ x: list[i]!.it, y: list[j]!.it, rule: `numeric:${key}`, base: key === "line-length" ? "low" : "medium", topicScope: true });
    }
  }

  for (const c of [...candidates.values()].sort((a, b) => a.x.order - b.x.order || a.y.order - b.y.order)) {
    const [x, y] = [c.x, c.y].sort(byPathLine) as [Item, Item];
    const app = applicabilityOf(x.src, y.src);
    let confidence = c.base;
    // Conditional language, incompatible scope or a glob-scoped source: uncertain applicability, so low.
    const qa = x.a.qualifier.join(" "), qb = y.a.qualifier.join(" ");
    if (x.a.conditional !== y.a.conditional || qa !== qb) confidence = "low";
    // Uncertain is judged under the agent the finding applies to: an @imported AGENTS.md is "always" for Claude Code (its importer's
    // activation) even when Codex would not load it because an AGENTS.override.md shadows it. Low only if no shared agent loads both.
    const uncertainIn = (s: Source, agent: Agent) => { const a = activationIn(s, agent); return a === "conditional" || a === "inactive"; };
    if (!app.compatible || !app.shared.some((agent) => !uncertainIn(x.src, agent) && !uncertainIn(y.src, agent))) confidence = "low";
    // "for React components" narrows a rule; a scope phrase the other rule does not mention means partial overlap at best.
    // A topic's own context word is not a narrower scope ("Use yarn for installs" vs "Never use yarn").
    const generic = TOPIC_CONTEXT[c.rule.replace(/^curated:/, "")] ?? new Set<string>();
    const uncovered = (p: Analysis, q: Analysis) => p.scope.some((t) => !q.rule.tokens.includes(t) && !generic.has(t));
    if (c.topicScope && (uncovered(x.a, y.a) || uncovered(y.a, x.a))) confidence = "low";
    // "Avoid unnecessary comments" / "Add comments explaining complex logic": a qualified directive only partly overlaps its opposite.
    if (c.qualified) confidence = "low";
    drafts.push({
      kind: "conflict", confidence, rule: c.rule, ...(c.rule === "polarity" ? { score: c.score } : {}),
      evidence: [x, y].map(evidenceFor), applicability: app.text,
      precedence: app.shared.length ? NO_PRECEDENCE : "Never loaded together, so nothing to resolve unless you use both agents.",
      agents: app.shared.length ? app.shared : ownAgents(x.src, y.src), ...(app.shared.length ? {} : { crossAgent: true }),
    });
  }

  // 5. Setting conflicts
  drafts.push(...settingConflicts(settings, byId, scrub, denylist, dataset));

  // Deterministic order, then ids.
  const key = (d: Draft) => d.evidence.map((e) => `${e.path}\u0000${String(e.line).padStart(8, "0")}`).join("\u0001");
  drafts.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || CONF_RANK[a.confidence] - CONF_RANK[b.confidence]
    || (b.score ?? 0) - (a.score ?? 0) || compare(key(a), key(b)) || compare(a.rule, b.rule));
  return drafts.map((d, i) => ({ id: `f${i + 1}`, ...d }));
}

// ---- Setting conflicts --------------------------------------------------------------------------
interface Located { value: string; line: number }
interface SettingFacts { sourceId: string; layer: SettingsInput["layer"]; model?: Located; allow: Located[]; deny: Located[] }
const LAYER_RANK = { user: 0, project: 1, local: 2 } as const;
const LAYER_NAME = { user: "user", project: "project", local: "project-local" } as const;

function lineOf(lines: string[], needle: string, from = 0): number {
  for (let i = from; i < lines.length; i++) if (lines[i]!.includes(needle)) return i + 1;
  return 1;
}
const quoted = (s: string) => JSON.stringify(s);

function factsOf(input: SettingsInput): SettingFacts | null {
  let json: unknown;
  try { json = JSON.parse(input.text); } catch { return null; }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const cfg = json as Record<string, unknown>;
  const lines = input.text.split(/\r?\n/);
  const out: SettingFacts = { sourceId: input.sourceId, layer: input.layer, allow: [], deny: [] };
  if (typeof cfg.model === "string") out.model = { value: cfg.model, line: lineOf(lines, `"model"`) };
  const perms = cfg.permissions !== null && typeof cfg.permissions === "object" && !Array.isArray(cfg.permissions) ? cfg.permissions as Record<string, unknown> : {};
  for (const list of ["allow", "deny"] as const) {
    const values = perms[list];
    if (!Array.isArray(values)) continue;
    const from = lineOf(lines, `"${list}"`) - 1;
    for (const v of values) if (typeof v === "string") out[list].push({ value: v, line: lineOf(lines, quoted(v), from) });
  }
  return out;
}

/**
 * "Bash(git push:*)" and "Bash(git push *)" are the same pattern; spacing does not matter and the tool name is compared
 * case-insensitively as documented. The argument keeps its case: `Read(./public/**)` and `Read(./Public/**)` are different paths.
 */
export function normalizeToolPattern(pattern: string): string {
  const p = pattern.trim().replace(/\s+/g, " ").replace(/:\*\)?$/, (m) => (m.endsWith(")") ? " *)" : " *"));
  const paren = p.indexOf("(");
  return paren < 0 ? p.toLowerCase() : p.slice(0, paren).toLowerCase() + p.slice(paren);
}
const splitTool = (norm: string): { tool: string; arg: string | null } => {
  const m = /^([^(]+)\((.*)\)$/.exec(norm);
  return m ? { tool: m[1]!.trim(), arg: m[2]!.trim() } : { tool: norm, arg: null };
};
/** a covers b when a is the same tool with no argument, or a wildcard prefix of b. */
function covers(a: string, b: string): boolean {
  const x = splitTool(a), y = splitTool(b);
  if (x.tool !== y.tool) return false;
  if (x.arg === null || x.arg === "*") return true;
  if (!x.arg.endsWith(" *") && !x.arg.endsWith("*")) return false;
  const prefix = x.arg.replace(/\s*\*$/, "");
  return y.arg !== null && (y.arg === prefix || y.arg.startsWith(`${prefix} `) || y.arg.startsWith(prefix));
}

function settingConflicts(inputs: SettingsInput[], byId: Map<string, Source>, scrub: (s: string) => string, denylist: Denylist | undefined, dataset: "sample" | "real"): Draft[] {
  const facts = inputs.map(factsOf).filter((f): f is SettingFacts => f !== null && byId.has(f.sourceId))
    .sort((a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer] || compare(byId.get(a.sourceId)!.logicalPath, byId.get(b.sourceId)!.logicalPath));
  const out: Draft[] = [];
  const show = (text: string) => { const t = scrub(text); return snippetSafety(t, denylist, { dataset }) === "ok" ? t : null; };
  // Backstop: a settings line in the same JSON node as a secret key name (an `apiKeyHelper` next to `model`) is never shown.
  const raw = new Map(inputs.map((i) => [i.sourceId, i.text]));
  const blocked = new Map<string, Uint8Array>();
  const inWithheldBlock = (id: string, line: number): boolean => {
    let lines = blocked.get(id);
    if (!lines) blocked.set(id, lines = secretBlockLines(raw.get(id) ?? ""));
    return lines[line - 1] === 1;
  };
  const ev = (f: SettingFacts, line: number, text: string): Evidence => {
    const src = byId.get(f.sourceId)!;
    return { sourceId: src.id, path: src.logicalPath, line, excerpt: inWithheldBlock(f.sourceId, line) ? null : show(text) };
  };
  const base = (a: SettingFacts, b: SettingFacts) => {
    const sa = byId.get(a.sourceId)!, sb = byId.get(b.sourceId)!;
    const shared = sharedAgents(sa, sb);
    return { agents: shared.length ? shared : ownAgents(sa, sb), crossAgent: shared.length === 0 ? { crossAgent: true as const } : {}, sa, sb };
  };
  // Model: same key, different values across layers. A higher-precedence layer overriding a shared one is a likely intentional override.
  for (let i = 0; i < facts.length; i++) for (let j = i + 1; j < facts.length; j++) {
    const a = facts[i]!, b = facts[j]!;
    if (!a.model || !b.model || a.model.value.trim().toLowerCase() === b.model.value.trim().toLowerCase()) continue;
    const { agents, crossAgent, sa, sb } = base(a, b);
    const [lo, hi] = LAYER_RANK[a.layer] <= LAYER_RANK[b.layer] ? [a, b] : [b, a];
    const override = LAYER_RANK[lo.layer] < LAYER_RANK[hi.layer];
    const shown = (f: SettingFacts) => `"model": "${publicModel(f.model!.value) ? f.model!.value : "[custom]"}"`;
    const winner = byId.get(hi.sourceId)!.logicalPath;
    out.push({
      kind: "setting-conflict", confidence: "high", rule: "setting:model",
      evidence: [ev(lo, lo.model!.line, shown(lo)), ev(hi, hi.model!.line, shown(hi))],
      applicability: crossAgent.crossAgent ? `Different agents: ${AGENT_NAME[sa.agent]} vs ${AGENT_NAME[sb.agent]}.` : "Both load at repo root.",
      precedence: override ? `${winner} likely wins (${LAYER_NAME[hi.layer]} settings override ${LAYER_NAME[lo.layer]} settings). Likely intentional override.` : NO_PRECEDENCE,
      intentionalOverride: override, agents, ...crossAgent,
    });
  }
  // Permissions: the same normalized tool pattern allowed in one place and denied in another. Overlap that is not identical stays low.
  const seen = new Set<string>();
  for (const a of facts) for (const allow of a.allow) for (const b of facts) for (const deny of b.deny) {
    const na = normalizeToolPattern(allow.value), nd = normalizeToolPattern(deny.value);
    const same = na === nd;
    if (!same && !covers(nd, na) && !covers(na, nd)) continue;
    const key = `${a.sourceId}:${allow.line}:${allow.value}:${b.sourceId}:${deny.line}:${deny.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { agents, crossAgent } = base(a, b);
    out.push({
      kind: "setting-conflict", confidence: same ? "high" : "low", rule: same ? "setting:permissions" : "setting:permissions-overlap",
      evidence: [ev(a, allow.line, `allow: ${allow.value}`), ev(b, deny.line, `deny: ${deny.value}`)],
      applicability: crossAgent.crossAgent ? "Different agents." : "Both load at repo root.",
      precedence: same ? "Deny rules are checked before allow rules, so the deny likely wins." : "Patterns overlap but are not identical; whether the deny applies depends on the exact command.",
      intentionalOverride: false, agents, ...crossAgent,
    });
  }
  return out;
}

// ---- Counts -------------------------------------------------------------------------------------
export function countFindings(findings: readonly Finding[], checked = true): FindingCounts {
  const count = (kind: FindingKind) => findings.filter((f) => f.kind === kind).length;
  const byConfidence = { high: 0, medium: 0, low: 0 };
  for (const f of findings) byConfidence[f.confidence]++;
  const head = (kinds: FindingKind[]) => findings.filter((f) => kinds.includes(f.kind) && isCounted(f)).length;
  return {
    checked, conflicts: count("conflict"), settingConflicts: count("setting-conflict"), duplicates: count("duplicate"),
    nearDuplicates: count("near-duplicate"), repeatedInFile: count("repeated-in-file"), byConfidence,
    headline: {
      conflicts: head(["conflict", "setting-conflict"]), duplicates: head(["duplicate", "near-duplicate"]),
      overrides: findings.filter((f) => isListedOverride(f)).length,
    },
  };
}

/** Medium or high confidence, and in one agent profile (not cross-agent): a finding that can reach a headline. */
const reachesHeadline = (f: Finding) => f.confidence !== "low" && !f.crossAgent && f.agents.length > 0;
/**
 * The one predicate behind the headline badge and the poster card: a counted finding. Intentional model overrides are not
 * conflicts (the documented settings precedence); they are listed separately. Allow vs deny of one pattern still counts.
 */
export const isCounted = (f: Finding): boolean => reachesHeadline(f) && !f.intentionalOverride;
/** A likely intentional override (a higher settings layer replacing a lower one's model): listed with its own count. */
export const isListedOverride = (f: Finding): boolean => reachesHeadline(f) && f.kind === "setting-conflict" && !!f.intentionalOverride;
