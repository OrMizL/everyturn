/** A SKILL.md over the per-file cap is not skipped: only its first SKILL_HEAD_BYTES are read, enough for the frontmatter listing. */
export const SKILL_HEAD_BYTES = 64 * 1024;

/**
 * Drop a multi-byte character cut by the head limit (at most 3 trailing bytes), so the head decodes as UTF-8 when the
 * file itself is valid. Input that is invalid for another reason is returned unchanged, and the caller's decode fails.
 */
export function trimSplitChar(bytes: Uint8Array): Uint8Array {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let cut = 0; cut < 4 && cut < bytes.length; cut++) {
    const head = bytes.subarray(0, bytes.length - cut);
    try { decoder.decode(head); return head; } catch { /* try one byte shorter */ }
  }
  return bytes;
}

/** True when the text opens with YAML frontmatter and the closing `---` (or `...`) is alone on its line, trailing spaces allowed: `---NOT-A-FENCE` is text. */
export const frontmatterCloses = (text: string): boolean => /^﻿?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.test(text);
/**
 * The same check for a head cut from a longer file: the closing fence must be followed by a newline INSIDE the head. A head that ends exactly
 * in `\n---` may be the start of `---not-a-fence` in the full file (the file is longer than the head, or it would not be a head), so it does not close.
 */
export const headFrontmatterCloses = (text: string): boolean => /^﻿?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*\r?\n/.test(text);
