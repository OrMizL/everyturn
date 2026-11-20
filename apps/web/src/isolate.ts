// Mixed-direction runs. The page may be shown right to left; the Latin runs in it (a count with its noun, a size, a file
// name or path, a version) must keep their own order and must not pull the punctuation around them into it. isolate() finds those runs; the page wraps
// each one in <bdi>. Pure: no DOM. A full stop or an ellipsis in an English sentence is never part of a run, and the text is never altered.
// (Built from regex literals, not from escaped strings: a doubled backslash in the bundle would read as a UNC path to the privacy scan.)

// A file name is tried once per token and must start where a token starts, so a long run of name characters is read once, not once per position.
const FILE = /(?<![\w.@/~-])(?:\.{1,2}\/|~\/|\/)?(?:[\w.@-]+\/)*[\w@-][\w.@-]*\.(?:md|mdc|json|svg|png|txt)(?![\w])/.source;
const NUM = /~?\d(?:[\d,.]*\d)?/.source;
const UNIT = /[\s ](?:B|KiB|MiB)\b/.source;
const NOUN = /[\s ](?:files read|files?|sources?|bytes|est\. tokens)(?![A-Za-z])/.source;
const RUN = new RegExp(`(${FILE}|${NUM}(?:${UNIT}|${NOUN})?)`, "g");
const FILE_ONLY = new RegExp(`^${FILE}$`);
const MONO = new RegExp(`^${NUM}(?:${UNIT})?`);

export type Isolated =
  /** Plain text between runs. */
  | { text: string }
  /** A run to wrap in <bdi>. `mono` is its leading part that the page sets in the mono face (the number and a B / KiB / MiB unit); "" for a file name. */
  | { run: string; mono: string };

export function isolate(text: string): Isolated[] {
  const out: Isolated[] = [];
  let pos = 0;
  for (const m of text.matchAll(RUN)) {
    if (m.index > pos) out.push({ text: text.slice(pos, m.index) });
    out.push({ run: m[0], mono: FILE_ONLY.test(m[0]) ? "" : MONO.exec(m[0])?.[0] ?? "" });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push({ text: text.slice(pos) });
  return out;
}
