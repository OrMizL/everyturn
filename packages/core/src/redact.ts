import { DENY_TOKEN, compileDenyMatcher, redactGeneric } from "./patterns.mjs";

// The patterns live in patterns.mjs so scripts/privacy-scan.mjs uses exactly the same rules.
export { DENY_TOKEN };

/** Compiled private-name matchers. Opaque on purpose: the terms are not exposed for printing. */
export interface Denylist {
  readonly count: number;
  /** Separator-free lowercase terms, for fuzzy snippet checks inside core. Never print or export these. */
  readonly plainTerms: readonly string[];
  apply(text: string): string;
}

/**
 * Build case-insensitive matchers for private names. Errors never echo a term.
 * - Emails (any term with "@") match exactly.
 * - Other terms match with "-", "_", ".", whitespace between their words in any mix or absent
 *   ("acme notes" also matches acme-notes, acme_notes, AcmeNotes, acmenotes), including inside paths.
 * - Terms under 4 letters/digits (ignoring separators) only match as whole words; longer ones match anywhere.
 * - Terms under 3 characters (ignoring separators) are rejected.
 */
export function compileDenylist(terms: readonly string[]): Denylist {
  const matcher = compileDenyMatcher(terms);
  return { count: matcher.count, plainTerms: matcher.plainTerms, apply: matcher.apply };
}

/**
 * Redact all public representations. The denylist runs before the generic rules.
 * Reapplying redaction leaves the result unchanged. Every path that is not repo-relative becomes `[path]`; `keepPaths` is only for the
 * CLI's `--print-paths` line (the user asked to see the directory on their own terminal), never for exported text.
 */
export function redact(text: string, opts: { denylist?: Denylist; keepPaths?: boolean } = {}): string {
  return redactGeneric(opts.denylist ? opts.denylist.apply(text) : text, { keepPaths: opts.keepPaths });
}
