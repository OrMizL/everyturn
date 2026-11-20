// Directive polarity and the curated opposition lexicon. Deterministic heuristics only, no LLM.
import { meaningfulTokens, normalizeWords, type Rule } from "./rules";

export type Polarity = "pos" | "neg" | "weak";

export interface Clause {
  /** Normalized words of the clause (stopwords kept: negation parity needs them). */
  words: string[];
  polarity: Polarity;
  /** Action+object tokens: negation, modality and light verbs (run/execute/perform) removed, plurals folded. */
  core: string[];
}

export interface Analysis {
  rule: Rule;
  /** Primary clauses (split at ; and dashes and "but"). unless/except/without/instead start a secondary clause, kept out. */
  clauses: Clause[];
  /** Language that limits where the directive applies (if/when/unless/except/without). Empty when unconditional. */
  qualifier: string[];
  conditional: boolean;
  /** Tokens after for/in/on/within/inside/across: the scope the directive names ("for React components"). */
  scope: string[];
  /** All clause polarities, e.g. "neg" or "neg,pos". Near-duplicates need equal signatures. */
  signature: string;
  /**
   * Set when the rule is not a directive that can conflict: a question, a statement about the past ("we used to never ..."),
   * or a quoted example of a directive. Such a rule has no clauses and no curated or numeric hits.
   */
  nondirective?: "question" | "history" | "example" | "inventory";
}

const NEGATORS = new Set(["not", "never", "no", "cannot", "neither", "nor"]);
/** skip, avoid, forget, omit, disable, ignore, stop, refrain (and their inflections) negate what follows. */
const NEG_VERB = /^(?:skip(?:s|ped|ping)?|avoid(?:s|ed|ing)?|forget(?:s|ting)?|forgot|omit(?:s|ted|ting)?|disabl(?:e|es|ed|ing)|ignor(?:e|es|ed|ing)|stop(?:s|ped|ping)?|refrain(?:s|ed|ing)?)$/;
/** A negator before one of these only weakens the rule ("don't always run tests"); it is not an opposite. */
const WEAKENERS = new Set(["always", "necessarily", "constantly", "blindly"]);
const COND = new Set(["if", "when", "whenever", "while", "once", "where"]);
/** "is not obvious" describes something; it does not forbid an action, so it is not a negator. */
const COPULA = new Set(["is", "are", "was", "were"]);
const EXCEPTION = new Set(["unless", "except", "without"]);
/** "not only", "not just": the negation widens the rule ("do not only run tests"), it does not forbid the action. */
const ONLY = new Set(["only", "just", "simply", "merely"]);
/** A negator or negative verb before an option name rejects it; two cancel ("never avoid named exports"). */
const REJECT_WORDS = new Set(["over", "than", "not", "no", "never", "without", "avoid", "skip", "forbid", "ban", "disable", "stop", "cannot", "instead"]);
/** Removal verbs: "do not remove comments" is about existing comments, not about adding or forbidding them. */
const REMOVAL = /\b(?:remov(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|strip(?:s|ped|ping)?|drop(?:s|ped|ping)?|eras(?:e|es|ed|ing)|purg(?:e|es|ed|ing)|prun(?:e|es|ed|ing)|clean(?:s|ed|ing)?(?: up)?|revert(?:s|ed|ing)?|undo(?:es|ing)?)\b/;
/** Past-tense framing: the rule describes what used to be so; it is not a directive now. */
// "no longer need to run lint" reports that a requirement was dropped; unlike "no longer use X" (a directive) it forbids nothing.
const HISTORY = /\b(?:(?:we|i|they|team|project|docs?) (?:\w+ )?used to|used to (?:never|always|not|avoid|skip|run|use|do)|previously|formerly|in the past|we once|old rule|old guidance|no longer (?:need(?:s|ed)?|have|has) to|no longer (?:required|necessary|needed|mandatory))\b/i;
/** "No longer use default exports" is a directive (do not use them now), so `no longer` is a negator, not past-tense framing. */
const PAREN = /\([^)]*\)/g;
/** A parenthetical past-tense aside ("Never use default exports (previously recommended).") says nothing about the directive itself. */
const withoutHistoryAsides = (text: string) => text.replace(PAREN, (m) => (HISTORY.test(m) ? " " : m));
/** A quoted rule endorsed by follow/obey/apply is a directive, unlike a quoted bad example: `Follow "never add comments" exactly.` */
const ENDORSED = /\b(?:follow|obey|apply|honou?r|respect|enforce|observe|adhere to|stick to|keep to)\W+(?:(?:the|this|that)\W+)?(?:(?:rule|instruction|guideline|directive)\W+)?$/i;
function endorsedQuote(text: string): string | null {
  for (const m of text.matchAll(QUOTED_SPAN)) if (DIRECTIVE_WORD.test(m[0]) && ENDORSED.test(text.slice(0, m.index))) return m[0].slice(1, -1);
  return null;
}
const QUOTED_SPAN = /["“”][^"“”]{6,}["“”]/g;
const DIRECTIVE_WORD = /\b(?:never|always|must|should|avoid|skip|do not|don't|don’t|not|use|add|run|prefer|forbid)\b/i;

/**
 * A per-package inventory line: "Most packages: vitest ...", "`legacy-utils`: jest ...". The label is a package set or a code span, and what
 * follows names a tool without telling anyone to do anything. It describes what exists; two such lines about different packages are not
 * opposites. Anything that reads as an instruction after the colon (an imperative first word, a modal, "only", "prefer") stays a directive.
 */
const INVENTORY_LABEL = /^(?:(?:most|some|many|several|other|remaining|all other|the other|the rest of the)\s+(?:of\s+the\s+)?(?:\w+\s+){0,2}?(?:packages?|modules?|apps?|services?|projects?|libraries|libs?|workspaces?|crates?|directories|folders|repos?)|`[^`\n]+`|(?:@[\w.-]+\/)?[\w.-]+\/[\w./-]*)\s*(?:\([^)]*\))?\s*:\s*(.+)$/i;
const DIRECTIVE_AFTER_LABEL = /^(?:use|uses only|run|prefer|avoid|never|always|do|don't|don’t|ensure|keep|write|add|make|must|should|only|please|stick|follow|test with|install with)\b|\b(?:must|should|never|always|avoid|cannot|shall|required|forbidden|mandatory|prefer|preferred|only|do not|don't|don’t)\b/i;
/**
 * An imperative verb opens the text after the label ("`pkg`: Execute tests with vitest", "Switch to vitest", "Adopt vitest", "Indent with 2
 * spaces"): that is an instruction, not an inventory entry. A bare tool name, a count or a parenthetical never starts like this.
 */
const IMPERATIVE_VERBS = [
  "execute", "switch", "adopt", "indent", "format", "migrate", "convert", "move", "install", "configure", "set", "enable", "disable", "test", "lint", "build",
  "deploy", "commit", "import", "export", "name", "structure", "organi[sz]e", "wrap", "limit", "restrict", "require", "enforce", "declare", "define", "create",
  "update", "remove", "delete", "replace", "rename", "document", "handle", "throw", "return", "choose", "pick", "select", "apply", "validate", "mock", "stub",
  "check", "verify", "put", "place", "order", "sort", "group", "split", "extract", "pin", "upgrade", "downgrade", "bump", "drop", "ban", "forbid", "skip",
  "ignore", "exclude", "include", "trust", "treat", "assume", "call", "invoke", "launch", "start", "stop", "open", "close", "load", "pass", "wire", "register",
  "rely", "go", "pipe", "log", "tag", "label", "lock", "mark", "annotate", "cover", "reuse", "share", "colocate", "prefix", "suffix", "quote", "escape", "sanitize",
];
const IMPERATIVE_AFTER_LABEL = new RegExp(`^(?:(?:please|now|then|just|also|always)\\s+)*(?:${IMPERATIVE_VERBS.join("|")})\\b`, "i");
function isInventory(text: string): boolean {
  const m = INVENTORY_LABEL.exec(text);
  if (m === null) return false;
  const rest = (m[1] ?? "").trim();
  return !DIRECTIVE_AFTER_LABEL.test(rest) && !IMPERATIVE_AFTER_LABEL.test(rest.replace(/^[*_`"“]+/, ""));
}

function nondirectiveOf(rule: Rule): Analysis["nondirective"] {
  const text = rule.text.trim();
  if (/\?["')\]”’]*$/.test(text)) return "question";
  if (isInventory(text)) return "inventory";
  if (HISTORY.test(withoutHistoryAsides(text))) return "history";
  if (endorsedQuote(text) !== null) return undefined;
  for (const m of text.matchAll(QUOTED_SPAN)) if (DIRECTIVE_WORD.test(m[0])) return "example";
  return undefined;
}
const MODALITY = new Set(["always", "never", "must", "should", "shall", "prefer", "please", "ever", "necessarily", "need", "needs", "require", "required", "try", "ensure", "sure", "can", "may", "might", "really", "just", "only"]);
const LIGHT = new Set(["run", "execute", "perform"]);
const SCOPE_PREP = new Set(["for", "in", "on", "within", "inside", "across", "under"]);
const STOP = new Set([
  "a", "an", "the", "of", "to", "in", "on", "at", "by", "as", "is", "are", "be", "been", "being", "was", "were", "it", "its", "this", "that",
  "these", "those", "and", "or", "for", "with", "from", "you", "your", "we", "our", "any", "also", "so", "then", "there", "their", "they",
  "them", "which", "who", "do", "does", "did", "will", "would", "am", "have", "has", "up",
]);

const isNegVerb = (w: string) => NEG_VERB.test(w);

function polarityOf(words: readonly string[]): Polarity {
  let parity = 0;
  let firstNot = -1;
  let widened = false;
  words.forEach((w, i) => {
    if (NEGATORS.has(w)) {
      if (w === "not" && COPULA.has(words[i - 1] ?? "")) return;
      if ((w === "not" || w === "never" || w === "cannot") && ONLY.has(words[i + 1] ?? "")) { widened = true; return; }
      // "no" before a word is a negator ("no comments"); a trailing "no" is not.
      if (w === "no" && i === words.length - 1) return;
      parity++;
      if ((w === "not" || w === "cannot") && firstNot < 0) firstNot = i;
    } else if (isNegVerb(w)) parity++;
  });
  if (widened) return "weak";
  if (parity % 2 === 0) return "pos";
  if (firstNot >= 0 && words.slice(firstNot + 1).some((w) => WEAKENERS.has(w))) return "weak";
  return "neg";
}

/** Action+object tokens of a clause. */
function coreOf(words: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "make" && words[i + 1] === "sure") { i++; continue; } // "make sure to run tests"
    if (w === "longer" && words[i - 1] === "no") continue; // "no longer use X": the negator is `no`
    if (NEGATORS.has(w) || isNegVerb(w) || MODALITY.has(w) || LIGHT.has(w) || STOP.has(w) || COND.has(w)) continue;
    kept.push(w);
  }
  return [...new Set(meaningfulTokens(kept))];
}

/** Area names that scope a rule when written as its label. Generic labels ("Tests:", "Style:") are not here: they name a topic, not an area. */
const SCOPE_LABEL = /^[*_`"“]*(front-?end|back-?end|client|server|web|mobile|ios|android|api|ui|docs|infra(?:structure)?|legacy|cli|desktop|admin|mono-?repo|root|shared|core|lib(?:rary)?|app|worker|workers|service)[*_`"”]*\s*(?:\([^)]*\))?\s*:/i;

/** Split words into primary clauses and the qualifier language, then compute polarity per clause. */
export function analyze(rule: Rule): Analysis {
  const nondirective = nondirectiveOf(rule);
  if (nondirective) return { rule, clauses: [], qualifier: [], conditional: false, scope: [], signature: "", nondirective };
  const primary: string[][] = [[]];
  let secondary = false;
  const qualifier: string[] = [];
  let conditional = false;
  const take = (words: string[], from: number) => { for (const t of meaningfulTokens(words.slice(from, from + 4))) qualifier.push(t); };
  // The directive itself: an endorsed quote (`Follow "never add comments" exactly`) is the rule; a past-tense aside is dropped.
  const quoted = endorsedQuote(rule.text);
  const stripped = withoutHistoryAsides(rule.text);
  const words = quoted !== null ? normalizeWords(quoted) : stripped !== rule.text ? normalizeWords(stripped) : rule.words;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "|" || w === "but") { primary.push([]); secondary = false; continue; }
    if (EXCEPTION.has(w) || w === "instead") {
      secondary = true;
      if (w !== "instead") {
        const next = words.slice(i + 1).find((x) => !STOP.has(x));
        // Every exception clause makes the rule conditional ("unless asked" and "unless approved" alike): uncertain, so low confidence.
        if (next !== undefined || w !== "unless") { conditional = true; take(words, i); }
      }
      continue;
    }
    if (COND.has(w)) { conditional = true; take(words, i); }
    if (!secondary) primary[primary.length - 1]!.push(w);
  }
  // A leading area label ("Frontend: vitest", "**Backend**: jest") scopes the rule to that area: uncertain, so low confidence.
  const label = SCOPE_LABEL.exec(rule.text.trim());
  if (label) { conditional = true; qualifier.push(label[1]!.toLowerCase()); }
  const clauses: Clause[] = [];
  for (const cw of primary) {
    if (!cw.length) continue;
    const core = coreOf(cw);
    if (core.length) clauses.push({ words: cw, polarity: polarityOf(cw), core });
  }
  const first = clauses[0]?.words ?? [];
  const at = first.findIndex((w, i) => i > 0 && SCOPE_PREP.has(w));
  const scope = at < 0 ? [] : meaningfulTokens(first.slice(at + 1));
  return { rule, clauses, qualifier, conditional, scope, signature: clauses.map((c) => c.polarity).join(",") };
}

export const jaccard = (a: readonly string[], b: readonly string[]): number => {
  if (!a.length && !b.length) return 1;
  const sb = new Set(b);
  let inter = 0;
  const sa = new Set(a);
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
};

// ---- Curated opposition lexicon -----------------------------------------------------------------
/** A directive hit on a curated topic: a polarity on one action+object ("comments"), or a chosen option. */
export interface TopicHit {
  topic: string;
  /** polarity topics: "pos" adds/uses the thing, "neg" forbids it. choice topics: the preferred option, "!x" for a rejected one. */
  stance: string;
  /** Polarity topics: the hit is about a qualified or scoped subset ("unnecessary comments", "comments explaining complex logic"), so it only partly overlaps. */
  qualified?: boolean;
}

interface PolarityTopic {
  id: string;
  key: RegExp;
  excl?: RegExp;
  /** Required in every hit (both sides must be about the same context, e.g. an AI response). */
  ctx?: RegExp;
  /** The positive side must contain one of these verbs, so "comments should be short" is not a hit. */
  pos: RegExp;
  /** Extra check on the negative clause. */
  negOk?: (a: Analysis, c: Clause) => boolean;
  posOk?: (a: Analysis, c: Clause) => boolean;
}

const COMMIT_ONLY = new Set(["commit", "change", "code", "anything", "automatically", "yourself", "git", "work", "file", "repo", "repository"]);
const POLARITY_TOPICS: PolarityTopic[] = [
  {
    id: "comments", key: /\b(?:comments?|docstrings?|jsdoc|tsdoc)\b/,
    excl: /\b(?:pr|prs|pull|review|reviews|issue|issues|ticket|github|jira|slack|reply|replies|discussion|todo|todos|commit|commits)\b/,
    pos: /\b(?:add|adds|write|writes|include|leave|put|document|explain|annotate|provide|use|keep)\b/,
  },
  { id: "semicolons", key: /\bsemicolons?\b/, pos: /\b(?:use|add|require|include|end|with|always)\b/ },
  { id: "emoji", key: /\bemojis?\b/, pos: /\b(?:use|add|include|with|sprinkle)\b/ },
  { id: "trailing-commas", key: /\btrailing commas?\b/, pos: /\b(?:use|add|require|include|with|always)\b/ },
  {
    id: "summaries", key: /\b(?:summar(?:y|ies|ize|ise)|recap)\b/,
    excl: /\b(?:pr|prs|pull|commit|commits|release|changelog|issue|ticket|description|notes|doc|docs|readme)\b/,
    ctx: /\b(?:response|responses|reply|replies|answer|answers|message|messages|end|finish|turn|conclusion|after)\b/,
    pos: /\b(?:summarize|summarise|summary|summaries|recap|include|add|end|give|provide|write)\b/,
  },
  {
    id: "commits", key: /\b(?:commit|commits|committing)\b/,
    pos: /\b(?:often|frequently|early|regularly|small|frequent|atomic|incremental|each|every)\b|\bas you go\b/,
    // "never commit" / "don't commit": only the bare prohibition, never "never commit directly to main" or "never commit secrets".
    negOk: (_a, c) => c.core.every((t) => COMMIT_ONLY.has(t)),
    // "Run tests before every commit" is not a commit-frequency directive.
    posOk: (_a, c) => !c.words.includes("before"),
  },
];

const hasAny = (re: RegExp, text: string) => re.test(text);

interface ChoiceTopic {
  id: string;
  options: Record<string, RegExp>;
  /** The topic is a strict either/or: rejecting one option means preferring the other. */
  binary: boolean;
  ctx?: RegExp;
}
const CHOICE_TOPICS: ChoiceTopic[] = [
  { id: "exports", binary: true, options: { named: /\bnamed exports?\b/g, default: /\bdefault exports?\b/g } },
  { id: "test-framework", binary: false, options: { vitest: /\bvitest\b/g, jest: /\bjest\b/g, mocha: /\bmocha\b/g, jasmine: /\bjasmine\b/g } },
  {
    id: "indentation", binary: true, ctx: /\bindent(?:ation|ed|s)?\b|\bspaces?\b|\btabs? (?:width|size)\b/,
    options: { tabs: /\btabs?\b/g, spaces: /\b(?:\d+|two|three|four|eight)[- ]?spaces?\b|\bspaces\b/g },
  },
  { id: "quotes", binary: true, options: { single: /\bsingle quotes?\b/g, double: /\bdouble quotes?\b/g } },
  {
    id: "package-manager", binary: false, ctx: /\b(?:package manager|install|installs|dependenc\w*|use|prefer|using)\b/,
    options: { npm: /\bnpm\b/g, pnpm: /\bpnpm\b/g, yarn: /\byarn\b/g, bun: /\bbun\b/g },
  },
];
/** An odd number of rejecting words among the three before the option rejects it. Even ("never avoid named exports"): preferred. */
const rejected = (before: string) => {
  const words = before.trim().split(" ").filter(Boolean).slice(-3);
  // "do not only use named exports" widens the rule; it does not reject the option.
  return words.filter((w, i) => REJECT_WORDS.has(w) && !(NOT_WORDS.has(w) && ONLY.has(words[i + 1] ?? ""))).length % 2 === 1;
};
const NOT_WORDS = new Set(["not", "never", "cannot"]);
/** Words that narrow a topic to a subset: "avoid unnecessary comments" does not forbid comments. */
const NARROWING = /\b(?:unnecessary|needless|redundant|excessive|(?<!\bnon )(?<!\bnot )obvious|trivial|useless|superfluous|extraneous|noisy|stale|outdated|too many|too much|excess)\b/;
const NARROWING_AFTER = /^\s*(?:\w+\s+)?(?:explaining|describing|documenting|about|that|which|where|saying|restating|stating|mentioning)\b/;

/** Curated hits for one rule. Code spans are literal text, so `npm test` never counts as choosing npm. */
export function topicHits(a: Analysis): TopicHit[] {
  const hits: TopicHit[] = [];
  if (a.nondirective) return hits;
  const norm = a.rule.norm.replace(/`[^`]*`/g, " ").replace(/\s+/g, " ");
  for (const t of POLARITY_TOPICS) {
    if (!hasAny(t.key, norm) || (t.excl && hasAny(t.excl, norm)) || (t.ctx && !hasAny(t.ctx, norm))) continue;
    for (const c of a.clauses) {
      const text = c.words.join(" ");
      if (!hasAny(t.key, text) || REMOVAL.test(text)) continue;
      const key = t.key.exec(text)!;
      const qualified = NARROWING.test(text) || NARROWING_AFTER.test(text.slice(key.index + key[0].length));
      if (c.polarity === "neg") { if (!t.negOk || t.negOk(a, c)) { hits.push({ topic: t.id, stance: "neg", ...(qualified ? { qualified } : {}) }); break; } }
      else if (c.polarity === "pos" && hasAny(t.pos, text) && (!t.posOk || t.posOk(a, c))) { hits.push({ topic: t.id, stance: "pos", ...(qualified ? { qualified } : {}) }); break; }
    }
  }
  for (const t of CHOICE_TOPICS) {
    if (t.ctx && !hasAny(t.ctx, norm)) continue;
    const prefs = new Set<string>();
    const rejs = new Set<string>();
    for (const [name, re] of Object.entries(t.options)) {
      for (const m of norm.matchAll(re)) {
        (rejected(norm.slice(Math.max(0, m.index - 40), m.index)) ? rejs : prefs).add(name);
      }
    }
    if (prefs.size > 1) continue; // two preferred options in one rule: ambiguous
    if (prefs.size === 1) hits.push({ topic: t.id, stance: [...prefs][0]! });
    else if (t.binary && rejs.size === 1) {
      const other = Object.keys(t.options).find((o) => !rejs.has(o));
      if (other) hits.push({ topic: t.id, stance: other });
    }
    for (const r of rejs) if (!prefs.has(r)) hits.push({ topic: t.id, stance: `!${r}` });
  }
  return hits;
}

// ---- Numeric settings ---------------------------------------------------------------------------
export interface NumericHit { key: string; value: number }
const WORD_NUMBER: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10 };
const toNumber = (s: string) => (s in WORD_NUMBER ? WORD_NUMBER[s]! : Number(s.replace("%", "")));
const NUMERIC: { key: string; re: RegExp; ctx?: RegExp }[] = [
  { key: "indent", re: /\b(\d+|one|two|three|four|eight)[- ]spaces?\b/, ctx: /\bindent|\bspaces?\b/ },
  { key: "indent", re: /\bindent(?:ation)?(?: size| width| of| to| with| by)? (\d+)\b/ },
  { key: "line-length", re: /\bline (?:length|width|limit)\D{0,16}?(\d{2,3})\b/ },
  { key: "line-length", re: /\blines? (?:under|below|within|to|at most|max|maximum)\D{0,10}(\d{2,3}) (?:char|column)/ },
  { key: "function-length", re: /\bfunctions? (?:\w+ ){0,3}?(\d{1,4}) lines?\b/ },
  { key: "coverage", re: /\b(\d{1,3})% (?:test )?coverage\b/ },
  { key: "coverage", re: /\bcoverage (?:\w+ ){0,3}?(\d{1,3})%?(?:\s|$)/ },
];
/** Numbers attached to a named setting ("2-space indentation", "functions under 40 lines"). */
export function numericHits(a: Analysis): NumericHit[] {
  const out: NumericHit[] = [];
  if (a.nondirective) return out;
  const norm = a.rule.norm.replace(/`[^`]*`/g, " ");
  // Numbers like 2-space are protected words in `norm`; both "2-space" and "2 spaces" resolve here.
  for (const n of NUMERIC) {
    const m = n.re.exec(norm);
    if (m && m[1] && (!n.ctx || n.ctx.test(norm))) { const value = toNumber(m[1]); if (Number.isFinite(value)) out.push({ key: n.key, value }); }
  }
  return out;
}
