import { hasNonRelativePath, hasSecretKeyPair, secretBlockLines, textForms } from "./patterns.mjs";
import type { Denylist } from "./redact";

// Snippet privacy gate. Posters made from real files are public, so evidence text is shown only when
// nothing in it looks private. "unsure" means: show path:line only, never the text. Heuristic and conservative:
// when in doubt the answer is "unsure". Pure: no fs, env, network.

export type SnippetSafety = "ok" | "unsure";
export interface SnippetOptions {
  /** "sample" turns off the private-identifier check (synthetic fixtures). Default "real", the conservative choice. */
  dataset?: "sample" | "real";
}

/** Redaction placeholders written by the shared redactor. */
const REDACTION_MARK = /\[(?:redacted|secret|email|host|path|credentials)\]/i;

// A key-like `name<sep>value` pair is `hasSecretKeyPair` (the redactor's own matcher, patterns.mjs) and a path that is not repo-relative
// is `hasNonRelativePath` (absolute, drive, UNC, file://, any tilde form, `..` out of the repo; only the tool's own user-config logical
// paths such as ~/.claude/settings.json pass). Both are withheld even when the redactor left them alone.
/** `NAME=value` with no spaces (an environment or config assignment). */
const ENV_ASSIGNMENT = /(?<![\w-])[A-Za-z_][\w.-]{2,}=[^\s=]/;

/** Levenshtein distance <= 1 (substitution, insertion or deletion), linear time. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.slice(i) === long.slice(i + 1);
}

const commonPrefix = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const commonSuffix = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; };

/** Lowercase letter/digit words of the text, plus concatenations of 2 and 3 neighbours (a term can span words). */
function wordForms(text: string): string[] {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const forms = new Set(words);
  for (let i = 0; i + 1 < words.length; i++) {
    forms.add(words[i]! + words[i + 1]!);
    if (i + 2 < words.length) forms.add(words[i]! + words[i + 1]! + words[i + 2]!);
  }
  return [...forms];
}

/**
 * Near misses of a denylisted term: within one edit (terms of 5+ characters), or a prefix/suffix overlap of 4+ characters
 * (a fragment of the term). Exact matches are also "unsure": the redactor normally removes them first, so one
 * surviving here means the text was not redacted.
 */
function nearDenyTerm(text: string, terms: readonly string[]): boolean {
  const forms = wordForms(text);
  for (const raw of terms) {
    if (raw.includes("@")) continue;
    const term = raw.toLowerCase();
    for (const w of forms) {
      if (term.length >= 5 && withinOneEdit(w, term)) return true;
      if (term.length >= 4 && w.length >= 4 && (commonPrefix(w, term) >= 4 || commonSuffix(w, term) >= 4)) return true;
    }
  }
  return false;
}

/** Common developer words and acronyms that are never private names (compared case-insensitively). */
const ALLOW = new Set((
  "typescript javascript github gitlab bitbucket eslint prettier vitest jest mocha playwright cypress storybook tailwind react vue svelte angular nextjs next node nodejs deno bun npm pnpm yarn " +
  "docker kubernetes terraform postgres postgresql mysql sqlite mongodb redis graphql openapi swagger zod prisma drizzle express fastify webpack vite rollup esbuild babel python rust golang java kotlin swift " +
  "claude codex cursor copilot windsurf anthropic openai markdown readme changelog license dockerfile makefile json yaml toml xml html css scss sql api apis cli sdk ide orm ui ux ci cd pr prs url uri uuid id " +
  "http https rest grpc ssh tls ssl dns jwt oauth crud pii gdpr todo fixme esm cjs ts js jsx tsx mdx e2e mcp llm ai os db aws gcp azure linux macos windows ios android git vscode " +
  "ok yes no github's typescript's i you we"
).split(/\s+/));

/** Ordinary lowercase words that appear inside hyphenated or snake_case developer phrases ("self-explanatory", "read-only"). */
const COMMON = new Set((
  "self explanatory non obvious read only write pre post commit type safe long running short lived up to date end to end open source built in third party " +
  "side effect side-effect side effects real time run time build test lint unit integration regression feature bug fix hot code base per file line case sensitive " +
  "insensitive error handling log logging data base set up check in out of the box well known well-known high low level top bottom auto generated generated " +
  "main master dev development prod production staging local remote default max min env node api key value name list item first last next back front " +
  "style format config setting settings pull request merge review small large one two three four five six seven eight nine ten zero all any no non ready made " +
  "to do not in on at by for with without sub multi cross re un de co pre-commit e2e ci cd db id ui ux os js ts " +
  "space spaces tab tabs char chars column columns indent indentation"
).split(/\s+/));

const TLD = /\.(?:com|org|net|io|dev|app|ai|co|cloud|xyz|me|us|uk|de|fr|eu|tech|so|inc|biz|info|site|online|page|link|sh(?=\/)|ly|gg|tv)\b/i;

/** Tokens that look like a private identifier: @handle, URL host, CamelCase/kebab/snake_case proper name, a capitalized name mid-sentence. */
function looksPrivate(text: string): boolean {
  if (/(?:^|[^\w@])@[A-Za-z0-9_][\w-]{1,}/.test(text)) return true; // @handle (also scoped package names: when in doubt, unsure)
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^\s/]+/i.test(text)) return true; // URL host
  const plain = text.replace(/`/g, " ");
  const tokens = plain.split(/\s+/).filter(Boolean);
  let sentenceStart = true;
  for (const raw of tokens) {
    const startsSentence = sentenceStart;
    sentenceStart = /[.!?]$/.test(raw);
    const word = raw.replace(/^[("'[{<*]+/, "").replace(/[)"'\]}>*.,;:!?]+$/, "");
    if (!word || /^[\d.,%:/-]+$/.test(word)) continue;
    if (TLD.test(word) && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/|$)/i.test(word)) return true; // bare domain
    // Path-like tokens are judged by their parts ("src/components", "AGENTS.md").
    for (const part of word.split(/[/.]/)) {
      if (!part || /^\d+$/.test(part)) continue;
      const pieces = part.split(/[-_]/).filter(Boolean);
      if (pieces.length > 1) {
        // kebab-case or snake_case: every piece must be an ordinary word.
        if (!pieces.every((p) => /^\d+$/.test(p) || ALLOW.has(p.toLowerCase()) || COMMON.has(p.toLowerCase()))) return true;
        continue;
      }
      if (ALLOW.has(part.toLowerCase())) continue;
      if (/[a-z][A-Z]|[A-Z][a-z]+[A-Z]/.test(part)) return true; // CamelCase / camelCase
      if (/^[A-Z]{2,}$/.test(part)) return true; // unlisted acronym
      if (/^[A-Z][a-z]+$/.test(part) && !startsSentence) return true; // capitalized name in the middle of a sentence
    }
  }
  return false;
}

/**
 * "ok" when the text is safe to show on a poster; "unsure" when it must be withheld (only path:line is shown).
 * Unsure when the text contains a redaction token, a near miss of a denylisted term, or (real datasets only)
 * anything that looks like a private identifier.
 */
export function snippetSafety(text: string, denylist?: Denylist, options: SnippetOptions = {}): SnippetSafety {
  // Every check runs on the text as written and on its NFKC form (fullwidth colons, compatibility letters).
  const forms = textForms(text);
  const real = (options.dataset ?? "real") === "real";
  for (const form of forms) {
    if (REDACTION_MARK.test(form) || hasNonRelativePath(form) || hasSecretKeyPair(form) || ENV_ASSIGNMENT.test(form)) return "unsure";
    // anything in the same block as a secret key name (a `name: API_KEY` item, an anchored secret) is withheld whole.
    if (secretBlockLines(form).includes(1)) return "unsure";
    if (denylist && denylist.plainTerms.length && nearDenyTerm(form, denylist.plainTerms)) return "unsure";
    if (real && looksPrivate(form)) return "unsure";
  }
  return "ok";
}
