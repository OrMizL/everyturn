export const DENY_TOKEN: "[redacted]";
/** One redaction rule family. `apply` is idempotent and returns the input unchanged when nothing matches. `artifactsOnly` families are
 * applied by the privacy scan to generated artifacts and rendered text, not to source files (which may document paths). */
export interface Family { id: string; ocr: boolean; artifactsOnly?: boolean; apply(text: string): string }
export const FAMILIES: readonly Family[];
export function redactGeneric(text: string, options?: { keepPaths?: boolean }): string;
/** The one shared secret-key matcher: a name is secret when it is, or has as a component, a key word (token, secret, auth, key, ...). */
export function isSecretKeyName(name: string, prevWord?: string): boolean;
/** True when some line holds a secret key followed by a separator (the value does not matter). */
export function hasSecretKeyPair(text: string): boolean;
/** True for an absolute, drive, UNC, file:// or tilde path (except an allowlisted user config path) or a `..` that leaves the repo. */
export function hasNonRelativePath(text: string): boolean;
/** NFKC fold plus decoding of printable-ASCII `\u00XX` escapes. */
export function foldText(text: string): string;
/** The text as written and, when different, its folded form. */
export function textForms(text: string): string[];
/** Rendered text (OCR) only: a key that looks like a secret key, even garbled (API_LKEY, AP1_K3Y), followed by `:`/`=` and a value. Linear. */
export function looseSecretKey(text: string): boolean;
export function entropy(value: string): number;
export function highEntropy(value: string): boolean;
export interface DenyMatcher {
  readonly count: number;
  /** Separator-free lowercase terms for fuzzy matching in the privacy scan. Never print these. */
  readonly plainTerms: readonly string[];
  readonly test: RegExp | null;
  apply(text: string): string;
}
export function compileDenyMatcher(terms: readonly string[]): DenyMatcher;
/** 1 for each line of `text` that lies in the same block (YAML/JSON node or prose paragraph) as a secret key name, 0 elsewhere. */
export function secretBlockLines(text: string): Uint8Array;
