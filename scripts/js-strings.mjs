// The text a built JavaScript file carries as DATA: the contents of its string and template literals (comments and regular expressions are
// skipped). Used by the privacy scan and apps/web/test/dist.test.ts to apply the strict, artifact-only rules (every non-repo-relative path,
// every secret key) to a bundle: code is full of `/…/` regexes and `key:` object properties that are not leaks, but a home path, an absolute
// path or a credential line inside a string literal is exactly what would reach a user. Pure: no fs, no network.

const WORD = /[A-Za-z0-9_$]/;
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "else", "do", "instanceof", "yield", "await"]);
const unescape = (s) => s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "").replace(/\\(["'`\\/])/g, "$1");

/** Contents of every string and template literal in `code`, in order. */
export function jsStringLiterals(code) {
  const out = [];
  // Scan code from `i`; with `inTemplate`, stop at the `}` that closes the `${` (depth 0). Returns the index after it.
  function scan(i, inTemplate) {
    let prev = "";
    let prevWord = "";
    let depth = 0;
    const n = code.length;
    while (i < n) {
      const c = code[i];
      const d = code[i + 1];
      if (c === "/" && d === "/") { while (i < n && code[i] !== "\n") i++; continue; }
      if (c === "/" && d === "*") { const end = code.indexOf("*/", i + 2); i = end < 0 ? n : end + 2; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && code[j] !== c && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
        out.push(unescape(code.slice(i + 1, j)));
        i = j + 1; prev = c; prevWord = ""; continue;
      }
      if (c === "`") {
        let j = i + 1;
        let text = "";
        let from = j;
        while (j < n && code[j] !== "`") {
          if (code[j] === "\\") { j += 2; continue; }
          if (code[j] === "$" && code[j + 1] === "{") {
            text += code.slice(from, j) + "0";
            j = scan(j + 2, true);
            from = j;
            continue;
          }
          j++;
        }
        text += code.slice(from, j);
        out.push(unescape(text));
        i = j + 1; prev = "`"; prevWord = ""; continue;
      }
      if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || (prevWord !== "" && REGEX_AFTER_WORD.has(prevWord)))) {
        // a regular expression literal: skip to its closing slash (a slash inside [...] does not close it), then the flags
        let j = i + 1;
        let cls = false;
        while (j < n && code[j] !== "\n") {
          if (code[j] === "\\") { j += 2; continue; }
          if (code[j] === "[") cls = true;
          else if (code[j] === "]") cls = false;
          else if (code[j] === "/" && !cls) break;
          j++;
        }
        i = j + 1;
        while (i < n && /[a-z]/i.test(code[i])) i++;
        prev = "/"; prevWord = ""; continue;
      }
      if (inTemplate) {
        if (c === "{") depth++;
        else if (c === "}") { if (depth === 0) return i + 1; depth--; }
      }
      if (WORD.test(c)) {
        let j = i;
        while (j < n && WORD.test(code[j])) j++;
        prevWord = code.slice(i, j);
        prev = code[j - 1];
        i = j;
        continue;
      }
      if (!/\s/.test(c)) { prev = c; prevWord = ""; }
      i++;
    }
    return i;
  }
  scan(0, false);
  return out;
}

/**
 * The literals as one text, one per line (a literal's own newlines stay). Literals of 3 characters or fewer are code constants ("~", "~/", ".."),
 * never a leaked path or credential (a path needs `/a/b`); a `${}` hole in a template reads as "0".
 */
export const jsStringText = (code) => jsStringLiterals(code).filter((s) => s.length > 3).join("\n");
