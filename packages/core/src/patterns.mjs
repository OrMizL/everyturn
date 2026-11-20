// Shared redaction patterns. Plain JS, no fs/env/network/Date/random, so that redact.ts and
// scripts/privacy-scan.mjs (plain node) use the very same rules and cannot drift apart.
//
// Performance contract: redaction is linear in the input. Secret VALUES have no length cap (a long value is masked whole), so
// linearity comes from parsing each one exactly one way (unrolled quoted-string loops, disjoint character classes), from anchoring
// rules that extend leftwards with a lookbehind (a long run is tried once, not once per character), from a cheap substring gate
// per rule, and from line-by-line processing (PEM blocks use one forward pass over the BEGIN/END marker lists; multi-line values
// walk the following lines once). Only the JWT header and payload keep a cap, which is what keeps "eyJ-eyJ-..." linear.
//
// Two rules are FAIL-CLOSED by design: a secret KEY masks everything after its separator to the end of the line, and
// a PATH is shown only when it is repo-relative. Both are decided by one shared matcher each (isSecretKeyName/findSecretKey,
// replacePaths) that the redactor, the snippet gate, the privacy scan and the OCR check all use.

export const DENY_TOKEN = "[redacted]";
const SECRET = "[secret]";
const PATH_MARK = "[path]";

/** @typedef {{ id: string, ocr: boolean, artifactsOnly?: boolean, apply: (text: string) => string }} Family */

/**
 * A family that runs regex replacements on each line, after a cheap case-insensitive substring gate.
 * @param {string} id
 * @param {Array<[RegExp, string | ((...args: any[]) => string)]>} rules
 * @param {string[] | null} gates
 * @param {boolean} [ocr]
 * @returns {Family}
 */
function lineFamily(id, rules, gates, ocr = true) {
  const has = (low) => !gates || gates.some((g) => low.includes(g));
  return {
    id,
    ocr,
    apply(text) {
      if (!has(text.toLowerCase())) return text;
      return text.split("\n").map((line) => {
        if (!has(line.toLowerCase())) return line;
        let out = line;
        for (const [re, rep] of rules) out = out.replace(re, /** @type {any} */ (rep));
        return out;
      }).join("\n");
    },
  };
}

// ---- Secret keys (fail-closed) -----------------------------------------------------------------
// A name is a secret key when it is, or contains as a component, one of these words (case-insensitive). Components are split at
// `_`, `-`, `.`, spaces and camelCase humps (GITHUB_TOKEN, aws_secret_access_key, x-api-key, clientSecret, db.password); a trailing
// number and a plural `s` are ignored (secret1, tokens). A single component that ENDS in token/secret/password/passwd/passphrase/
// apikey/privatekey/credential counts too (dbpassword, githubtoken).
const KEY_WORDS = new Set([
  "auth", "authorization", "credential", "credentials", "cookie", "session", "bearer", "privatekey", "apikey", "pass", "pwd", "passwd",
  "password", "passphrase", "token", "secret", "key", "signature", "sig", "dsn", "salt", "otp", "pin", "pincode", "jwt", "psk", "hmac",
]);
const KEY_SUFFIX = /(?:token|secret|password|passwd|passphrase|apikey|privatekey|credential)$/;
const splitName = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .split(/[^A-Za-z0-9]+/).filter(Boolean).map((c) => c.toLowerCase());
/** Component that STARTS with a secret word (secretname, passwordhash, tokenfile); in an UPPER_CASE name also KEY... (SERVICE_KEYNAME). */
const KEY_PREFIX = /^(?:secret|password|passwd|passphrase|credential|apikey|privatekey|token(?:file|name|value|id|string|hash|data))/;
function secretComponent(component, upper = false) {
  const c = component.replace(/[0-9]+$/, "");
  if (!c) return false;
  return KEY_WORDS.has(c) || (c.length > 3 && c.endsWith("s") && (KEY_WORDS.has(c.slice(0, -1)) || KEY_SUFFIX.test(c.slice(0, -1)))) || KEY_SUFFIX.test(c) || KEY_PREFIX.test(c)
    || (upper && c.startsWith("key"));
}
/**
 * The exclusions, all of them (over-redaction of prose is accepted everywhere else):
 *  - a bare `key` written as "<prose word> key" ("Primary key: id", "hot key:", "sort key:") is a database/UI term; a compound
 *    name (`primary_key`, `sortKey`) is still masked;
 *  - words that merely contain a key word are not components: keyboard, monkey, hotkey, author, bypass, compass, sigma;
 *  - `session`, `pass`, `auth` ... in plain prose are only keys when a separator follows them;
 *  - `estTokens` / `est_tokens` (est + tokens) is the report's own size field, a number, not a credential;
 *  - not exclusions but deliberate widenings: an UPPER_CASE name also matches a component that STARTS with KEY (SERVICE_KEYNAME), and
 *    any name with a component that starts with secret/password/passwd/passphrase/credential matches (secretname, passwordhash);
 *  - flags such as --passWithNoTests (see FLAG_NOT_SECRET).
 */
const KEY_PROSE = new Set(["primary", "foreign", "hot", "sort", "sorting", "partition", "cache", "map", "lookup", "composite", "natural", "surrogate", "unique", "candidate", "shortcut", "dictionary", "join", "group", "order"]);
/** Words that make a `key` a credential in the classic sense (api key, secret key, access key ...). */
const KEY_QUALIFIERS = new Set(["api", "secret", "private", "access", "auth", "signing", "encryption", "master", "admin", "client", "service", "session", "deploy", "license", "ssh", "gpg", "app", "bearer"]);
/**
 * The CLASSIC subset (token, secret, password, passphrase, api/secret/private/access ... key, PASS/PWD in UPPER_CASE names). The privacy
 * scan applies it to every repository file; the full matcher (auth, key, session, sig, pin, ...) would flag ordinary source code
 * ("key: string"), so that one only runs on generated artifacts and rendered text.
 */
function classicName(parts, prev, upper) {
  if (parts.some((c) => { const s = c.replace(/[0-9]+$/, ""); return KEY_SUFFIX.test(s) || KEY_PREFIX.test(s) || (upper && (s === "pass" || s === "pwd")); })) return true;
  const k = parts.indexOf("key");
  return k >= 0 && KEY_QUALIFIERS.has(k > 0 ? parts[k - 1] : prev);
}
/**
 * True when `name` (an identifier-like run, quotes removed) is a secret key. `prevWord` is the word before it ("pass" + "word").
 * `classic` restricts the answer to the classic subset (see classicName).
 */
export function isSecretKeyName(name, prevWord = "", classic = false) {
  const parts = splitName(name);
  if (!parts.length) return false;
  const prev = prevWord.toLowerCase();
  if (classic) return classicName(parts, prev, /^[A-Z0-9_.-]+$/.test(name)) || (parts.length === 1 && (parts[0] === "word" || parts[0] === "phrase") && prev === "pass");
  if (parts.length === 1 && (parts[0] === "word" || parts[0] === "phrase") && prev === "pass") return true;
  if (parts.length === 1 && parts[0] === "key" && KEY_PROSE.has(prev)) return false;
  if (parts.length >= 2 && parts[parts.length - 2] === "est" && /^tokens?$/.test(parts[parts.length - 1])) return false;
  const upper = /^[A-Z0-9_.-]+$/.test(name);
  return parts.some((c) => secretComponent(c, upper));
}

// Separators: `:` `=` `:=` `=>` `->` and the Unicode colon/equals look-alikes (fullwidth, small, modifier, ratio).
const SEP_CHARS = "\\uFF1A\\uFE55\\uA789\\u2236\\u02F8\\uFE13\\uFF1D\\uFE66\\uA78A\\u2254";
const SEP_RE = new RegExp(`=>|->|:=|[:=${SEP_CHARS}]`, "g");
const HAS_SEP = new RegExp(`[:=>${SEP_CHARS}]`);
const IDENT_CHAR = /[A-Za-z0-9_.-]/;
/** A character that wraps a key without being part of it: Markdown emphasis (`*`, `**`, `~~`), code ticks and quotes. `_` is part of the identifier, which splits at it. */
const isWrap = (c) => c === "*" || c === "`" || c === '"' || c === "'" || c === "~";
/** The length of a closing HTML emphasis tag (`</b>`, `</strong>`, `</em>`, `</i>`) that ends at `j`, or 0: `<b>key</b>:` is a bold key. */
function closingTag(line, j) {
  if (line[j - 1] !== ">") return 0;
  for (const tag of ["</strong>", "</b>", "</em>", "</i>"]) if (j >= tag.length && line.slice(j - tag.length, j).toLowerCase() === tag) return tag.length;
  return 0;
}
/**
 * The key name directly before the separator at `at`: ANY run of horizontal whitespace (one backward walk, no cap: the runs before different
 * separators are disjoint, so a line is walked once), then a closing bracket, quotes and Markdown emphasis (`**key**`, `*key*`, `` `key` ``), then an
 * identifier run (bounded).
 */
function keyBefore(line, at) {
  let j = at;
  while (j > 0 && isHws(line[j - 1])) j--;
  for (let bracket = false; j > 0;) {
    const tag = closingTag(line, j);
    if (isWrap(line[j - 1])) j--;
    else if (tag) j -= tag;
    else if (isHws(line[j - 1])) j--; // `<b>key </b>:` and `** key **:`: whitespace inside the wrapping (fails closed; each step moves left, so still one walk)
    else if (!bracket && line[j - 1] === "]") { bracket = true; j--; } else break;
  }
  const end = j;
  while (j > 0 && end - j < 256 && IDENT_CHAR.test(line[j - 1])) j--;
  if (j === end || line[j] === "-") return null; // no name, or a command-line flag (cli-flag-secret handles those)
  let k = j;
  while (k > 0 && isHws(line[k - 1])) k--;
  const gap = k < j;
  const wordEnd = k;
  while (k > 0 && /[A-Za-z]/.test(line[k - 1])) k--;
  return { name: line.slice(j, end), start: j, prev: gap && wordEnd > k ? line.slice(k, wordEnd) : "" };
}
/** First secret key followed by a separator, at or after `from`. `extra` (lower-case names) are secret keys too: the `value` of a secret name/value pair. */
function findSecretKey(line, from = 0, classic = false, extra = null) {
  SEP_RE.lastIndex = from;
  for (let m; (m = SEP_RE.exec(line));) {
    const key = keyBefore(line, m.index);
    if (key && (isSecretKeyName(key.name, key.prev, classic) || extra?.has(key.name.toLowerCase()))) {
      return { name: key.name, start: key.start, prev: key.prev, sepIndex: m.index, sepEnd: m.index + m[0].length, sep: m[0] };
    }
  }
  return null;
}
/** True when some line holds a secret key followed by a separator (the value does not matter): the snippet gate withholds it. */
export function hasSecretKeyPair(text) {
  if (!HAS_SEP.test(text)) return false;
  return text.split("\n").some((line) => findSecretKey(line) !== null);
}

// Quoted values have no length cap (a long value is masked whole); the unrolled loop parses each one exactly one way, so it stays linear.
const quotedRe = (q) => `${q}[^${q}\\\\]*(?:\\\\.[^${q}\\\\]*)*${q}`;
const QUOTED = `${quotedRe('"')}|${quotedRe("'")}`;
const QUOTED_HEAD = new RegExp(`^(?:${QUOTED})`);
/** A value that is already a placeholder (optionally quoted, followed only by punctuation) is left alone. */
const PLACEHOLDER_VALUE = /^["']?\[(?:secret|redacted|email|host|path|credentials)\]["']?[^A-Za-z0-9_]*$/;
/** A YAML block scalar header, indicators in either order (`|`, `>-`, `|2-`, `>+1`), then nothing or a comment. */
const BLOCK_HEADER = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#.*)?$/;
/** Paired client variables: the password is ONE shell word directly followed by that client, which is then kept. */
const PAIRED = {
  PGPASSWORD: /^(?:psql|pg_dump|pg_restore|pg_dumpall)$/,
  MYSQL_PWD: /^(?:mysql|mysqldump)$/,
  REDISCLI_AUTH: /^redis-cli$/,
};
const WORD_THEN_COMMAND = new RegExp(`^(${QUOTED}|[^\\s"']+)([ \\t]+)([A-Za-z0-9_.-]{1,32})(?![A-Za-z0-9_-])`);
const textColumn = (line) => /^[ \t]*(?:-[ \t]+)*/.exec(line)[0].length;
const indentOf = (line) => /^[ \t]*/.exec(line)[0].length;
const skipHws = (s, p) => { while (s[p] === " " || s[p] === "\t") p++; return p; };
const stripCr = (line) => (line.endsWith("\r") ? line.slice(0, -1) : line);

/**
 * Flow-collection state after a piece of text: net `{` `[` minus `}` `]` and the quote still open at its end, carried from line to line
 * (a collection or a string that continues on the next lines has depth > 0 / a quote). A quote opens only at the start of a token
 * (after whitespace or `[{,:(`), so the apostrophe of "don't" does not swallow the rest of the document.
 */
function flowScan(text, state = { depth: 0, quote: "" }, yaml = false) {
  let { depth, quote } = state;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = ""; continue; }
    // YAML: a `#` outside quotes, at the line start or after whitespace, starts a comment; the brackets in it do not count.
    if (yaml && c === "#" && (i === 0 || /\s/.test(text[i - 1]))) break;
    if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:(]/.test(text[i - 1]))) quote = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return { depth, quote };
}
/** The key opens its line (after list dashes, brackets, a quote and at most one prose word): a YAML/JSON key, so lines indented below it belong to it. */
const KEY_LEAD = /^[ \t]*(?:-[ \t]+)*(?:[{[,][ \t]*)*(?:[A-Za-z]+[ \t]+)?["'`*]*$/;

const SECRET_LINE = /^\s*["']?\[(?:secret|redacted|email|host|path|credentials)\]["']?[^A-Za-z0-9_]*$/;
/** A line that starts a sibling mapping entry or list item (`user: bob`, `- x`), as opposed to the continuation of a scalar. */
const ENTRY_LINE = /^[ \t]*(?:-(?:[ \t]|$)|["']?[A-Za-z0-9_.-]+["']?[ \t]*:(?:[ \t]|$))/;
/** Mask a whole line, keeping its indent; a fully quoted JSON/YAML value keeps its quotes and trailing comma. A placeholder line is left alone. */
function maskWhole(lines, k) {
  const cr = lines[k].endsWith("\r");
  const body = cr ? lines[k].slice(0, -1) : lines[k];
  if (SECRET_LINE.test(body)) return;
  const indent = /^[ \t]*/.exec(body)[0];
  const quoted = QUOTED_HEAD.exec(body.slice(indent.length));
  const rest = quoted ? body.slice(indent.length + quoted[0].length) : "";
  lines[k] = `${indent}${quoted && /^[\s,}\]]*$/.test(rest) ? `${quoted[0][0]}${SECRET}${quoted[0][0]}${rest}` : SECRET}${cr ? "\r" : ""}`;
}

// ---- The value state machine ------------------------------------------------------------------------------
// ONE reading of "what is the value of this key", shared by the line masker, the anchor closure, the block backstop and (through them) the snippet gate
// and the privacy scan. After a secret key it skips any anchors (`&x`) and tags (`!x`, `!!x`, `!<...>`), on the same line or the next, and then reads
// until the closer of whatever opens: `"""` or `'''`, `"` or `'` (blank lines inside are part of the string), `|` / `>` block scalars (with their
// indicators), `[` / `{` (brackets balance across blank lines; both the plain and the YAML comment reading are tried and the longer one wins), or a plain
// scalar with its more-indented continuation lines. An opener that never closes runs to the end of the text (fails closed). One forward cursor, so it
// is linear in the extent it reads, and the lines it covers are masked by the caller (applyExtent), so no line belongs to two extents.
const PREFIX_TOKEN = /(?:&[^\s,[\]{}]+|!(?:<[^>\s]*>|[^\s,[\]{}]*))(?=[ \t]|$)/y;
const ALIAS = /(?<![\w*])\*([A-Za-z_][\w.-]*)/g;
const isComment = (s, p) => s[p] === "#" && (p === 0 || s[p - 1] === " " || s[p - 1] === "\t");
const skippable = (line) => line.trim() === "" || /^\s*#/.test(line);

/** Index just after the closer of quote `q` (`"`, `'`, or a triple) in `s` from `p`, or -1 when the line does not close it. */
function lineCloser(s, p, q) {
  const ch = q[0];
  for (let k = p; k < s.length; k++) {
    const c = s[k];
    if (c === "\\" && ch === '"') { k++; continue; }
    if (c !== ch) continue;
    if (q.length === 3) { if (s[k + 1] === ch && s[k + 2] === ch) return k + 3; continue; }
    if (ch === "'" && s[k + 1] === "'") { k++; continue; }
    return k + 1;
  }
  return -1;
}
function findCloser(at, n, ln, p, q) {
  for (let l = ln; l < n; l++) {
    const e = lineCloser(at(l), l === ln ? p : 0, q);
    if (e >= 0) return { ln: l, col: e };
  }
  return null;
}
/** The line on which the flow collection that opens at (ln, p) ends: where the brackets balance and no quote is open; the last line when it never does. */
function flowEnd(at, n, ln, p, yaml) {
  let st = { depth: 0, quote: "" };
  for (let l = ln; l < n; l++) {
    st = flowScan(l === ln ? at(l).slice(p) : at(l), st, yaml);
    if (st.depth <= 0 && !st.quote) return l;
  }
  return n - 1;
}
/** Skip anchors and tags from (ln, p), moving to following lines when only they are on the line; `stay` limits the move (null: the cursor ends at the end of the text). */
function skipPrefix(at, n, nb, ln, p, jump) {
  for (let jumps = 0; ; jumps++) {
    const s = at(ln);
    p = skipHws(s, p);
    for (let m; ;) {
      PREFIX_TOKEN.lastIndex = p;
      if (!(m = PREFIX_TOKEN.exec(s))) break;
      p = skipHws(s, p + m[0].length);
    }
    if (p < s.length && !isComment(s, p)) return { ln, p, jumped: jumps > 0 };
    const nx = nb[ln + 1];
    if (nx >= n || jumps >= jump.max || !jump.ok(nx)) return null;
    ln = nx;
    p = 0;
  }
}
/**
 * The extent of the value that starts at (i, from): `last` is its last line, `close` the column just after the closing quote on `last` (-1: the whole
 * line), `aliases` every `*name` inside it, `kind` what opened it, `jumped` whether it started on a later line than `i`.
 * o: col = text column and dash = indent of the key's line; lead = the key opens its line; nextAny = an empty value takes the next line whatever its
 * indent (a secret key), otherwise only a more-indented one (an anchor definition).
 */
function valueExtent(at, n, nb, i, from, o) {
  const aliases = [];
  const done = (last, kind, close = -1, jumped = false) => {
    for (let k = i; k <= last; k++) {
      const t = k === i ? at(k).slice(from) : at(k);
      if (t.includes("*")) for (const m of t.matchAll(ALIAS)) aliases.push(m[1]);
    }
    return { last, close, aliases, kind, jumped };
  };
  const at0 = skipPrefix(at, n, nb, i, from, { max: n, ok: (nx) => o.nextAny || indentOf(at(nx)) > o.dash });
  if (!at0) return done(i, "empty");
  const { ln, p, jumped } = at0;
  const s = at(ln);
  const c = s[p];
  const quote = s.startsWith('"""', p) || s.startsWith("'''", p) ? s.slice(p, p + 3) : c === '"' || c === "'" ? c : "";
  if (quote) {
    const e = findCloser(at, n, ln, p + quote.length, quote);
    return e ? done(e.ln, "quote", e.ln > ln ? e.col : -1, jumped) : done(n - 1, "quote", -1, jumped);
  }
  if (c === "[" || c === "{") return done(Math.max(flowEnd(at, n, ln, p, false), flowEnd(at, n, ln, p, true)), "flow", -1, jumped);
  if (BLOCK_HEADER.test(s.slice(p))) {
    let last = ln;
    for (let k = ln + 1; k < n; k++) {
      const t = at(k);
      if (t.trim() === "") continue;
      if (indentOf(t) <= o.col) break;
      last = k;
    }
    return done(last, "block", -1, jumped);
  }
  // A plain scalar: the rest of its line and, for a key that opens its line (or a value that ends in an opening bracket or comma), the more-indented lines below.
  const rule = jumped ? "col" : o.lead || /[{[(\\,]\s*$/.test(s.slice(from)) ? "dash" : null;
  let last = ln;
  if (rule) {
    for (let k = ln + 1; k < n; k++) {
      const t = at(k);
      if (t.trim() === "") continue;
      const ind = indentOf(t);
      if (rule === "col" ? ind <= o.col : ind <= o.dash || (ind <= o.col && ENTRY_LINE.test(t))) break;
      last = k;
    }
  }
  return done(last, "plain", -1, jumped);
}
/** Mask the lines of an extent below the key's line: blank lines stay blank; the last line keeps what follows a closing quote (that text is scanned on its own). */
function applyExtent(lines, k, ext) {
  for (let l = k + 1; l < ext.last; l++) if (lines[l].trim() !== "") maskWhole(lines, l);
  const l = ext.last;
  if (l <= k) return;
  if (ext.close >= 0) lines[l] = SECRET + stripCr(lines[l]).slice(ext.close) + (lines[l].endsWith("\r") ? "\r" : "");
  else if (lines[l].trim() !== "") maskWhole(lines, l);
}
/**
 * Mask the value that starts at `valueStart` on line `k` (everything after the separator goes to the END of the line, whatever it looks like) and the
 * lines of its extent. Kept: the closing quote and trailing `,` `}` `]` of a fully quoted value, a `|` / `>` header (its body is masked), and the text
 * after the closing quote of a multi-line string. `out`/`pos`: what an earlier paired-variable mask already wrote.
 */
function maskValue(ctx, lines, k, line, out, pos, valueStart, o) {
  const ext = valueExtent(ctx.at, ctx.n, ctx.nb, k, valueStart, o);
  const value = line.slice(valueStart);
  const trimmed = value.trim();
  let text;
  if (trimmed === "" || trimmed.startsWith("#")) text = out + line.slice(pos, valueStart) + (trimmed ? SECRET : "");
  else if (ext.kind === "block" && !ext.jumped) text = out + line.slice(pos);
  else {
    const quoted = ext.last === k ? QUOTED_HEAD.exec(value) : null;
    const rest = quoted ? value.slice(quoted[0].length) : "";
    text = out + line.slice(pos, valueStart) + (quoted && /^[\s,}\]]*$/.test(rest) ? `${value[0]}${SECRET}${value[0]}${rest}` : SECRET);
  }
  lines[k] = text + (lines[k].endsWith("\r") ? "\r" : "");
  applyExtent(lines, k, ext);
  return ext;
}
/**
 * The key search of one line: the first secret key, a placeholder value (left alone), a paired client variable (`PGPASSWORD=x psql`: only the word is
 * masked, the command stays). Returns null when nothing is to be masked, `{ text }` when the line was already fully handled, or `{ tail }` with where the
 * value starts, for maskValue.
 */
function maskLine(line, classic, extra = null) {
  let out = "";
  let pos = 0;
  let from = 0;
  const done = () => (out ? { text: out + line.slice(pos) } : null);
  for (;;) {
    const key = findSecretKey(line, from, classic, extra);
    if (!key) return done();
    let valueStart = key.sepEnd;
    while (line[valueStart] === " " || line[valueStart] === "\t") valueStart++;
    const value = line.slice(valueStart);
    if (PLACEHOLDER_VALUE.test(value)) return done();
    const paired = PAIRED[key.name];
    if (paired && key.sep === "=" && valueStart === key.sepEnd && line[key.sepIndex - 1] !== " ") {
      const m = WORD_THEN_COMMAND.exec(value);
      if (m && paired.test(m[3])) {
        out += line.slice(pos, valueStart) + SECRET;
        pos = valueStart + m[1].length;
        from = pos;
        continue;
      }
    }
    return { tail: { out, pos, valueStart, lead: KEY_LEAD.test(line.slice(0, key.start)), col: textColumn(line), dash: indentOf(line) } };
  }
}

/** Kubernetes / GitHub Actions style pairs: `name: API_KEY` next to `value: X` (or `valueFrom`) in the same item. */
const NAME_LINE = /^[ \t]*(?:-[ \t]+)*["']?name["']?[ \t]*:[ \t]*["']?([A-Za-z0-9_.-]{1,256})["']?[ \t]*,?[ \t]*(?:#.*)?$/i;
/** Any `name:` key at the start of a line: its value is RESOLVED (anchors and tags stripped, block scalars and multi-line scalars folded, aliases looked up) before it is judged. */
const NAME_KEY = /^[ \t]*(?:-[ \t]+)*["']?name["']?[ \t]*:/i;
const NAME_TOKEN = /^[A-Za-z0-9_.-]{1,256}$/;
const FLOW_PREFIX = "(?:[&!][^\\s,{}[\\]]*[ \\t]+)*";
const NAME_IN_FLOW = new RegExp(`["']?\\bname["']?[ \\t]*:[ \\t]*${FLOW_PREFIX}(?:["']?([A-Za-z0-9_.-]{1,256})["']?|\\*([^\\s,{}[\\]]+))[ \\t]*[,}]`, "gi");
const VALUE_LINE = /^[ \t]*(?:-[ \t]+)*["']?value(?:From)?["']?[ \t]*:/i;
const VALUE_IN_FLOW = /["']?\bvalue(?:From)?["']?[ \t]*:/i;
const VALUE_KEYS = new Set(["value", "valuefrom"]);
const EXPLICIT_KEY = /^([ \t]*)\?(?:[ \t]+|$)/;
/** How far from its name line a `value` line still belongs to the same item: lines with text, and lines in all (blank and comment lines are skipped). */
const PAIR_REACH = 8;
const NAME_ANY = new RegExp(`["']?\\bname["']?[ \\t]*:[ \\t]*${FLOW_PREFIX}(?:["']?([A-Za-z0-9_.-]{1,256})|\\*([^\\s,{}[\\]]+))`, "gi");
/** A resolved name longer than this is not a name (an environment variable's is not): the resolver stops reading, which also keeps a staircase of `name: |` lines linear. */
const NAME_BUDGET = 512;

/**
 * The resolved scalar that starts at (i, from): anchors and tags skipped (on the next line too), a quoted scalar (also multi-line or triple) as its inner
 * text, a `|` / `>` block scalar and a multi-line plain scalar folded into one string, an alias replaced by what it names. `{ text, last }`, or null when
 * there is no scalar or it is longer than NAME_BUDGET. `col` is the text column of the key.
 */
function resolveScalar(ctx, i, from, col, depth) {
  const { at, n, nb } = ctx;
  const start = skipPrefix(at, n, nb, i, from, { max: 4, ok: () => true });
  if (!start) return null;
  const { ln, p } = start;
  const s = at(ln);
  const c = s[p];
  if (c === "*") {
    const m = /^\*([^\s,[\]{}]+)/.exec(s.slice(p));
    const text = m ? ctx.alias(m[1], depth) : null;
    return text === null ? null : { text, last: ln };
  }
  const quote = s.startsWith('"""', p) || s.startsWith("'''", p) ? s.slice(p, p + 3) : c === '"' || c === "'" ? c : "";
  if (quote) {
    let text = "";
    for (let l = ln; l < n; l++) {
      const t = at(l);
      const a = l === ln ? p + quote.length : 0;
      const e = lineCloser(t, a, quote);
      const piece = t.slice(a, e >= 0 ? e - quote.length : t.length).trim();
      if (piece) text += (text ? " " : "") + piece;
      if (e >= 0) return { text, last: l };
      if (text.length > NAME_BUDGET) return null;
    }
    return null;
  }
  let text = "";
  let last = ln;
  if (BLOCK_HEADER.test(s.slice(p))) {
    for (let k = nb[ln + 1]; k < n; k = nb[k + 1]) {
      const t = at(k);
      if (indentOf(t) <= col) break;
      text += (text ? " " : "") + t.trim();
      last = k;
      if (text.length > NAME_BUDGET) return null;
    }
    return { text, last };
  }
  text = s.slice(p).replace(/[ \t]+#.*$/, "").replace(/[ \t,]+$/, "");
  if (text.length > NAME_BUDGET) return null;
  for (let k = nb[ln + 1]; k < n; k = nb[k + 1]) {
    const t = at(k);
    if (indentOf(t) <= col) break;
    text += ` ${t.trim()}`;
    last = k;
    if (text.length > NAME_BUDGET) return null;
  }
  return { text, last };
}

/**
 * Multi-line flow collections (start line -> end line): where a name and its value may sit on different lines of one `{...}`. No length
 * limit: an unclosed collection runs to the end of the text, which fails closed. Two scanners run side by side, the plain one and
 * the YAML one (` #` starts a comment, so `{name: API_KEY, # }` is still open); the larger group wins. Groups of one scanner are
 * disjoint, so walking them is linear.
 */
function flowGroups(lines) {
  const groups = new Map();
  for (const yaml of [false, true]) {
    let st = { depth: 0, quote: "" };
    let start = -1;
    const close = (end) => { groups.set(start, Math.max(groups.get(start) ?? -1, end)); start = -1; };
    for (let i = 0; i < lines.length; i++) {
      const before = st;
      st = flowScan(lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i], st, yaml);
      if (start < 0 && before.depth === 0 && !before.quote && st.depth > 0) start = i;
      else if (start >= 0 && st.depth <= 0) {
        close(i);
        if (st.depth < 0) st = { depth: 0, quote: "" };
      }
    }
    if (start >= 0) close(lines.length - 1);
  }
  return groups;
}

/** `key: value`, `KEY=value`, `"key": value` ... for every secret key; see maskLine. Linear: each line is visited a bounded number of times. */
function maskSecretKeys(text, classic = false) {
  const r = scanSecretKeys(text, classic);
  if (!r) return text;
  if (r.raw) {
    const written = r.raw.map(stripCr);
    maskBlocks(r.lines, written, blockKeys(written, r), r);
  }
  return r.lines.join("\n");
}
// ---- Markdown tables ---------------------------------------------------------------------------------------------
// `| API_KEY | value |` has no separator the key matcher could see. A table row whose key cell (any cell, emphasis, code ticks and quotes stripped) is a
// secret name masks the cells to its right; a header-style table (a delimiter row `|---|---|` follows the header) whose header cell is a secret name
// masks that column in every row below it, until the table ends (a line that does not start with `|`). The name is judged with the CLASSIC subset and a
// plural `s` ignored, so `| Key | Action |`, `| Auth | required |` and `| Session | 30 |` stay as they are. Only a row that starts with `|` is a row. One
// forward walk per row; a line is split once.
const TABLE_ROW = /^[ \t]*\|/;
const DELIM_CELL = /^[ \t]*:?-+:?[ \t]*$/;
const CELL_TRIM = (c) => c === " " || c === "\t" || c === "*" || c === "_" || c === "`" || c === '"' || c === "'";
/** The cells of a table row as [start, end) ranges: split at every `|` that is not escaped (`\|`); the part after the last pipe counts when it has text. */
function tableCells(line) {
  const cells = [];
  const piped = TABLE_ROW.test(line);
  let start = piped ? -1 : 0; // a pipeless row starts its first cell at the beginning of the line
  for (let i = piped ? line.indexOf("|") : 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") { i++; continue; }
    if (c !== "|") continue;
    if (start >= 0) cells.push([start, i]);
    start = i + 1;
  }
  if (start >= 0 && start < line.length && line.slice(start).trim() !== "") cells.push([start, line.length]);
  return cells;
}
/** Is this cell a secret name? Short, name-like text only (at most 4 words); the cell text has its emphasis, code ticks, quotes and a trailing colon stripped. */
function secretCell(text) {
  let a = 0;
  let b = text.length;
  while (a < b && CELL_TRIM(text[a])) a++;
  while (b > a && (CELL_TRIM(text[b - 1]) || text[b - 1] === ":")) b--;
  if (b - a === 0 || b - a > 64) return false;
  const name = text.slice(a, b);
  if (name[0] === "[" && PLACEHOLDER_VALUE.test(name)) return false; // what the masker wrote is not a name
  if (name.split(/[ \t]+/).length > 4) return false;
  return isSecretKeyName(name, "", true) || isSecretKeyName(name.replace(/s\b/gi, ""), "", true);
}
/** A delimiter row has a pipe and only `---`, `:--`, `--:`, `:-:` cells (`---|---`, `--- | ---`, `|:--|--:|`); a plain `---` rule or front-matter fence has no pipe and is not one. */
const isDelimiterRow = (line) => { if (!line.includes("|")) return false; const cells = tableCells(line); return cells.length > 0 && cells.every(([a, b]) => DELIM_CELL.test(line.slice(a, b))); };
/** Mask the tables of `lines` in place; returns the line numbers of the rows that held a secret key cell or a secret column. */
/** A list item: the same shape extractRules (rules.ts BULLET) treats as a bullet. */
const TABLE_END_BULLET = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;
function maskTables(lines, at) {
  const hits = [];
  const n = lines.length;
  for (let k = 0; k < n;) {
    // A table starts at a row with a leading pipe, or at a header line with a pipe right above a delimiter row (outer pipes optional).
    const header = k + 1 < n && at(k).includes("|") && isDelimiterRow(at(k + 1));
    if (!header && !TABLE_ROW.test(at(k))) { k++; continue; }
    let end = k;
    // Rows after a delimiter row run on while a line holds a pipe (leading pipe or not), up to a blank line or a line without one.
    // A bullet (`- … | …`) ends a pipeless table too, matching extractRules; it is still scanned by every other rule.
    if (header) { end = k + 1; while (end + 1 < n && at(end + 1).includes("|") && !TABLE_END_BULLET.test(at(end + 1))) end++; }
    else while (end + 1 < n && TABLE_ROW.test(at(end + 1))) end++;
    let secretCols = null;
    if (header) {
      const h = at(k);
      secretCols = new Set();
      tableCells(h).forEach(([a, b], c) => { if (secretCell(h.slice(a, b))) secretCols.add(c); });
    }
    for (let r = k; r <= end; r++) {
      if (header && r === k) continue;
      const line = at(r);
      const cells = tableCells(line);
      if (!cells.length || cells.every(([a, b]) => DELIM_CELL.test(line.slice(a, b)))) continue;
      let from = cells.length;
      for (let c = 0; c < cells.length; c++) if (secretCell(line.slice(cells[c][0], cells[c][1]))) { from = c + 1; break; }
      let hit = from < cells.length;
      let text = "";
      let pos = 0;
      cells.forEach(([a, b], c) => {
        if (c < from && !secretCols?.has(c)) return;
        if (c < from) hit = true;
        const inner = line.slice(a, b);
        const t = inner.trim();
        if (t === "" || /^`?\[(?:secret|redacted|email|host|path|credentials)\]`?$/.test(t)) return;
        const lead = inner.slice(0, inner.length - inner.trimStart().length);
        text += line.slice(pos, a) + lead + SECRET + inner.slice(lead.length + t.length);
        pos = b;
      });
      if (pos > 0) lines[r] = text + line.slice(pos) + (lines[r].endsWith("\r") ? "\r" : "");
      if (hit) hits.push(r);
    }
    k = end + 1;
  }
  return hits;
}
/** An anchor DEFINITION (`&name value`): the first anchors of the text, found once, are the global table the aliases are resolved against. */
const ANCHOR_G = /(?<![\w&])&([A-Za-z_][\w.-]*)/g;
/**
 * The line-level masking of maskSecretKeys: the masked lines, the lines as written (full mode), the anchors aliased by a secret key, how far the value
 * of each key line reaches (`reach`), and the name lines whose resolved name is a secret one (`nameHits`). Null: no separator at all.
 */
function scanSecretKeys(text, classic) {
  if (!HAS_SEP.test(text) && !text.includes("|")) return null;
  const lines = text.split("\n");
  const n = lines.length;
  // Full mode: the lines as written, for the block backstop (maskBlocks), which must see the structure before any masking.
  const raw = classic ? null : lines.slice();
  const at = text.includes("\r") ? (k) => stripCr(lines[k]) : (k) => lines[k];
  // Markdown table rows with a secret key cell or column: masked before the line-level pass, which then sees the placeholders.
  const tables = text.includes("|") ? maskTables(lines, at) : [];
  // nb[k]: the first line at or after k that is neither blank nor a comment (n when none), so a run of blank lines is skipped in one step.
  const nb = new Int32Array(n + 1);
  nb[n] = n;
  for (let k = n - 1; k >= 0; k--) nb[k] = skippable(at(k)) ? nb[k + 1] : k;
  // Global anchors: every definition, wherever it is (YAML allows redefinition, so all are kept: fail closed). An alias is resolved at its first definition.
  const defs = new Map();
  if (text.includes("&")) {
    for (let k = 0; k < n; k++) {
      const t = at(k);
      if (!t.includes("&")) continue;
      for (const m of t.matchAll(ANCHOR_G)) { const list = defs.get(m[1]); if (list) list.push(k); else defs.set(m[1], [k]); }
    }
  }
  const memo = new Map();
  const ctx = { at, n, nb, alias: null };
  ctx.alias = (name, depth = 0) => {
    if (memo.has(name)) return memo.get(name);
    const line = defs.get(name)?.[0];
    if (line === undefined || depth > 6) return null;
    memo.set(name, null);
    const t = at(line);
    ANCHOR_G.lastIndex = 0;
    let from = -1;
    for (const m of t.matchAll(ANCHOR_G)) if (m[1] === name) { from = m.index + m[0].length; break; }
    const r = from < 0 ? null : resolveScalar(ctx, line, from, textColumn(t), depth + 1);
    memo.set(name, r ? r.text : null);
    return r ? r.text : null;
  };
  const nameSecret = (r) => r !== null && NAME_TOKEN.test(r.text) && isSecretKeyName(r.text, "", classic);
  const flowSecret = (m) => { const t = m[1] ?? (m[2] ? ctx.alias(m[2]) : null); return t !== null && t !== undefined && isSecretKeyName(t, "", classic); };
  // Names of YAML anchors whose alias (`*name`) is used under a secret key: the anchor DEFINITION holds the same secret, wherever it is.
  const aliased = new Set();
  // reach[line]: the last line of the value of the key on `line`; reachMask[line]: the same, but a line that only holds what FOLLOWS the closing quote
  // of a multi-line string is left out (the masker keeps that text, which is scanned on its own), while the excerpt gate still counts it.
  const reach = new Int32Array(n).fill(-1);
  const reachMask = new Int32Array(n).fill(-1);
  const nameHits = new Map();
  const note = (line, ext, key) => {
    if (ext.last > reach[line]) reach[line] = ext.last;
    const m = ext.close >= 0 && ext.last > key ? ext.last - 1 : ext.last;
    if (m > reachMask[line]) reachMask[line] = m;
  };
  const apply = (k, extra, reachLine = k) => {
    const before = at(k);
    const r = maskLine(before, classic, extra);
    if (!r) return;
    if (before.includes("*")) for (const a of before.matchAll(ALIAS)) aliased.add(a[1]);
    if (r.text !== undefined) { lines[k] = r.text + (lines[k].endsWith("\r") ? "\r" : ""); return; }
    const t = r.tail;
    const ext = maskValue(ctx, lines, k, before, t.out, t.pos, t.valueStart, { col: t.col, dash: t.dash, lead: t.lead, nextAny: true });
    for (const a of ext.aliases) aliased.add(a);
    note(reachLine, ext, k);
  };
  // The `value` lines of the item whose name line is `i` (see NAME_LINE): forward over the sibling lines, then backward.
  const pairSearch = (i, col, dash) => {
    // Forward: sibling lines of the same item (same column; deeper lines continue the previous field; a shallower one or a new `-` ends it).
    // Blank lines and comment lines between the two fields do not separate them, however many there are; PAIR_REACH counts the lines that carry
    // text. (Linear: a run of blank lines is walked only by the name lines at most PAIR_REACH text lines above it.)
    for (let k = i + 1, seen = 0; k < n && seen < PAIR_REACH; k++) {
      if (skippable(lines[k])) continue;
      seen++;
      const ind = indentOf(lines[k]);
      if (ind < col || (ind <= dash && /^[ \t]*-/.test(lines[k]))) break;
      if (ind === col && VALUE_LINE.test(lines[k])) apply(k, VALUE_KEYS, i);
    }
    // Backward: `value` written before `name`; the item's own `- ` line is the last one looked at.
    for (let k = i - 1, seen = 0; k >= 0 && seen < PAIR_REACH; k--) {
      if (skippable(lines[k])) continue;
      seen++;
      const tc = textColumn(lines[k]);
      if (tc < col) break;
      if (tc === col && VALUE_LINE.test(lines[k])) apply(k, VALUE_KEYS, i);
      if (/^[ \t]*-/.test(lines[k])) break;
    }
  };
  const groups = /\bname\b/i.test(text) && /\bvalue/i.test(text) ? flowGroups(lines) : null;
  for (let i = 0; i < n; i++) {
    const line = at(i);
    const nk = NAME_KEY.exec(line);
    if (nk) {
      // `- name: API_KEY` (the fast path), or a name behind an anchor or tag, a folded block scalar, a multi-line scalar or an alias.
      const fast = NAME_LINE.exec(line);
      const r = fast ? { text: fast[1], last: i } : resolveScalar(ctx, i, nk[0].length, textColumn(line), 0);
      if (nameSecret(r)) { nameHits.set(i, r.last); pairSearch(i, textColumn(line), indentOf(line)); }
    } else if (line.includes("?")) {
      // `? password` / `: value`: an explicit (complex) key.
      const ex = EXPLICIT_KEY.exec(line);
      if (ex) {
        const r = resolveScalar(ctx, i, ex[0].length, ex[1].length, 0);
        const k = nb[i + 1];
        if (r && NAME_TOKEN.test(r.text) && isSecretKeyName(r.text, "", classic) && k < n && indentOf(at(k)) === ex[1].length && /^[ \t]*:(?:[ \t]|$)/.test(at(k))) {
          const l = at(k);
          const vs = skipHws(l, l.indexOf(":") + 1);
          const ext = maskValue(ctx, lines, k, l, "", 0, vs, { col: ex[1].length, dash: ex[1].length, lead: true, nextAny: true });
          for (const a of ext.aliases) aliased.add(a);
          note(i, ext, k);
          nameHits.set(i, i);
        }
      }
    }
    if (VALUE_IN_FLOW.test(line)) {
      // `{"name": "API_KEY", "value": "x"}` on one line
      NAME_IN_FLOW.lastIndex = 0;
      for (let m; (m = NAME_IN_FLOW.exec(line));) {
        if (flowSecret(m)) { apply(i, VALUE_KEYS); break; }
      }
    }
    // A flow pair split across lines (`- {name: API_KEY,` / `value: x}`): every `value` in the collection belongs to the secret name.
    const group = groups?.get(i);
    if (group !== undefined) {
      const values = [];
      let secretName = false;
      for (let k = i; k <= group; k++) {
        if (!secretName) for (const m of lines[k].matchAll(NAME_ANY)) if (flowSecret(m)) secretName = true;
        if (VALUE_IN_FLOW.test(lines[k])) values.push(k);
      }
      if (secretName) for (const k of values) apply(k, VALUE_KEYS, i);
    }
    apply(i, null);
  }
  // Closure over the anchors: an anchor aliased by a secret key is masked where it is defined (value and children), before or after its use; what
  // such a definition itself aliases is then masked in turn. Each name is processed once.
  const work = [...aliased];
  const seen = new Set();
  while (work.length) {
    const name = work.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const l of defs.get(name) ?? []) {
      const t = at(l);
      let hit = null;
      for (const m of t.matchAll(ANCHOR_G)) if (m[1] === name) { hit = m; break; }
      if (!hit) continue; // already masked as part of a secret value
      const from = skipHws(t, hit.index + hit[0].length);
      const rest = t.slice(from).trim();
      if (rest !== "" && !rest.startsWith("#") && PLACEHOLDER_VALUE.test(rest)) continue;
      const ext = maskValue(ctx, lines, l, t, "", 0, from, { col: textColumn(t), dash: indentOf(t), lead: true, nextAny: false });
      note(l, ext, l);
      for (const a of ext.aliases) if (!seen.has(a)) { aliased.add(a); work.push(a); }
    }
  }
  return { lines, raw, aliased, reach, reachMask, nameHits, flowSecret, tables };
}

// ---- Secret blocks (backstop) ------------------------------------------------------------------------------------
// Three rounds of regex patches on YAML shapes kept finding a deeper form, so a STRUCTURAL rule backs them up. Whatever the line-level masker decided, everything in the same BLOCK as a secret key name is untrustworthy: excerpts from it are withheld (secretBlockLines) and,
// in exported text, what follows the key through the end of the block is masked (maskBlocks).
//  - A YAML/JSON NODE block is the node that holds the key: the key's parent line (or the item line for a list item or a name/value pair)
//    and everything indented below it. Blank lines do not end it; only a line at the node's indent or shallower that is not inside an
//    open bracket or a multi-line string does. There is no line limit.
//  - A PROSE block is the paragraph of the key (blank lines, fences and ATX headings end a paragraph; a multi-line string is one paragraph).
//  - Either way the block reaches at least as far as the key's own VALUE (the extent of the state machine above).
const PLACEHOLDER_END = /\[(?:secret|redacted|email|host|path|credentials)\]["']?[^A-Za-z0-9_[\]{}]*$/;
const FENCE_LINE = /^[ \t]*(?:```|~~~)/;
const ATX = /^#{1,6}[ \t]/;
const COMMENT_LINE = /^[ \t]*#/;
const KEY_OPENS = /^[ \t]*[{[,"']/;

const TRIPLE = /"""|'''/g;
const VALUE_QUOTE = /(?:[:=]|^[ \t]*-)[ \t]+(?:[&!][^\s,[\]{}]*[ \t]+)*(["'])/g;
const LINE_QUOTE = /^[ \t]*(?:[&!][^\s,[\]{}]*[ \t]+)*(["'])/;
/**
 * The multi-line strings of the text: for every line strictly inside one (after the line that opens it, up to the line that closes it) the line that
 * opens it, else -1 (the line that opens it and the line that closes it are ordinary lines). A triple quote opens one wherever it is; a `"` or `'` only at a value position (after `:` / `=` / a list dash and any anchors and
 * tags, or at the start of a line that follows a line ending in a separator), so a stray apostrophe in prose never carries over a line. One forward pass.
 */
function lexSpans(L) {
  const n = L.length;
  const inside = new Int32Array(n).fill(-1);
  let open = null;
  let afterSep = false;
  for (let k = 0; k < n; k++) {
    const s = L[k];
    let p = 0;
    if (open) {
      const e = lineCloser(s, 0, open.q);
      if (e < 0) { inside[k] = open.start; continue; }
      p = e; // the closing line is a line like any other (what follows the closer is its own text), so it is not "inside"
      open = null;
    } else if (s.trim() === "") continue;
    // The next triple quote and the next value quote of this line: a match found from an earlier position is still the next one while it lies at or after
    // the cursor, and "none" stays none, so a line is searched once instead of once per quote, so the scan is linear.
    let tNext;
    let vNext;
    while (p < s.length) {
      if (tNext === undefined || (tNext && tNext.index < p)) { TRIPLE.lastIndex = p; tNext = TRIPLE.exec(s); }
      const t = tNext;
      if (vNext === undefined || (vNext && vNext.index < p)) { VALUE_QUOTE.lastIndex = p; vNext = VALUE_QUOTE.exec(s); }
      let v = vNext;
      let vAt = v ? v.index + v[0].length - 1 : -1;
      if (!v && afterSep && p === 0) { const m = LINE_QUOTE.exec(s); if (m) { v = m; vAt = m[0].length - 1; } }
      if (!t && !v) break;
      let q, from;
      if (t && (!v || t.index <= vAt)) { q = t[0]; from = t.index + 3; } else { q = s[vAt]; from = vAt + 1; }
      const e = lineCloser(s, from, q);
      if (e < 0) { open = { q, start: k }; break; }
      p = e;
    }
    if (!open && !COMMENT_LINE.test(s)) afterSep = /[:=][ \t]*(?:#.*)?$/.test(s);
  }
  return inside;
}

/** Parent line and last line (inclusive) of the node that starts on each line, from the indentation and the open brackets. One forward pass. */
function structure(L, inside) {
  const n = L.length;
  const parent = new Int32Array(n).fill(-1);
  const end = new Int32Array(n).fill(-1);
  // P[k] = open brackets before line k (a quote never carries over a line, so a stray apostrophe stays local). The masker drops what follows
  // a secret key to the end of the line, brackets included, so on already-masked text a line that ends in a placeholder opens nothing and a
  // placeholder-only line closes whatever was open: this keeps the blocks of redacted text inside the blocks of the text as written (idempotence).
  const P = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) {
    let depth = P[k] + flowScan(L[k], { depth: 0, quote: "" }, true).depth;
    if (SECRET_LINE.test(L[k])) depth = Math.min(depth, 0);
    else if (PLACEHOLDER_END.test(L[k])) depth = Math.min(depth, P[k]);
    P[k + 1] = depth;
  }
  const stack = [];
  const lineAt = [];
  let last = -1;
  let front = L[0]?.trim() === "---";
  const popAll = () => { while (lineAt.length) { end[lineAt.pop()] = last; stack.pop(); } };
  for (let k = 0; k < n; k++) {
    const line = L[k];
    if (line.trim() === "") continue;
    // Inside a multi-line string: no node event, whatever the text says; the line belongs to the node that opened the string.
    if (inside[k] >= 0) { parent[k] = lineAt.length ? lineAt[lineAt.length - 1] : -1; last = k; continue; }
    if (FENCE_LINE.test(line) || (k === 0 && front) || (front && /^(?:---|\.\.\.)[ \t]*$/.test(line))) {
      if (k > 0 && front && /^(?:---|\.\.\.)[ \t]*$/.test(line)) front = false;
      popAll();
      last = k;
      continue;
    }
    if (COMMENT_LINE.test(line)) { last = k; continue; }
    const ind = indentOf(line);
    while (stack.length && stack[stack.length - 1] >= ind && P[k] - P[lineAt[lineAt.length - 1]] <= 0) { end[lineAt.pop()] = last; stack.pop(); }
    parent[k] = lineAt.length ? lineAt[lineAt.length - 1] : -1;
    stack.push(ind);
    lineAt.push(k);
    last = k;
  }
  popAll();
  return { parent, end };
}
/** First and last line of the prose paragraph of each line. A blank line inside a multi-line string does not end the paragraph. */
function paragraphs(L, inside) {
  const n = L.length;
  const first = new Int32Array(n);
  const last = new Int32Array(n);
  let s = -1;
  const close = (to) => { for (let k = s; k < to; k++) last[k] = to - 1; s = -1; };
  for (let k = 0; k < n; k++) {
    const line = L[k];
    const alone = inside[k] < 0 && (FENCE_LINE.test(line) || ATX.test(line));
    if ((line.trim() === "" && inside[k] < 0) || alone) {
      if (s >= 0) close(k);
      first[k] = last[k] = k;
      continue;
    }
    if (s < 0) s = k;
    first[k] = s;
  }
  if (s >= 0) close(n);
  return { first, last };
}
/**
 * The secret keys of full mode, one per line and kind. K1: a secret key followed by a separator (any value, a placeholder too). K2: a
 * `name: <secret name>` pair in a flow collection or on a line. K3: a `name:` key whose RESOLVED value is a secret name (folded, anchored, tagged,
 * aliased, on the next line). K4: the definition of an anchor aliased by a secret key. `nameForm` keys belong to a name/value item, whose value may
 * come before the name.
 * @returns {Array<{ i: number, kind: "node" | "prose", nameForm: boolean, anchor: boolean, keep: number[], head?: number }>}
 */
function blockKeys(L, scan) {
  const { aliased, nameHits, flowSecret } = scan;
  const keys = [];
  let fence = false;
  let front = L[0]?.trim() === "---";
  for (let i = 0; i < L.length; i++) {
    const line = L[i];
    if (FENCE_LINE.test(line)) { fence = !fence; continue; }
    if (i === 0 && front) continue;
    if (front && /^(?:---|\.\.\.)[ \t]*$/.test(line)) { front = false; continue; }
    if (line.trim() === "" || COMMENT_LINE.test(line)) continue;
    if (aliased.size && line.includes("&")) {
      for (const m of line.matchAll(ANCHOR_G)) if (aliased.has(m[1])) { keys.push({ i, kind: "node", nameForm: false, anchor: true, keep: [] }); break; }
    }
    if (HAS_SEP.test(line)) {
      const key = findSecretKey(line, 0, false);
      if (key) {
        const node = KEY_LEAD.test(line.slice(0, key.start)) || KEY_OPENS.test(line) || fence || front;
        keys.push({ i, kind: node ? "node" : "prose", nameForm: false, anchor: false, keep: [] });
      }
      if (/\bname/i.test(line)) {
        for (const m of line.matchAll(NAME_ANY)) if (flowSecret(m)) { keys.push({ i, kind: "node", nameForm: true, anchor: false, keep: [i] }); break; }
      }
    }
  }
  for (const [i, last] of nameHits) {
    const keep = [];
    for (let k = i; k <= last && k < i + 8; k++) keep.push(k);
    keys.push({ i, kind: "node", nameForm: true, anchor: false, keep, head: i });
  }
  return keys;
}
/** The first and last line of the block of a key, and the first line to mask. */
function blockRanges(L, keys, scan) {
  if (!keys.length) return [];
  const inside = lexSpans(L);
  const { parent, end } = structure(L, inside);
  const para = keys.some((k) => k.kind === "prose") ? paragraphs(L, inside) : null;
  const { reach, reachMask } = scan;
  // hi: the last line of the block for the excerpt gate (the value's closing line counts); mhi: for masking (what follows a closing quote is left to the line masker).
  return keys.map((key) => {
    const { i } = key;
    const at = key.head ?? i;
    if (key.kind === "prose") return { key, lo: para.first[i], hi: Math.max(para.last[i], reach[i]), mhi: Math.max(para.last[i], reachMask[i]), from: i + 1 };
    // A list item (a line that starts with `-`) and an anchored node are their own start; any other key belongs to its parent node.
    const s = key.anchor || /^[ \t]*-/.test(L[at]) ? at : (parent[at] >= 0 ? parent[at] : at);
    const base = Math.max(end[s], i);
    return { key, lo: s, hi: Math.max(base, reach[i], reach[at]), mhi: Math.max(base, reachMask[i], reachMask[at]), from: key.nameForm ? s : i + 1 };
  });
}
/** Left as they are inside a masked block: `key: [secret]` (what the line masker already made of a value, so the key stays readable) lines of brackets only, and a `key: |` header (its body is masked line by line). */
const KEY_PLACEHOLDER = /^[ \t]*(?:-[ \t]+)*["']?[A-Za-z0-9_.-]+["']?[ \t]*[:=][ \t]*["']?\[(?:secret|redacted|email|host|path|credentials)\]["']?[ \t]*,?[ \t]*$/;
const BRACKETS_ONLY = /^[\s[\]{}),]*$/;
const KEY_BLOCK_HEADER = /^[ \t]*(?:-[ \t]+)*["']?[A-Za-z0-9_.-]+["']?[ \t]*:[ \t]*[|>][+-]?[0-9]?[ \t]*$/;
const keepInBlock = (line) => BRACKETS_ONLY.test(line) || KEY_PLACEHOLDER.test(line) || KEY_BLOCK_HEADER.test(line);
/**
 * Mask the lines of every block after its key (the whole item for a name/value pair); the key lines themselves keep what the line masker made of them.
 * `written` is the text as it was written: the blocks are found on it, because masking removes the brackets and indentation that bound them.
 */
function maskBlocks(lines, written, keys, scan) {
  const ranges = blockRanges(written, keys, scan);
  if (!ranges.length) return;
  const diff = new Int32Array(lines.length + 1);
  const keep = new Uint8Array(lines.length);
  for (const { key, from, mhi } of ranges) {
    if (from <= mhi) { diff[from]++; diff[mhi + 1]--; }
    for (const k of key.keep) keep[k] = 1;
  }
  let depth = 0;
  for (let k = 0; k < lines.length; k++) {
    depth += diff[k];
    if (depth > 0 && !keep[k] && lines[k].trim() !== "" && !keepInBlock(stripCr(lines[k]))) maskWhole(lines, k);
  }
}
/**
 * Which lines of `text` lie in the same block as a secret key name (1) or not (0), for the text as written and in its folded form.
 * The snippet and excerpt gates withhold anything from such a line, whatever the line-level masker decided.
 */
export function secretBlockLines(text) {
  const n = text.split("\n").length;
  const out = new Uint8Array(n);
  for (const form of textForms(text)) {
    const scan = scanSecretKeys(form, false);
    if (!scan) continue;
    const L = scan.raw.map(stripCr);
    const keys = blockKeys(L, scan);
    if (!keys.length && !scan.tables.length) continue;
    if (L.length !== n) { out.fill(1); continue; }
    for (const row of scan.tables) out[row] = 1;
    const diff = new Int32Array(n + 1);
    for (const { lo, hi } of blockRanges(L, keys, scan)) { diff[lo]++; diff[hi + 1]--; }
    for (let k = 0, d = 0; k < n; k++) { d += diff[k]; if (d > 0) out[k] = 1; }
  }
  return out;
}

// ---- Literal values of source-code credential keys ------------------------------------------------
/** Credential words that are too common in source for the classic scan (`auth: boolean`), checked only for a literal value. */
const LITERAL_KEY_WORDS = new Set(["auth", "authorization", "cookie", "cookies", "session", "bearer", "jwt", "psk", "hmac", "dsn"]);
const isLiteralKeyName = (name) => splitName(name).some((c) => LITERAL_KEY_WORDS.has(c.replace(/[0-9]+$/, "")));
/** Values that are placeholders, types, empty, references to the environment or templates: never a committed secret. */
const BENIGN_LITERAL = /^(?:|string|number|boolean|any|unknown|null|undefined|true|false|none|nil|x{3,}|\*+|\.{3}|…|change[-_ ]?me|replace[-_ ]?me|example|placeholder|redacted|secret|token|password|dummy|fake|sample|test|demo|todo|your[\w .-]*|<[^>]*>|\[[^\]]*\]|\{\{.*\}\}|\$\{[^}]*\}|\$[A-Za-z_]\w*|%[^%]*%|.*(?:process\.env|import\.meta\.env|os\.environ|getenv|\benv\.).*)$/i;
const PASCAL_CASE = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/;
/** Ordinary configuration words (enum values, algorithms, modes) that appear as the value of auth/cookie/session/hmac keys: never a committed secret. */
const CONFIG_WORDS = new Set([
  "oauth", "oauth2", "oauth1", "oidc", "openid", "saml", "sso", "basic", "bearer", "digest", "token", "jwt", "apikey", "api", "none", "true", "false", "yes", "no", "on", "off",
  "required", "optional", "disabled", "enabled", "auto", "default", "lax", "strict", "secure", "httponly", "cookie", "cookies", "session", "header", "headers", "query", "body",
  "form", "json", "bcrypt", "argon2", "scrypt", "pbkdf2", "md5", "sha1", "sha224", "sha256", "sha384", "sha512", "hs256", "hs384", "hs512", "rs256", "rs384", "rs512", "es256",
  "es384", "es512", "ps256", "eddsa", "ed25519", "hmacsha256", "hmacsha512", "aes", "aes128", "aes256", "rsa", "ecdsa", "local", "memory", "redis", "database", "db", "file", "cache",
  "user", "admin", "guest", "public", "private", "anonymous", "session-id", "sessionid", "csrf", "xsrf", "cors", "ldap", "kerberos", "ntlm", "negotiate", "mtls", "tls", "ssl", "plain", "password",
]);
const configWord = (inner) => CONFIG_WORDS.has(inner.toLowerCase().replace(/[-_. ]/g, "")) || CONFIG_WORDS.has(inner.toLowerCase());
/** A literal that is not a known configuration word counts as a secret candidate when it is 12+ characters long, or 8+ with the entropy of a random string (3+ bits per character). */
const secretShaped = (inner) => inner.length >= 12 || (inner.length >= 8 && entropy(inner) >= 3);
/**
 * Is `value` (what follows the separator, trimmed) a literal secret candidate? A quoted string without whitespace that is not a
 * placeholder (template strings with `${}` are code); an unquoted single token of 6+ characters with a digit or `=` that is not a type
 * name. Quoted prose with spaces ("Authentication failed") is a message, not a credential.
 */
function literalValue(value) {
  const quoted = QUOTED_HEAD.exec(value) ?? /^`[^`$]*`/.exec(value);
  if (quoted) {
    const inner = quoted[0].slice(1, -1).trim();
    return !BENIGN_LITERAL.test(inner) && !/\s/.test(inner) && !configWord(inner) && secretShaped(inner);
  }
  const token = /^[^\s,;)}\]]+/.exec(value)?.[0] ?? "";
  if (token.length < 6 || BENIGN_LITERAL.test(token) || configWord(token) || PASCAL_CASE.test(token) || /^[\w$.]+\(/.test(token)) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(token)) return false; // a member path (config.auth.token)
  return /[0-9=]/.test(token);
}
function maskLiteralKeys(text) {
  if (!HAS_SEP.test(text)) return text;
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (!HAS_SEP.test(line)) return line;
    SEP_RE.lastIndex = 0;
    for (let m; (m = SEP_RE.exec(line));) {
      const key = keyBefore(line, m.index);
      if (!key || !isLiteralKeyName(key.name)) continue;
      let start = m.index + m[0].length;
      while (line[start] === " " || line[start] === "\t") start++;
      if (!literalValue(line.slice(start))) continue;
      changed = true;
      return line.slice(0, start) + SECRET;
    }
    return line;
  });
  return changed ? lines.join("\n") : text;
}

// ---- OCR: loosely written secret keys ------------------------------------------------------------
/** Letters OCR confuses fold together: 0/O, 1/l/I/!, 3/E, 5/S (case folded first). */
const ocrFold = (s) => s.toLowerCase().replace(/0/g, "o").replace(/[1l]/g, "i").replace(/3/g, "e").replace(/5/g, "s");
const OCR_WORDS = ["token", "secret", "password", "passwd", "passphrase", "apikey", "privatekey", "credential", "credentials", "cookie", "session", "bearer", "authorization", "jwt", "psk", "hmac", "dsn", "pwd"].map(ocrFold);
const OCR_SUFFIXES = ["token", "secret", "password", "passwd", "passphrase", "apikey", "privatekey", "credential", "credentials"].map(ocrFold);
const OCR_QUALIFIERS = new Set([...KEY_QUALIFIERS].map(ocrFold));
const OCR_KEY = ocrFold("key");
/** Edit distance <= 1 (substitution, insertion or deletion), linear. */
function withinOneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
/**
 * One OCR-read component (`LKEY`, `K3Y`, `passw0rd`): is it a secret word? The folded confusions (0/O, 1/l/I, 3/E, 5/S) are already
 * handled; on top of them one garbled character is allowed in words of 7+ letters (password, session, authorization ...). Shorter
 * words match exactly (a fuzzy "passwd" would read "passed: 645" as a key).
 */
function looseWord(c) {
  if (c === "pass" || c === "auth") return true; // whole component only: "author" and "keyboard" never match
  const singular = c.length > 3 && c.endsWith("s") ? c.slice(0, -1) : c;
  for (const w of OCR_WORDS) if (c === w || singular === w || (w.length >= 7 && c.length >= 7 && withinOneEdit(c, w))) return true;
  if (c.length >= 6) {
    for (const s of OCR_SUFFIXES) if (c.endsWith(s)) return true;
    if (c.startsWith("passw") || c.startsWith("secret") || c.startsWith("credential")) return true;
  }
  return false;
}
/** `key` as a component: exactly, or with one garbled or extra character (LKEY, KEI), and only after a qualifier (api, secret, access, ...). */
const looseKey = (c, prev) => OCR_QUALIFIERS.has(prev) && (c === OCR_KEY || (c.length >= 3 && c.length <= 4 && withinOneEdit(c, OCR_KEY)));
const OCR_VALUE_AFTER = /^["'\]`*]{0,4}[ \t]*[:=：＝][ \t]*[^\s[]/;
/** The value is already one of the redactor's placeholders (`cookie: "[secret]"`): nothing is left to leak. */
const OCR_PLACEHOLDER_AFTER = /^["'\]`*]{0,4}[ \t]*[:=：＝][ \t]*["'`]?\[(?:secret|redacted|email|host|path|credentials)\]/i;
/** One identifier as OCR reads it: letters and digits joined by `_` `.` `-`; every component of it is judged (GITHUB_T0KEN_VALUE, SESSlON_ID). */
const OCR_WORD = /[A-Za-z0-9]+(?:[_.-][A-Za-z0-9]+)*/g;
/**
 * Rendered-text only (OCR noise garbles key names: API_KEY read as `API_LKEY` or `AP1_K3Y`): is there a key that LOOKS like a secret key,
 * followed by `:` or `=` and a value? Words are tokenised first and each tested on its own (camelCase and `_ . -` split into components, the
 * previous word taken for "api key:"), so the cost is linear in the text: no pattern runs over a whole identifier.
 * Whole components only: `Author: Someone`, `keyboard: us`, `monkey: x`, `hotkey: y` are not secret keys.
 */
export function looseSecretKey(text) {
  OCR_WORD.lastIndex = 0;
  let prevEnd = -1;
  let prevComp = "";
  for (let m; (m = OCR_WORD.exec(text));) {
    const end = m.index + m[0].length;
    // components of this word: camelCase humps; the word before it counts as the previous component when only `_ . -` or spaces lie between
    const gap = prevEnd >= 0 && m.index - prevEnd <= 3 ? text.slice(prevEnd, m.index) : null;
    let prev = gap !== null && /^[ _.-]+$/.test(gap) ? prevComp : "";
    // Components: the parts between `_ . -`, each also split at camelCase humps. A part that splits is tried whole as well, because OCR reads an
    // `i` as `l` (SESSlON_ID: "SESSl" + "ON" would hide "session").
    const parts = m[0].length > 4096 ? [m[0]] : m[0].split(/[_.-]/).filter(Boolean);
    // the value must follow the key within 64 characters, the whitespace between them not counted (an aligned key sits far from its separator)
    let q = end;
    while (q < end + 4 && isWrap(text[q] ?? "")) q++;
    let w = q;
    while (w < text.length && isHws(text[w])) w++;
    const tail = text.slice(end, q) + text.slice(w, w + 64);
    const followed = OCR_VALUE_AFTER.test(tail) && !OCR_PLACEHOLDER_AFTER.test(tail);
    for (const part of parts) {
      const pieces = part.length > 4096 ? [part] : part.split(/(?<=[a-z])(?=[A-Z])/);
      const folded = pieces.map(ocrFold);
      // Every component counts, not only the last: the key is secret if any of its words is. (`est_tokens` is the report's own size field.)
      const secret = (c, before) => !(before === "est" && /^tokens?$/.test(c)) && (looseWord(c) || looseKey(c, before));
      if (followed) {
        if (pieces.length > 1 && secret(ocrFold(part), prev)) return true;
        for (let k = 0, before = prev; k < folded.length; before = folded[k++]) if (secret(folded[k], before)) return true;
      }
      prev = folded[folded.length - 1];
    }
    prevEnd = end;
    prevComp = prev;
  }
  return false;
}

// Clients whose flag carries a password. psql is not here: its -p is the port (the password comes from PGPASSWORD / a prompt).
// The value must not start with "-" (mysql -p --host=x prompts instead) or be a quote, backtick or punctuation: "`mysql -p`" in prose stays.
// No length cap on any value: a long password is masked whole, not up to a limit.
const FLAG_VALUE = `(${QUOTED}|[^\\s\\-"'\`),;.\\]]\\S*)`;
const flagRe = (flag) => new RegExp(`(?<![\\w-])(${flag})([ \\t]*)${FLAG_VALUE}`, "g");
const CLI_COMMANDS = [
  { cmd: /(?<![\w-])(?:mysql|mariadb|mysqldump|mysqladmin|sshpass)(?![\w-])/i, flag: flagRe("-p") },
  { cmd: /(?<![\w-])redis-cli(?![\w-])/i, flag: flagRe("-a") },
  { cmd: /(?<![\w-])(?:docker|podman|skopeo)[ \t]+login(?![\w-])/i, flag: flagRe("-p") },
];
// curl -u user:pass / -uuser:pass / --user user:pass (a bare user name prompts for the password, so it is kept).
const CURL = /(?<![\w-])curl(?![\w-])/i;
const CURL_USER = new RegExp(`(?<![\\w-])(-u[ \\t]*|--user(?:[ \\t]+|=))(${QUOTED}|[^\\s"']+)`, "g");
/** A long flag whose NAME is a secret key (any prefix or suffix): --token, --db-password, --client-secret, --pass, --auth ... */
const SECRET_FLAG = new RegExp(`(?<![\\w-])(--[A-Za-z0-9][A-Za-z0-9-]{0,127})([ \\t]+|=)(${QUOTED}|\\S+)`, "g");
/**
 * For a flag the secret word must be the LAST component of its name (--access-token, --db-password, --pass): --token-file, --password-stdin
 * and --passWithNoTests name a file or a switch, not the secret itself; a negated switch (--no-tokens) takes no value.
 */
const flagIsSecret = (name) => !/^no-/i.test(name) && isSecretKeyName(splitName(name).pop() ?? "");

/** Ranges of one shell line between command separators (; & |), quotes respected: each segment is one command. */
function commandSegments(line) {
  const out = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = ""; else if (c === "\\" && quote === '"') i++; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === ";" || c === "&" || c === "|") { out.push([start, i]); start = i + 1; }
  }
  out.push([start, line.length]);
  return out;
}

// ---- Paths (fail-closed allowlist) -------------------------------------------------------------
// In exported text a path is shown only when it is repo-relative: no leading `/` or `\`, no drive letter, no `~`, no file://,
// and no `..` that leaves the repo. Everything else becomes `[path]`, whoever's path it is. The one exception is the tool's own
// logical paths for user-scope agent config files (fixed names, no user name): USER_CONFIG_PATHS.
const USER_CONFIG_PATHS = [
  /^~\/\.claude\/(?:CLAUDE\.md|settings\.json|settings\.local\.json)$/,
  /^~\/\.codex\/AGENTS(?:\.override)?\.md$/,
  /^~\/\.(?:claude|codex|agents)\/skills\/[^/\s]+\/SKILL\.md$/,
  // The same names as the poster shortens them in the middle ("~/.claude/skills/…/SKILL.md", "~/.claude/…/settings.json"); the check also
  // runs on the NFKC form of the text, where the ellipsis character reads as three dots.
  /^~\/(?:\.(?:claude|codex|agents)\/(?:skills\/)?)?(?:…|\.\.\.)\/(?:SKILL\.md|CLAUDE\.md|settings(?:\.local)?\.json|AGENTS(?:\.override)?\.md)$/,
];
/** A middle-truncated user config path that lost its `~` ("…/skills/release-notes/SKILL.md", "…/settings.json"): the part after the ellipsis. */
const ELLIPSIS_CONFIG = /^\/(?:skills\/[^/\s]+\/)?(?:SKILL\.md|CLAUDE\.md|settings(?:\.local)?\.json|AGENTS(?:\.override)?\.md)$/;
const USER_CONFIG_ROOT = /^(~\/\.(?:claude|codex|agents))(?:\/|$)/;
/**
 * A tilde path is shown only under an EXACT known name (the list above). Backslashes count as `/`, and a `..` or `.` segment anywhere
 * disqualifies the path before the list is consulted. Anything else under ~/.claude, ~/.codex or ~/.agents (user-named rules, import
 * targets) keeps only its root: `~/.claude/[path]`.
 */
function classifyTilde(core) {
  // `~/.claude/CLAUDE.md:12` (the poster's evidence references) is the allowlisted name plus a line number.
  const norm = core.replace(/\\/g, "/").replace(/:\d+(?::\d+)?$/, "");
  if (!norm.split("/").some((seg) => seg === ".." || seg === ".")) {
    if (USER_CONFIG_PATHS.some((re) => re.test(norm))) return null;
    const root = USER_CONFIG_ROOT.exec(norm);
    if (root && !/^~\/\.claude\/projects(?:\/|$)/.test(norm)) return `root:${root[1]}`; // the projects folder names people: all of it goes
  }
  return /^~[A-Za-z_]/.test(core) ? "user" : "abs";
}
/** First segments that make a SINGLE-segment absolute path a path ("/opt"); other one-word tokens ("/review", "/init") are commands. */
const ROOT_NAMES = new Set(["opt", "usr", "var", "etc", "tmp", "home", "users", "srv", "mnt", "media", "root", "data", "bin", "sbin", "lib", "lib64", "proc", "sys", "dev", "boot", "run", "private", "volumes", "library", "applications", "system", "snap", "nix"]);
/** "user": the path names a person or machine (home directories, /srv, UNC, tilde-user). "abs": any other absolute path. null: not a path. */
function classifyPosix(path) {
  const segs = path.split("/").filter(Boolean);
  if (!segs.length) return null;
  const first = segs[0].toLowerCase();
  const second = (segs[1] ?? "").toLowerCase();
  if ((["home", "users", "srv"].includes(first) && segs.length >= 2) || first === "root"
    || (["var", "export", "usr"].includes(first) && second === "home" && segs.length >= 3)) return "user";
  return segs.length >= 2 || ROOT_NAMES.has(first) ? "abs" : null;
}
function classifyPath(kind, core) {
  switch (kind) {
    case "url": return /^file:/i.test(core) ? (classifyPosix(core.replace(/^file:\/*/i, "/")) ?? "abs") : null;
    case "drive": return /^[A-Za-z]:[\\/]{1,2}(?:Users|Documents and Settings)[\\/]/i.test(core) ? "user" : "abs";
    case "unc": return "user";
    case "env": return "user";
    case "tilde": return classifyTilde(core);
    case "posix": return classifyPosix(core);
    default: { // a relative path is fine unless its ".." segments climb out of where it started
      let depth = 0;
      for (const seg of core.split(/[\\/]+/)) {
        if (seg === "..") { if (--depth < 0) return "abs"; } else if (seg && seg !== ".") depth++;
      }
      return null;
    }
  }
}
const PATHISH = "[^\\s\"'`<>]";
const SEG = "[^\\s/\"'`<>]";
const WINSEG = "[^\\s\\\\\"'`<>]";
// `*` `}` `)` `]` before a slash mean a glob or a template ("**/*.ts", "${HOME}/x"), not the start of a path (see NO_PATH_BEFORE_AT).
// An @import (`@/opt/x`, `@~/x.md`, `@../x`) is a path like any other: the `@` is part of the match and goes with it. The lookbehind
// therefore checks the character before the `@`, or before the path when there is none.
const NO_PATH_BEFORE_AT = "(?<![\\w.~/\\\\%+*})\\]$@-])@?";
const PATH_RE = new RegExp([
  // scheme://... (only file: is a path; other URLs are left alone and, being consumed here, are not cut into "/x" pieces)
  `((?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,15}:\\/\\/${PATHISH}*)`,
  // C:\... and C:/... ; user names with spaces ("C:\Users\Fake Alice\x") run up to the next separator
  `((?<![A-Za-z0-9])[A-Za-z]:(?:[\\\\/]{1,2}(?:Users|Documents and Settings)[\\\\/]{1,2}${WINSEG}{1,256}(?: ${WINSEG}{1,256}){0,3}(?=[\\\\/])|[\\\\/])${PATHISH}*)`,
  // \\server\share\...
  `((?<![\\w\\\\])\\\\{2,4}[A-Za-z0-9_.$-]{1,63}\\\\{1,2}${PATHISH}+)`,
  // $HOME/x, ${HOME}/x, $env:USERPROFILE\x, %USERPROFILE%\x, %APPDATA%\x ...: the home directory through an environment variable is the home path itself.
  // No left boundary: a root glued to a word ("x$HOME/a") is masked too. A bare `$HOME` with no slash after it is not a path.
  `((?:\\$\\{?(?:HOME|USERPROFILE)\\}?|\\$\\{?env:(?:USERPROFILE|HOMEPATH|HOME|APPDATA|LOCALAPPDATA)\\}?|%(?:USERPROFILE|HOMEPATH|APPDATA|LOCALAPPDATA)%|%HOMEDRIVE%%HOMEPATH%)["']?[\\\\/]${PATHISH}*)`,
  // ~, ~/x, ~\x, ~alice/x, ~alice\x (a name without a slash is prose: "~N tokens", "~5", "~~strike~~")
  `(${NO_PATH_BEFORE_AT}~(?:(?:[A-Za-z_][\\w.-]{0,63})?[\\\\/]${PATHISH}*)?(?![\\w~])(?![ \\t]+[\\d.,]))`, // "~ 394" (an OCR'd approx sign before a number) is not a home path
  // /a/b, /opt, /home/Fake Alice/x
  `(${NO_PATH_BEFORE_AT}(?:\\/(?:home|users|srv|var\\/home|export\\/home|usr\\/home)\\/${SEG}{1,256}(?: ${SEG}{1,256}){1,3}(?=\\/)|\\/)${PATHISH}*)`,
  // ../x, a/../../x, ..
  `(${NO_PATH_BEFORE_AT}(?:[\\w@+-][\\w.@+-]*[\\\\/]+)*\\.\\.(?![\\w.])(?:[\\\\/]${PATHISH}*)?)`,
].join("|"), "gi");
const PATH_KINDS = ["url", "drive", "unc", "env", "tilde", "posix", "dotdot"];
const PATH_TAIL = /(?<=[^.,;:!?)\]}*])[.,;:!?)\]}*]+$/;
const MAYBE_PATH = /[\\/~]|\.\./;
const ENV_ROOT_CASE = /^(?:\$\{?(?:HOME|USERPROFILE)[}"'\\/]|\$\{?[eE][nN][vV]:|%)/;
// Spaces inside a path: a folder name can hold spaces ("~/Google Drive/Tax 2026/x.md"), and the match above stops at the
// first one. A path that is not allowed is therefore EXTENDED past its match, and fails closed:
//  - written directly after a quote or backtick, it runs to the matching quote (to the end of the line when none closes);
//  - unquoted, it continues over spaces while the next word still looks like a path piece: it holds a `/` or `\`, or ends in a file
//    extension, or (when the last piece so far has no extension and the path names a person/home) is capitalised or numeric
//    ("~/Fake Alice" -> both words). A closing punctuation mark ends it ("~/x/y. Next").
const PUNCT_END = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", "*"]);
const WORD_PIECE = /[^\s"'`<>]+/y;
const HAS_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const QUOTE_MARKS = new Set(['"', "'", "`"]);
// Horizontal whitespace: any run of these is ONE separator, however long or mixed (two spaces, a tab, a no-break or ideographic space).
const HWS = "[ \\t\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]";
const isHws = (ch) => ch === " " || ch === "\t" || ch === " " || ch === " " || ch === " " || ch === " " || ch === "　" || (ch >= " " && ch <= " ");
/**
 * Where the path that starts at `from` and matched up to `end` stops. Linear in the length of the span: the position after the last slash and
 * whether a slash was seen are carried from word to word, so no word re-reads what came before it.
 */
function pathEnd(text, from, end, pre, nameWords) {
  if (QUOTE_MARKS.has(pre)) {
    // To the closing quote, or to the end of the line when none closes (one walk, only as far as it stops).
    let q = end;
    while (q < text.length && text[q] !== pre && text[q] !== "\n" && text[q] !== "\r") q++;
    return q;
  }
  let e = end;
  let hasSlash = false;
  let segStart = from; // the index after the last `/` or `\` read so far
  const note = (a, b) => { for (let i = a; i < b; i++) { const c = text[i]; if (c === "/" || c === "\\") { hasSlash = true; segStart = i + 1; } } };
  note(from, end);
  for (;;) {
    if (!hasSlash || PUNCT_END.has(text[e - 1])) return e;
    let k = e;
    while (isHws(text[k])) k++;
    if (k === e) return e;
    WORD_PIECE.lastIndex = k;
    const word = WORD_PIECE.exec(text)?.[0];
    if (!word) return e;
    let b = word.length;
    while (b > 0 && PUNCT_END.has(word[b - 1])) b--;
    const bare = word.slice(0, b);
    const pathLike = /[\\/]/.test(bare) || HAS_EXTENSION.test(bare);
    const nameLike = nameWords && segStart < e && !HAS_EXTENSION.test(text.slice(Math.max(segStart, e - 11), e)) && /^[A-Z0-9]/.test(bare);
    if (!pathLike && !nameLike) return e;
    note(k, k + word.length);
    e = k + word.length;
  }
}
// Path runs (backstop): the word-by-word rules above cannot know where a folder name with spaces ends ("~/my private notes/alice.md":
// "private" and "notes" are lowercase words, and the tail looks like a repo-relative path), so after a root (`~/`, `/`, a drive, `\\server`) the
// mask runs through the LAST token that holds a `/` or `\` in the same RUN of words. A run ends at a line break, at a sentence break (`.` `;` `,` `)`
// followed by a space or tab), at two or more spaces, and at the UI separators and markup the tool's own output uses (quotes, `<` `>`, backticks,
// `←` `→` `≠` `·` `|`). It fails closed on `~/x then see src/a.ts`.
// Two spaces are NOT a break any more (`~/one  two three/x.md` is one path): any run of horizontal whitespace is one separator. The vertical
// separators (vertical tab, form feed, NEL, line and paragraph separators) end a run like a line break does.
const RUN_BREAK = new RegExp(`[\\r\\n\\v\\f\\u0085\\u2028\\u2029]|[.;,)]${HWS}|["<>\`←→≠·|]`, "g");
const RUN_KINDS = new Set(["url", "drive", "unc", "env", "tilde", "posix"]);
function runEnd(text, from) {
  RUN_BREAK.lastIndex = from;
  return RUN_BREAK.exec(text)?.index ?? text.length;
}
/** End of the last whitespace-separated token in [from, to) that holds a `/` or `\` (without trailing punctuation), or -1. One pass. */
function lastSlashEnd(text, from, to) {
  let last = -1;
  for (let i = from; i < to;) {
    while (i < to && isHws(text[i])) i++;
    const start = i;
    let slash = false;
    while (i < to && !isHws(text[i])) { if (text[i] === "/" || text[i] === "\\") slash = true; i++; }
    if (slash) last = start + (PATH_TAIL.exec(text.slice(start, i))?.index ?? i - start);
  }
  return last;
}
/** Replace non-allowlisted paths with [path]; `only` = "user" limits it to paths that name a person or machine. */
function replacePaths(text, only = null) {
  if (!MAYBE_PATH.test(text)) return text;
  let out = "";
  let pos = 0;
  // The run after the current match, cached so a line of many roots ("~ ~ ~ ...") scans each run once: [from, end) and where its last slash token ends.
  let run = { from: -1, end: -1, slash: -1 };
  const slashAfter = (from) => {
    if (!(from >= run.from && from < run.end)) { const end = runEnd(text, from); run = { from, end, slash: lastSlashEnd(text, from, end) }; }
    return run.slash > from ? run.slash : -1;
  };
  PATH_RE.lastIndex = 0;
  for (let m; (m = PATH_RE.exec(text));) {
    const tail = m[0].endsWith(PATH_MARK) ? "" : PATH_TAIL.exec(m[0])?.[0] ?? "";
    const whole = tail ? m[0].slice(0, -tail.length) : m[0];
    const kind = PATH_KINDS[m.slice(1).findIndex((g) => g !== undefined)];
    // `$HOME` and `$USERPROFILE` are upper-case names (a JS template's `${home}` is a variable, not the home directory); `$env:` and `%VAR%` are not case-sensitive.
    if (kind === "env" && !ENV_ROOT_CASE.test(m[0])) { PATH_RE.lastIndex = m.index + 1; continue; }
    // `@` (the @import marker) is not part of the path being classified.
    const core = kind === "tilde" || kind === "posix" || kind === "dotdot" ? whole.replace(/^@/, "") : whole;
    let reason = classifyPath(kind, core);
    const pre = m.index > 0 ? text[m.index - 1] : "";
    const matchEnd = m.index + m[0].length;
    let ext = -1;
    // (A match that already ends in `.` `;` `,` `)` before a space ended its sentence: no run follows.)
    if (RUN_KINDS.has(kind) && !QUOTE_MARKS.has(pre) && (reason || kind === "tilde") && !(/[.;,)]/.test(tail) && /[ \t]/.test(text[matchEnd] ?? ""))) {
      ext = slashAfter(matchEnd);
      // An allowlisted user-config path stays only when it is the whole run: more path words after it make it one longer, unknown path.
      if (!reason && ext > matchEnd) reason = "abs";
    }
    if (!reason || (only && reason !== only)) continue;
    if (kind === "posix" && m.index > 0 && text[m.index - 1] === "…" && ELLIPSIS_CONFIG.test(core)) continue;
    const end = Math.max(pathEnd(text, m.index, matchEnd, pre, kind !== "posix" || reason === "user"), ext);
    const spanTail = end > matchEnd || QUOTE_MARKS.has(pre) ? (QUOTE_MARKS.has(pre) ? "" : PATH_TAIL.exec(text.slice(m.index, end))?.[0] ?? "") : tail;
    const stop = end > matchEnd || QUOTE_MARKS.has(pre) ? end : matchEnd;
    out += text.slice(pos, m.index) + (reason.startsWith("root:") ? `${reason.slice(5)}/${PATH_MARK}` : PATH_MARK) + spanTail;
    pos = stop;
    PATH_RE.lastIndex = stop;
  }
  return pos === 0 && out === "" ? text : out + text.slice(pos);
}
// The slash token: a `/`, or a backslash that is not the start of a JSON `\n` `\r` `\t` escape (in JSON text those are line breaks, which end a run).
// Any run of horizontal whitespace is one separator, and so is the JSON escape of a tab (a literal backslash and `t`).
const SEPARATOR = `(?:${HWS}|\\\\t)+`;
const PATH_TAIL_AFTER_MARK = new RegExp(`(?:~\\/\\.(?:claude|codex|agents)\\/)?\\[path\\](?:${SEPARATOR}[A-Za-z]{1,16}){1,6}${SEPARATOR}[^\\s"'\`<>]*(?:\\/|\\\\(?![nrt]))[^\\s"'\`<>]*`, "g");
/** True when the text holds an absolute, drive, UNC, file:// or tilde path (other than an allowlisted user config path) or a path that leaves the repo. */
export function hasNonRelativePath(text) {
  return replacePaths(text) !== text;
}

// ---- Entropy ------------------------------------------------------------------------------------
export function entropy(value) {
  const counts = new Map();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Letters and digits and high entropy. Long values are judged on their first 4096 characters. */
export function highEntropy(value) {
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  return entropy(value.length > 4096 ? value.slice(0, 4096) : value) >= 4;
}

const KNOWN_DIRS = new Set([
  "claude", "codex", "agents", "cursor", "github", "windsurf", "skills", "rules", "commands", "hooks", "src", "lib",
  "docs", "packages", "apps", "test", "tests", "fixtures", "scripts", "assets", "public", "config", "node_modules",
]);
/** A slug of mostly real words: "release2026-notes", "db_migrations". Random tokens have no short alphabetic words. */
function nameLike(segment) {
  if (!/^[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+$/.test(segment)) return false;
  const words = segment.split(/[-_]/);
  return words.filter((w) => /^[A-Za-z]{2,24}$/.test(w)).length * 2 >= words.length;
}
const EXTENSION = /^\.[A-Za-z0-9]{1,10}(?![A-Za-z0-9])/;

/** Decide what to do with one 32+ character run of base64/path-like characters. */
function entropyRun(value, after) {
  if (value.includes("/")) {
    const segments = value.split("/");
    const pathLike = EXTENSION.test(after) || segments.some((s) => KNOWN_DIRS.has(s.toLowerCase()) || nameLike(s));
    if (pathLike) return segments.map((s) => (s.length >= 32 && !nameLike(s) && highEntropy(s) ? SECRET : s)).join("/");
    return highEntropy(value) ? SECRET : value;
  }
  if (nameLike(value)) return value;
  return highEntropy(value) ? SECRET : value;
}

// ---- Families -----------------------------------------------------------------------------------
/** @type {Family[]} */
export const FAMILIES = [
  {
    id: "private-key",
    ocr: true,
    apply(text) {
      if (!/private key/i.test(text)) return text;
      // No size cap: a block runs from its BEGIN marker to the next END marker (found with one forward pass over both marker lists,
      // so a text of many BEGINs and no END stays linear); a header whose END is missing takes the base64 body that follows it.
      const begins = [...text.matchAll(/-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY-----/g)];
      if (!begins.length) return text;
      const ends = [...text.matchAll(/-----END (?:[A-Z0-9]+ ){0,4}PRIVATE KEY-----/g)];
      let out = "";
      let pos = 0;
      let e = 0;
      for (const b of begins) {
        if (b.index < pos) continue;
        while (e < ends.length && ends[e].index < b.index + b[0].length) e++;
        let stop;
        if (e < ends.length) stop = ends[e].index + ends[e][0].length;
        else {
          stop = b.index + b[0].length;
          while (stop < text.length && /[A-Za-z0-9+/=\r\n]/.test(text[stop])) stop++;
        }
        out += text.slice(pos, b.index) + SECRET;
        pos = stop;
      }
      return out + text.slice(pos);
    },
  },
  // Credentials must go before email detection, which otherwise consumes pass@host.
  lineFamily("url-credentials", [[/(\b[a-z][a-z0-9+.-]{0,15}:\/\/)[^\s/"'<>]+@/gi, "$1[credentials]@"]], ["://"]),
  lineFamily("bearer", [[/\b(?:Authorization:[ \t]*)?Bearer[ \t]+[^\s"'`,;<>]+/gi, "Bearer [secret]"]], ["bearer"]),
  lineFamily("basic-auth", [
    [/(\bAuthorization:[ \t]*Basic[ \t]+)[A-Za-z0-9+/_=-]+/gi, `$1${SECRET}`],
    // Bare "Basic <base64>": needs 16+ characters and something beyond lowercase letters, so prose survives.
    [/\b(Basic[ \t]+)([A-Za-z0-9+/_-]{16,}={0,2})/g,(m, head, value) => (/[0-9A-Z+/=]/.test(value.slice(1)) ? `${head}${SECRET}` : m)],
  ], ["basic"]),
  lineFamily("cli-flag-secret", [
    [SECRET_FLAG, (m, flag, sep, value) => {
      const name = flag.slice(2);
      if (!flagIsSecret(name) || value.startsWith(SECRET)) return m;
      if (sep !== "=" && value.startsWith("-")) return m; // "--auth --verbose": the next flag is not a value
      return `${flag}${sep}${SECRET}`;
    }],
  ], ["--"]),
  {
    // `mysql -pX`, `redis-cli -a X`, `docker login -p X`, `curl -u user:pass`: only after those commands (mkdir -p stays),
    // and only within one command: `;`, `&` and `|` end it. OCR-checked like every secret family.
    id: "cli-p-secret",
    ocr: true,
    apply(text) {
      if (!/-[pau]|--user/.test(text)) return text;
      return text.split("\n").map((line) => {
        if (!/-[pau]|--user/.test(line)) return line;
        return commandSegments(line).map(([from, to]) => {
          const seg = line.slice(from, to);
          const sep = line.slice(to, to + 1);
          let out = seg;
          for (const { cmd, flag } of CLI_COMMANDS) {
            const hit = cmd.exec(out);
            if (!hit) continue;
            const start = hit.index + hit[0].length;
            out = out.slice(0, start) + out.slice(start).replace(flag, (m, f, gap, value) => (value.startsWith(SECRET) ? m : `${f}${gap}${SECRET}`));
          }
          const curl = CURL.exec(out);
          if (curl) {
            const start = curl.index + curl[0].length;
            out = out.slice(0, start) + out.slice(start).replace(CURL_USER, (m, f, value) => (value.includes(":") && !value.startsWith(SECRET) ? `${f}${SECRET}` : m));
          }
          return out + sep;
        }).join("");
      }).join("\n");
    },
  },
  // Paths that name a person or machine (home directories, /srv/<user>, drive Users, UNC, ~user). Applied to every scanned file.
  { id: "home-path", ocr: true, apply: (text) => replacePaths(text, "user") },
  // Every other non-repo-relative path in EXPORTED text: absolute, drive, file://, tilde, `..` out of the repo. Source files may
  // document paths, so the privacy scan applies this family to generated artifacts and rendered text only.
  { id: "paths", ocr: true, artifactsOnly: true, apply: (text) => replacePaths(text) },
  // What an older redactor left of a spaced path: `[path] private notes/alice.md` (a placeholder, a few plain words, then a slash token, all in
  // one run). The redactor no longer produces it, so a hit in an artifact or in rendered text is a leaked path tail.
  { ...lineFamily("path-tail", [[PATH_TAIL_AFTER_MARK, PATH_MARK]], ["[path]"]), artifactsOnly: true },
  // Claude-style dash-encoded project directory names. Needs a left boundary so flags such as --home-dir-path stay.
  lineFamily("dash-path", [
    [/(?<![A-Za-z0-9_-])(?:-(?:home|Users)-[^-\s/"'`<>]{1,64}(?:-[^\s/"'`<>]+)?|-root-[^\s/"'`<>]+)/g, "[path]"],
  ], ["-home-", "-users-", "-root-"]),
  lineFamily("email", [[/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,256}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g, "[email]"]], ["@"]),
  lineFamily("internal-host", [
    [/(?<![a-z0-9_.-])(?:[a-z0-9_-]{1,63}\.){1,16}(?:internal|local|corp|lan|intranet)(?![a-z0-9_-]|\.[a-z0-9_-])/gi, "[host]"],
  ], [".internal", ".local", ".corp", ".lan", ".intranet"]),
  // Known bare token prefixes: the WHOLE token is masked, however long it is. The minimum lengths exist only so prose and variable
  // names that merely start the same way survive ("npm_config_registry" stops at its first `_` after 6 characters, a lone "hf_" or
  // "SG." is not a token); a real token of each kind is longer than its minimum.
  lineFamily("token-prefix", [
    [/\b(?:sk-[A-Za-z0-9_-]{16,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]+)/g, SECRET],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, SECRET],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, SECRET],
    [/\bxox(?:e\.xox[bp]|[abprse])-[A-Za-z0-9-]{10,}/g, SECRET],
    [/\bxapp-[A-Za-z0-9-]{10,}/g, SECRET],
    [/\bglpat-[A-Za-z0-9_-]{16,}/g, SECRET],
    [/\bnpm_[A-Za-z0-9]{20,}/g, SECRET],
    [/\bhf_[A-Za-z0-9]{20,}/g, SECRET],
    [/\bAIza[A-Za-z0-9_-]{20,}/g, SECRET],
    [/(?<![A-Za-z0-9_.-])SG\.[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+)?/g, SECRET],
    [/\b(?:AKIA|ASIA)[0-9A-Z]{16,}/g, SECRET],
    // JWT: the header and payload are capped (that cap is what keeps a line of "eyJ-eyJ-..." linear); the signature, which follows a
    // successful match and so is scanned once, is not.
    [/\beyJ[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,}/g, SECRET],
  ], ["sk-", "sk_", "rk_", "pk_", "gh", "github_pat_", "xox", "xapp-", "glpat-", "npm_", "hf_", "aiza", "sg.", "akia", "asia", "eyj"]),
  lineFamily("hex", [[/(?<![0-9A-Za-z_])[0-9a-fA-F]{32,}(?![0-9A-Za-z_])/g, SECRET]], null),
  lineFamily("uuid", [[/(?<![0-9A-Za-z])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z])/g, SECRET]], ["-"]),
  // Secret keys: one shared matcher (isSecretKeyName), fail-closed value masking to the end of the line, YAML block bodies and
  // next-line values included. Replaces the old assignment / assignment-upper / next-line-secret families.
  { id: "secret-keys", ocr: true, artifactsOnly: true, apply: (text) => maskSecretKeys(text) },
  // The classic key words only, for every scanned file (source code has "key:" and "sig" everywhere; it has no business with "password:").
  { id: "secret-keys-core", ocr: true, apply: (text) => maskSecretKeys(text, true) },
  // Source code: the non-classic credential words (auth, cookie, ...) with a LITERAL value. Generated artifacts already have every
  // such key masked by `secret-keys` above, so in exported text this never fires; in the privacy scan it is what stops a hard-coded
  // `auth: "..."` or `cookie: ...` from being committed. (OCR-checked like every family; rendered text is covered by `secret-keys` too.)
  { id: "secret-literals", ocr: true, apply: maskLiteralKeys },
  {
    id: "entropy",
    ocr: true,
    apply(text) {
      return text.split("\n").map((line) => {
        if (line.length < 32) return line;
        return line.replace(/[A-Za-z0-9+/_=-]{32,}/g, (value, offset) => entropyRun(value, line.slice(offset + value.length, offset + value.length + 12)));
      }).join("\n");
    },
  },
];

const ASCII_ESCAPE = /\\u00([2-7][0-9a-fA-F])/g;
/** NFKC fold plus decoding of printable-ASCII unicode escapes (the 0x20-0x7e range, written with a backslash-u prefix): the form in which a disguised key or path is plain. */
export function foldText(text) {
  const decoded = text.includes("\\u00") ? text.replace(ASCII_ESCAPE, (m, hex) => (hex.toLowerCase() === "7f" ? m : String.fromCharCode(parseInt(hex, 16)))) : text;
  return decoded.normalize("NFKC");
}
/** The text as written and, when different, its folded form: every check (snippet gate, privacy scan) looks at both. */
export const textForms = (text) => { const folded = foldText(text); return folded === text ? [text] : [text, folded]; };

/**
 * All generic families, in order. Idempotent. `keepPaths` skips the two path families: only for the CLI's own opt-in
 * `--print-paths` line on the user's terminal, never for exported text.
 */
export function redactGeneric(text, { keepPaths = false } = {}) {
  const families = keepPaths ? FAMILIES.filter((f) => f.id !== "home-path" && f.id !== "paths") : FAMILIES;
  const run = (input) => {
    let out = input;
    for (const family of families) out = family.apply(out);
    return out;
  };
  const out = run(text);
  // Fullwidth and other compatibility forms fold under NFKC, and printable-ASCII `\u00XX` escapes are decoded (a JSON key written
  // "api_key" is still `api_key`). If the folded text has something to redact, the folded, redacted text is returned;
  // otherwise the original text comes back untouched.
  const folded = foldText(text);
  if (folded === text) return out;
  const foldedOut = run(folded);
  return foldedOut !== folded ? foldedOut : out;
}

// ---- Private-name denylist ---------------------------------------------------------------------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAME_SEP = /[-_.\s]+/;
const WORD_EDGE = ["(?<![\\p{L}\\p{N}])", "(?![\\p{L}\\p{N}])"];

/**
 * Build a case-insensitive matcher for private names. Errors never echo a term.
 * - Emails (any term with "@") match exactly.
 * - Other terms match with "-", "_", ".", whitespace between their words in any mix or absent.
 * - Terms under 4 letters/digits (ignoring separators) only match as whole words; longer ones anywhere.
 * - Terms under 3 characters (ignoring separators) are rejected.
 * @param {readonly string[]} terms
 */
export function compileDenyMatcher(terms) {
  const seen = new Set();
  /** @type {{ size: number, source: string, plain: string }[]} */
  const alternatives = [];
  terms.forEach((raw, i) => {
    const term = raw.trim();
    const isEmail = term.includes("@");
    const words = isEmail ? [term] : term.split(NAME_SEP).filter(Boolean);
    const size = words.join("").length;
    if (size < 3) throw new Error(`Denylist term ${i + 1} is too short (minimum 3 characters)`);
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const body = words.map(escapeRe).join("[-_.\\s]*");
    alternatives.push({
      size,
      source: isEmail || size >= 4 ? body : `${WORD_EDGE[0]}${body}${WORD_EDGE[1]}`,
      plain: words.join("").toLowerCase(),
    });
  });
  alternatives.sort((a, b) => b.size - a.size);
  const source = alternatives.map((a) => `(?:${a.source})`).join("|");
  const matcher = alternatives.length ? new RegExp(source, "giu") : null;
  return {
    count: alternatives.length,
    /** Separator-free lowercase terms, for fuzzy matching in the privacy scan. Never print these. */
    plainTerms: alternatives.map((a) => a.plain),
    /** Non-global matcher, or null. */
    test: matcher ? new RegExp(source, "iu") : null,
    // Existing placeholders are skipped so a term like "act" cannot match inside "[redacted]".
    apply: (text) => (matcher ? text.split(DENY_TOKEN).map((part) => part.replace(matcher, DENY_TOKEN)).join(DENY_TOKEN) : text),
  };
}
