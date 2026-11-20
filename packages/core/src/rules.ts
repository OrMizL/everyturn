// Rule extraction and normalization. Pure: no fs, env, network, Date or random.
//
// A "rule" is one directive unit: a bullet, a numbered item or a directive sentence, with its source id,
// 1-based line number and heading context. Fenced code blocks, frontmatter, blockquotes, tables and HTML comments
// are skipped. Settings and MCP files are not rule text and never come through here.

export interface Rule {
  sourceId: string;
  /** 1-based line of the bullet or sentence in the source file. */
  line: number;
  /** 1-based last source line the rule's text was taken from (a bullet or paragraph that wraps); equals `line` for a one-line rule. */
  lastLine: number;
  /** Heading context, "A > B", markup stripped. */
  heading: string;
  /** Original excerpt: hidden characters and CRLF removed, markup and code spans kept. Capped at 600 characters. */
  text: string;
  /** Normalized words in order, with "|" clause markers (from ; and dashes). */
  words: string[];
  /** Normalized text without markers: the key for exact duplicates. */
  norm: string;
  /** Meaningful tokens: stopwords removed, plural-s folded. Negation, modality, tool names, numbers and values are kept. */
  tokens: string[];
}

export const MAX_RULE_CHARS = 600;
export const DEFAULT_MAX_RULES = 4000;

// ---- Normalization ------------------------------------------------------------------------------
/** Hidden characters: zero width U+200B-U+200F, BOM, U+2060, soft hyphen, bidi embeddings/overrides/isolates, U+061C. */
const HIDDEN = /[​-‏﻿⁠­‪-‮⁦-⁩؜]/g;

/** BOM, zero-width and bidi controls removed; CRLF and CR become LF. The first step of everything. */
export function sanitizeText(text: string): string {
  return text.replace(HIDDEN, "").replace(/\r\n?/g, "\n");
}

const QUOTE_FOLD: [RegExp, string][] = [
  [/[‘’‚‛ʼ´＇]/g, "'"],
  [/[“”„‟＂]/g, '"'],
];
const foldQuotes = (s: string) => QUOTE_FOLD.reduce((acc, [re, to]) => acc.replace(re, to), s);

const CODE_SPAN = /(`{1,3})(?!`)([\s\S]*?[^`])\1(?!`)/g;
const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "at", "by", "as", "is", "are", "be", "been", "being", "was", "were", "it", "its",
  "this", "that", "these", "those", "and", "or", "for", "with", "from", "you", "your", "we", "our", "please", "any", "also",
  "just", "so", "then", "there", "their", "they", "them", "which", "who", "do", "does", "did", "will", "would", "am", "have", "has",
]);
const STEM_KEEP = new Set(["always", "this", "has", "is", "was", "does", "its", "us", "yes", "plus", "bus", "gas", "news", "process", "access", "class", "status", "canvas", "series", "css", "express", "address", "business", "progress", "analysis", "basis"]);

/** Words kept verbatim: code spans, identifiers (snake_case, camelCase), paths, flags, numbers and versions. */
const isProtected = (w: string) => /[`_/\d]|^--|[a-z][A-Z]/.test(w);

const CONTRACTIONS: [RegExp, string][] = [
  [/^won't$/, "will not"], [/^can't$/, "cannot"], [/^shan't$/, "shall not"], [/^ain't$/, "is not"],
  [/n't$/, " not"], [/'re$/, " are"], [/'ve$/, " have"], [/'ll$/, " will"], [/'d$/, " would"], [/'m$/, " am"], [/'s$/, ""],
];

/** Normalize one prose chunk (no code spans) into `out`. */
function proseWords(seg: string, out: string[]): void {
  const s = seg.replace(/[;；]/g, " | ").replace(/\s+[—–-]{1,2}\s+|\s*[—–]\s*/g, " | ");
  let comma = false;
  for (const raw of s.split(/\s+/)) {
    if (!raw) continue;
    if (raw === "|") { out.push("|"); comma = false; continue; }
    // "Use X, never Y": a comma before a negator starts a new clause, so the negation does not flip the first one.
    if (comma && /^(?:never|not|no|don't|don’t|cannot|can't|but)$/i.test(raw.replace(/[.,;:!?]+$/, ""))) out.push("|");
    comma = raw.endsWith(",");
    let w = foldQuotes(raw).replace(/^[("'[{<*]+/, "").replace(/[)"'\]}>*.,;:!?]+$/, "");
    if (!w) continue;
    if (isProtected(w)) { out.push(w); continue; }
    // NFKC folds width/compat forms; quotes are folded again because NFKC can produce them.
    w = foldQuotes(w.normalize("NFKC")).toLowerCase();
    // Contractions are expanded BEFORE punctuation is stripped: n't -> not, won't -> will not, can't -> cannot.
    if (w.includes("'")) for (const [re, to] of CONTRACTIONS) if (re.test(w)) { w = w.replace(re, to); break; }
    for (const part of w.replace(/[^\p{L}\p{N}]+/gu, " ").split(" ")) if (part) out.push(part);
  }
}

/** All normalized words, "|" marks clause breaks. Code spans stay literal (one word each, case kept). */
export function normalizeWords(input: string): string[] {
  const s = sanitizeText(input);
  const out: string[] = [];
  let last = 0;
  for (const m of s.matchAll(CODE_SPAN)) {
    proseWords(s.slice(last, m.index), out);
    const literal = (m[2] ?? "").replace(/\s+/g, " ").trim();
    if (literal) out.push(`\`${literal}\``);
    last = m.index + m[0].length;
  }
  proseWords(s.slice(last), out);
  return out;
}

const stem = (w: string): string => {
  if (isProtected(w) || w.length <= 3 || STEM_KEEP.has(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
};

/** Stopwords removed, plural folded. Negation and modality words are kept. */
export function meaningfulTokens(words: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of words) if (w !== "|" && !STOPWORDS.has(w)) out.push(stem(w));
  return out;
}

export function normalizeRule(text: string): { words: string[]; norm: string; tokens: string[] } {
  const words = normalizeWords(text);
  return { words, norm: words.filter((w) => w !== "|").join(" "), tokens: meaningfulTokens(words) };
}

// ---- Segmentation -------------------------------------------------------------------------------
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
const BREAK = /^ {0,3}([-*_])( *\1){2,} *$/;
const DELIM_CELL = /^\s*:?-+:?\s*$/;
/** A table delimiter row: a pipe and only `---`, `:--`, `--:`, `:-:` cells (`---|---`, `--- | ---`, `|---|---|`). A plain `---` rule has no pipe. */
function isDelimiterRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.every((c) => DELIM_CELL.test(c));
}
const IMPERATIVE = new Set([
  "always", "never", "do", "don", "please", "must", "should", "avoid", "use", "prefer", "run", "keep", "ask", "write", "add", "document",
  "commit", "make", "ensure", "follow", "skip", "test", "only", "when", "if", "before", "after", "no", "be", "put", "create", "update",
  "remove", "delete", "check", "verify", "read", "respond", "reply", "explain", "summarize", "list", "limit", "stick", "treat", "call",
  "import", "export", "name", "format", "lint", "install", "push", "merge", "open", "close", "log", "return", "throw", "wrap", "validate",
  "mock", "stub", "never", "not", "prioritize", "refactor", "review", "mention", "include", "exclude", "leave", "set", "pin", "stop",
]);
const MODAL = new Set(["must", "should", "never", "always", "avoid", "cannot", "shall", "prefer", "required", "forbidden", "mandatory"]);

/** Markup stripped outside code spans: images, links, emphasis, HTML tags. */
function stripMarkup(text: string): string {
  const parts: string[] = [];
  let last = 0;
  const clean = (seg: string) => seg
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[\s(])\*(?=\S)([^*]*?\S)\*(?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1");
  for (const m of text.matchAll(CODE_SPAN)) {
    parts.push(clean(text.slice(last, m.index)), m[0]);
    last = m.index + m[0].length;
  }
  parts.push(clean(text.slice(last)));
  return parts.join("");
}

const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|approx|incl|cf|ex)\.$/i;
/** Split into sentences outside code spans; abbreviations such as "e.g." do not end a sentence. */
function sentences(text: string): string[] {
  const spans: string[] = [];
  const masked = text.replace(CODE_SPAN, (m) => `\u0001${spans.push(m) - 1}\u0001`);
  const parts = masked.split(/(?<=[.!?])\s+(?=[A-Z0-9"'\u0001([])/);
  const merged: string[] = [];
  for (const part of parts) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && ABBREVIATION.test(prev)) merged[merged.length - 1] = `${prev} ${part}`;
    else merged.push(part);
  }
  return merged.map((p) => p.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => spans[Number(i)] ?? "").trim()).filter(Boolean);
}

export interface ExtractOptions {
  /** Stop after this many rules (default 4000). Callers report the truncation. */
  maxRules?: number;
}

/**
 * Segment markdown into directive units. Bullets and numbered items are always units (one per sentence);
 * a plain paragraph sentence is a unit only when it reads as a directive.
 */
export function extractRules(sourceId: string, rawText: string, options: ExtractOptions = {}): Rule[] {
  const max = options.maxRules ?? DEFAULT_MAX_RULES;
  const lines = sanitizeText(rawText).split("\n");
  const rules: Rule[] = [];
  let start = 0;
  // YAML frontmatter at the very top.
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (close > 0) start = close + 1;
  }
  const headings: { level: number; text: string }[] = [];
  let fence: { ch: string; len: number } | null = null;
  let inComment = false;
  let inTable = false;
  let current: { line: number; last: number; bullet: boolean; text: string } | null = null;

  const headingPath = () => headings.map((h) => h.text).join(" > ").slice(0, 120);
  const flush = () => {
    if (!current) return;
    const { line, last, bullet } = current;
    const text = stripMarkup(current.text).replace(/^\[[ xX]\]\s+/, "").replace(/\s+/g, " ").trim();
    current = null;
    for (const sentence of sentences(text)) {
      if (rules.length >= max) return;
      const excerpt = sentence.length > MAX_RULE_CHARS ? sentence.slice(0, MAX_RULE_CHARS) : sentence;
      const n = normalizeRule(excerpt);
      if (n.words.filter((w) => w !== "|").length < 2) continue;
      if (!bullet && !(IMPERATIVE.has(n.words[0] ?? "") || n.words.some((w) => MODAL.has(w)))) continue;
      rules.push({ sourceId, line, lastLine: last, heading: headingPath(), text: excerpt, ...n });
    }
  };

  for (let i = start; i < lines.length && rules.length < max; i++) {
    const line = lines[i] ?? "";
    if (fence) {
      const m = FENCE.exec(line);
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && /^[\s`~]*$/.test(line.slice(m[0].length))) fence = null;
      continue;
    }
    const open = FENCE.exec(line);
    if (open) { flush(); inTable = false; fence = { ch: open[1]![0]!, len: open[1]!.length }; continue; }
    if (inComment) { if (line.includes("-->")) inComment = false; continue; }
    if (/^\s*<!--/.test(line)) { flush(); inTable = false; if (!line.includes("-->")) inComment = true; continue; }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      inTable = false;
      const level = heading[1]!.length;
      while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
      headings.push({ level, text: stripMarkup(heading[2] ?? "").replace(/\s+/g, " ").trim() });
      continue;
    }
    if (!line.trim() || BREAK.test(line)) { flush(); inTable = false; continue; }
    // A pipeless table: a header line with a pipe, then a delimiter row; every line with a pipe after it is a row, up to a blank line or a line without one.
    // A table ends at a blank line, a thematic break, a heading, a fence or an HTML comment (above), at a quotation or a bullet, or at a line without a pipe.
    if (/^\s{0,3}>/.test(line)) { flush(); inTable = false; continue; } // quotations are not directives
    if (inTable) { if (line.includes("|") && !BULLET.test(line)) { flush(); continue; } inTable = false; }
    else if (line.includes("|") && !BULLET.test(line) && isDelimiterRow(lines[i + 1] ?? "")) { flush(); inTable = true; continue; }
    if (/^\s*\|/.test(line)) { flush(); continue; } // table rows are not directives
    const bullet = BULLET.exec(line);
    if (bullet) { flush(); current = { line: i + 1, last: i + 1, bullet: true, text: bullet[2] ?? "" }; continue; }
    const body = line.trim();
    // A paragraph line that already ended a sentence starts its own unit, so the reported line stays accurate.
    if (current && (current.bullet || !/[.!?:]$/.test(current.text.trimEnd()))) { current.text += ` ${body}`; current.last = i + 1; }
    else { flush(); current = { line: i + 1, last: i + 1, bullet: false, text: body }; }
  }
  flush();
  return rules;
}
