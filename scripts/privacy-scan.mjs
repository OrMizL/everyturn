// Scan working files and public text artifacts, including ignored output. No git or network.
// Usage: privacy-scan.mjs [root] [--artifacts <dir>]... [--extra <dir>]... [--render-check]
//   EVERYTURN_DENYLIST=<file> adds private-name checks.
//   Strict (artifact) rules, which also flag every non-repo-relative path and every secret key, apply to: files under an
//   --artifacts (relative to the root) or --extra directory (chosen explicitly; a folder is never strict because of its name), and generated
//   .svg/.json/.html/.png files anywhere outside the source directories (see SOURCE_DIRS). Everything else gets the source rules.
//   --render-check: only the rendered-text check of every PNG under <root>/out, the --artifacts and the --extra dirs.
//   Every PNG needs a successful, non-empty OCR run (fewer than 10 alphanumerics, a missing or failing tesseract all FAIL);
//   its matching source text (X.source.svg, X.html; everyturn-sources.html for sources.png) is scanned in addition.
//   EVERYTURN_TESSERACT=<path> overrides the tesseract binary.
// The families are the redactor's own (packages/core/src/patterns.mjs): the scan flags any text
// the redactor would change, so the two cannot drift. Matched text and file names are never printed,
// only a file number and the family.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FAMILIES, compileDenyMatcher, looseSecretKey, textForms } from "../packages/core/src/patterns.mjs";
import { jsStringText } from "./js-strings.mjs";

const argv = process.argv.slice(2);
const dirFlag = (flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
const extras = dirFlag("--extra");
const artifactArgs = dirFlag("--artifacts");
if (extras.some((e) => !e || e.startsWith("--"))) { console.error("privacy-scan: --extra needs a directory"); process.exit(2); }
if (artifactArgs.some((e) => !e || e.startsWith("--"))) { console.error("privacy-scan: --artifacts needs a directory"); process.exit(2); }
const renderCheck = argv.includes("--render-check");
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--extra" && argv[i - 1] !== "--artifacts");
const root = resolve(positional[0] ?? ".");
const artifactDirs = artifactArgs.map((d) => resolve(root, d)); // a relative --artifacts directory is relative to the scan root
const strictDirs = [...artifactDirs, ...extras.map((d) => resolve(d))];
const underDir = (file, dir) => file === dir || file.startsWith(dir + sep);
/**
 * Source = tracked, hand-written files; everything else that is a generated type is an artifact. Classification is by exact allowlist, not by
 * "what directory is it in":
 *  - the source directories (packages, scripts, docs, fixtures, .github, .claude, and an app's src/ and public/) hold hand-written files;
 *  - an app's own config is exactly apps/<app>/{package.json, tsconfig.json, index.html, vite.config.ts, README.md} (APP_CONFIG);
 *  - an app's dist/ is ALWAYS an artifact, whatever the extension (.js and .css included);
 *  - the report's own file names (GENERATED_NAME) are artifacts wherever they sit: the repo root, docs/, apps/<app>/, apps/<app>/test/ ...
 */
const SOURCE_DIRS = /^(?:(?:packages|scripts|docs|fixtures|\.github|\.claude)\/|apps\/[^/]+\/(?:src|public)\/)/;
const APP_CONFIG = /^apps\/[^/]+\/(?:package\.json|tsconfig\.json|index\.html|vite\.config\.ts|README\.md)$/;
const APP_DIST = /^apps\/[^/]+\/dist\//;
const GENERATED_NAME = /^(?:everyturn(?:[-.][\w.-]*)?\.(?:json|html|svg|png)|[\w.-]+\.source\.svg|sources\.png)$/i;
const GENERATED_EXTENSIONS = new Set([".svg", ".json", ".html", ".png"]);
/** Strict rules for this file? Explicit directories, an app's dist, a report file name, or any other generated type outside the allowlist. */
function isArtifact(file, logical, ext, base) {
  if (base !== root || strictDirs.some((d) => underDir(file, d))) return true;
  if (APP_DIST.test(logical) || GENERATED_NAME.test(basename(logical))) return true;
  if (!GENERATED_EXTENSIONS.has(ext) || !logical.includes("/")) return false;
  return !(APP_CONFIG.test(logical) || SOURCE_DIRS.test(logical));
}
const excluded = new Set(["scripts/privacy-scan.mjs", "packages/core/src/redact.ts", "packages/core/src/patterns.mjs"]);
const binaries = new Set([".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".pdf", ".zip", ".gz"]);
// The web build's two excluded chunks, mirroring the exclusions above for their sources: `redactor` is the bundled
// patterns.mjs + redact.ts, `vendor` is node_modules (also skipped). Every other file under apps/web/dist is scanned.
const BUNDLED_EXCLUDED = /^apps\/web\/dist\/assets\/(?:redactor|vendor)-[\w-]+\.js$/;
const BINARY_CHUNK = /^apps\/web\/dist\/assets\/binary-[\w-]+\.js$/;
// The binary chunk is the renderer's wasm and six fonts as base64 string literals (bytes-plugin.ts). Such a literal is blanked ONLY when the
// sha256 of its decoded bytes is the digest of one of those seven source files (found relative to THIS script, not the scanned root): the file
// name proves nothing. Any other long literal stays in the text, is reported as `binary-literal` and goes through every family.
const BLOB_LITERAL = /"[A-Za-z0-9+/=]{256,}"/g;
const BLOB_SOURCES = [
  "node_modules/@resvg/resvg-wasm/index_bg.wasm",
  ...["inter/Inter-Regular", "inter/Inter-Medium", "inter/Inter-SemiBold", "inter/Inter-Bold", "jetbrains-mono/JetBrainsMonoNL-Regular", "jetbrains-mono/JetBrainsMonoNL-Medium"].map((n) => `packages/core/assets/fonts/${n}.ttf`),
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let blobDigests = null;
/** Digests of the known wasm and font files; empty (nothing is blanked, the scan fails closed) when one of them cannot be read. */
function knownBlobDigests() {
  if (blobDigests) return blobDigests;
  const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try { blobDigests = new Set(BLOB_SOURCES.map((f) => sha256(readFileSync(join(here, f))))); }
  catch { blobDigests = new Set(); }
  return blobDigests;
}
/** Blank the verified literals of a binary chunk; `unknown` counts the long literals that are not byte-for-byte a known source file. */
function blankKnownBlobs(text) {
  const known = knownBlobDigests();
  let unknown = 0;
  const blanked = text.replace(BLOB_LITERAL, (literal) => {
    if (known.has(sha256(Buffer.from(literal.slice(1, -1), "base64")))) return '"[blob]"';
    unknown++;
    return literal;
  });
  return { blanked, unknown };
}
// Public example addresses are not leaks.
const PUBLIC_EMAIL = /\b[A-Za-z0-9._%+-]{1,256}@(?:example\.(?:com|org)|users\.noreply\.github\.com)\b/gi;

function loadDenylist(file) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file)).replace(/^\uFEFF/, ""); }
  catch { console.error("privacy-scan: cannot read denylist"); process.exit(2); }
  const terms = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  try { return compileDenyMatcher(terms); }
  catch { console.error("privacy-scan: denylist has a term shorter than 3 characters"); process.exit(2); }
}
const denylist = process.env.EVERYTURN_DENYLIST ? loadDenylist(process.env.EVERYTURN_DENYLIST) : null;
const denyActive = !!denylist && denylist.count > 0;

/** Families whose redaction would change the text. `ocr` restricts to the families meant for noisy OCR text. */
function familyHits(text, { ocr = false, skip = null, artifact = true, only = null } = {}) {
  const prepared = text.replace(PUBLIC_EMAIL, "");
  // Also the folded form (NFKC, printable-ASCII unicode escapes): fullwidth colons, compatibility letters and escaped keys must not hide a secret.
  const forms = textForms(prepared);
  // `artifactsOnly` families (every non-repo-relative path) apply to generated artifacts and rendered text; source files may document paths.
  return FAMILIES.filter((f) => (!ocr || f.ocr) && (artifact || !f.artifactsOnly) && !skip?.has(f.id) && (!only || only.has(f.id)) && forms.some((form) => f.apply(form) !== form)).map((f) => f.id);
}
// The path families read a run of words as one path, and any run of whitespace (two spaces, a tab) as one separator. A text that joins separate
// cells or lines with spaces would invent such runs, so these families read the variants that keep the line structure instead (the `blocks` markup
// variant, the OCR text as read); every other family reads exactly the variants it always did.
const PATH_FAMILIES = new Set(["home-path", "paths", "path-tail"]);

/** Every string value of a JSON document (keys and numbers left out), one per line and decoded; "" when the text is not JSON. */
function jsonStringText(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return ""; }
  const out = [];
  for (const stack = [doc]; stack.length;) {
    const v = stack.pop();
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") for (const child of Object.values(v)) stack.push(child);
  }
  return out.reverse().join("\n");
}

// ---- Rendered-text check for PNGs -------------------------------------------------------------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeEntities = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => ENTITIES[n]);
const BLOCK_TAGS = /<\/?(?:td|th|tr|li|p|div|br|text|h[1-6]|pre|table|tbody|thead|ul|ol|section|header|footer|main|title|desc)\b[^>]*>/gi;
/**
 * Visible text of markup: once with tags removed (spans rejoin), once with tags as spaces, and once with block tags (cells, rows, paragraphs, SVG text
 * elements) as line breaks and the rest as spaces: the variant the path families read, where two cells are never one run of words.
 */
function visibleTexts(markup) {
  const body = markup.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  return [decodeEntities(body.replace(/<[^>]*>/g, "")), decodeEntities(body.replace(/<[^>]*>/g, " ")), decodeEntities(body.replace(BLOCK_TAGS, "\n").replace(/<[^>]*>/g, " "))];
}
/** The text sources a PNG is rendered from: X.source.svg and X.html, and everyturn-sources.html for sources.png. Nothing else counts. */
function siblingSources(png) {
  const dir = dirname(png);
  const stem = basename(png, extname(png));
  const names = [`${stem}.source.svg`, `${stem}.html`, ...(stem === "sources" ? ["everyturn-sources.html"] : [])];
  return names.map((n) => join(dir, n)).filter((p) => existsSync(p));
}
// EVERYTURN_TESSERACT overrides the binary (tests point it at a missing file or a stand-in).
const TESSERACT = process.env.EVERYTURN_TESSERACT || "tesseract";
/** OCR text of a PNG, or null when tesseract is missing, fails or times out. */
function ocrText(file) {
  // One OCR thread unless the caller says otherwise: several scans at once (the test suite runs many) must not oversubscribe the cores and starve each other.
  const env = { ...process.env, OMP_THREAD_LIMIT: process.env.OMP_THREAD_LIMIT ?? "1" };
  try { return execFileSync(TESSERACT, [file, "stdout"], { env, timeout: 60_000, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); }
  catch { return null; }
}
/** Fewer alphanumerics than this means OCR did not read a poster: the PNG fails rather than passes unchecked. */
const MIN_OCR_ALNUM = 10;
const alnumCount = (s) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
/**
 * OCR splits tokens ("ghp_ FAKE... fake...") and breaks lines inside them. Variants: as read, lines joined, all whitespace
 * removed, and, because removing all whitespace also glues the token to the word before it, every run of 8 consecutive
 * words collapsed on its own (so each starts at a word boundary). Each is also tried in lower case.
 * Gluing words together makes table numbers look like long hex/entropy runs, so those three run-length families only see
 * the as-read and lines-joined variants.
 */
// Glued variants (OCR spaces removed) only serve token shapes OCR splits apart. Key/value and host families read
// their separators from the plain variants; gluing whole pages invents "settings.local.json"-style hosts and key runs.
const GLUE_SKIP = new Set(["entropy", "hex", "uuid", "paths", "path-tail", "secret-keys", "internal-host", "secret-literals"]);
// OCR-only normalisation. (1) The hero's `~394` can be read as a lone `~` token on its own: not a path. (2) The tool's own
// user-config logical paths are allowlisted by the redactor (USER_CONFIG_PATHS, including the middle-truncated forms the poster draws:
// `~/.claude/skills/…/SKILL.md`, `…/skills/release-notes/SKILL.md`, `…settings.json`); OCR garbles the ellipsis and the `~`, so a token that
// ends in one of those fixed file names and otherwise holds only the known roots, `skills`, at most one folder name and ellipsis/dot/tilde
// noise is the same allowlisted path and is dropped before the families run. Any other path (absolute, a user's folder) is untouched.
const OCR_CONFIG_BASENAME = "(?:SKILL\\.md|CLAUDE\\.md|settings(?:\\.local)?\\.json|AGENTS(?:\\.override)?\\.md)";
const OCR_USER_CONFIG = new RegExp(`(?<![^\\s])[~…._\\-—–]{0,3}[\\\\/]?(?:\\.?(?:claude|codex|agents)[\\\\/])?(?:skills[\\\\/])?(?:[~…._\\-—–]{1,3}[\\\\/])?(?:(?<=skills[\\\\/])[^\\s\\\\/]{1,64}[\\\\/])?${OCR_CONFIG_BASENAME}(?::\\d{1,6})?(?![^\\s])`, "gi");
// A `~` that is a token on its own line, or ends a line whose next line starts with a number, is the hero split in two; `cd ~ now` is still a path.
const OCR_LONE_TILDE = /^[ \t]*[~˜∼]+[ \t]*$|(?<=[ \t])[~˜∼]+[ \t]*(?=\r?\n[ \t]*[\d.,])/gm;
// The product's own byline, drawn on every poster and page footer as the wordmark then the public handle. Gluing a column-merged
// OCR page joins it to the next column's `.claude/...` path and invents an email; only this exact pair is dropped, nothing else.
// It must END its line: `everyturn @OrMiz` + a next line that goes on as a domain (`.fakecompany.test`, `fakecompany.test`) is an address.
const OCR_BYLINE = /(?<![^\s])everyturn[ \t]+@ormiz(?=[ \t]*(?:\r?\n(?![ \t]*(?:[.@_%+-]|[A-Za-z0-9-]+\.[A-Za-z]))|$))/gi;
function normalizeOcr(text) {
  return text.replace(OCR_LONE_TILDE, " ").replace(OCR_USER_CONFIG, " ").replace(OCR_BYLINE, " ");
}
function ocrVariants(raw) {
  const text = normalizeOcr(raw);
  // `joined` has the lines joined with two spaces. The path families do not read it (a line join is not part of a path: the poster's row label and the
  // next row's path are not one run); they read `plain` as it is, where a line break ends a run. Every other family reads both.
  const plain = new Set([text]);
  const joined = new Set([text.replace(/\s*\n\s*/g, "  ")]);
  const glued = new Set([text.replace(/\s+/g, "")]);
  const words = text.split(/\s+/).filter(Boolean).slice(0, 20_000);
  for (let i = 0; i < words.length; i++) glued.add(words.slice(i, i + 8).join(""));
  const both = (set) => [...set].flatMap((v) => [v, v.toLowerCase()]);
  return { plain: both(plain), joined: both(joined), glued: both(glued) };
}
/** True when a and b (lengths differing by at most 1) are at edit distance <= 1. */
function withinOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
/** Denylist terms in OCR text: exact (separators ignored) and, for terms of 6+ characters, one edit away. */
function denylistInOcr(text) {
  if (!denyActive) return false;
  if (denylist.test?.test(text)) return true;
  const strip = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const hay = strip(text);
  for (const raw of denylist.plainTerms) {
    const term = strip(raw);
    if (!term) continue;
    if (hay.includes(term)) return true;
    if (term.length < 6) continue;
    for (const length of [term.length - 1, term.length, term.length + 1]) {
      for (let i = 0; i + length <= hay.length; i++) if (withinOne(term, hay.slice(i, i + length))) return true;
    }
  }
  return false;
}
/**
 * Families found in the rendered text of a PNG. A successful OCR run that read something is required (`ocrOk`);
 * the matching sibling source text is scanned in addition, never instead.
 */
function checkPng(file) {
  const hits = new Set();
  for (const sibling of siblingSources(file)) {
    let raw;
    try { raw = readFileSync(sibling, "utf8"); } catch { continue; }
    const [stripped, spaced, blocks] = visibleTexts(raw);
    for (const id of familyHits(stripped)) hits.add(id);
    for (const id of familyHits(spaced, { skip: PATH_FAMILIES })) hits.add(id);
    for (const id of familyHits(blocks, { only: PATH_FAMILIES })) hits.add(id);
    for (const text of [stripped, spaced]) if (denyActive && denylist.test.test(text)) hits.add("denylist");
  }
  const text = ocrText(file);
  const ocrOk = text !== null && alnumCount(text) >= MIN_OCR_ALNUM;
  if (ocrOk) {
    const { plain, joined, glued } = ocrVariants(text);
    for (const variant of plain) for (const id of familyHits(variant, { ocr: true })) hits.add(id);
    for (const variant of joined) for (const id of familyHits(variant, { ocr: true, skip: PATH_FAMILIES })) hits.add(id);
    for (const variant of glued) for (const id of familyHits(variant, { ocr: true, skip: GLUE_SKIP })) hits.add(id);
    // OCR noise splits or garbles key names (API_KEY read as "API_LKEY" or "AP1_K3Y"), so the exact key matcher misses them. Fail
    // closed on rendered text with the shared loose matcher (whole secret-word components, linear; patterns.mjs looseSecretKey).
    for (const variant of [...plain, ...joined]) if (looseSecretKey(variant)) hits.add("secret-keys-ocr-loose");
    if (denylistInOcr(text)) hits.add("denylist");
  }
  return { hits: [...hits], ocrOk };
}

const describe = (id) => (id === "denylist" ? "denylist family" : `family ${id}`);

// ---- Walk ---------------------------------------------------------------------------------------
let bad = 0;
let scanned = 0;
// `base` is the directory logical names are relative to; the exclusion list only applies to the repo root.
function scan(dir, base = root) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) { scan(file, base); continue; }
    if (!entry.isFile()) continue;
    const ext = extname(file).toLowerCase();
    if (ext === ".png") {
      scanned++;
      const { hits, ocrOk } = checkPng(file);
      for (const id of hits) { console.error(`privacy-scan: file ${scanned} matches ${describe(id)} (rendered text)`); bad++; }
      if (!ocrOk) { console.error(`privacy-scan: file ${scanned} png ocr unavailable/empty (a successful OCR read is required)`); bad++; }
      continue;
    }
    if (renderCheck) continue;
    const logical = relative(base, file).split("\\").join("/");
    if ((base === root && (excluded.has(logical) || BUNDLED_EXCLUDED.test(logical))) || binaries.has(ext)) continue;
    const bytes = readFileSync(file);
    if (bytes.includes(0)) continue;
    let text = bytes.toString("utf8");
    // npm's public package-integrity digests are expected high-entropy metadata.
    // Only those values are exempt; every other lockfile field is scanned.
    // The web build's `binary` chunk (see BINARY_CHUNK above): the private-name check reads the text as written, un-blanked; the families read it
    // with the byte-verified literals blanked, so a forged literal is scanned like any other text and also counts as a `binary-literal` on its own.
    const written = text;
    let unknownBlobs = 0;
    if (BINARY_CHUNK.test(logical)) ({ blanked: text, unknown: unknownBlobs } = blankKnownBlobs(text));
    if (logical === "package-lock.json") text = text.replace(/"integrity":\s*"sha(?:1|256|512)-[A-Za-z0-9+/=]+"/g, '"integrity":"[digest]"');
    scanned++;
    // Strict rules (every family) for artifacts, chosen explicitly or by generated file type (isArtifact); source files skip the artifacts-only families.
    const artifact = isArtifact(file, logical, ext, base);
    // A built script is an artifact, but its code is full of `/…/` regexes and `key:` properties that the strict rules would call leaks. The strict
    // rules therefore apply to its DATA, the text of its string literals (js-strings.mjs); the source rules still read the whole file.
    const script = artifact && ext === ".js";
    const hits = new Set([...familyHits(text, { artifact: artifact && !script }), ...familyHits(logical, { artifact })]);
    if (script) for (const id of familyHits(jsStringText(text), { artifact: true })) hits.add(id);
    // A JSON artifact keeps a whole document in one string (`represented`), where a line break is the two characters `\n`, a tab `\t`: a Markdown table row or a
    // key aligned with tabs is only visible once the strings are decoded. The strict families read that decoded text as well.
    if (artifact && ext === ".json") for (const id of familyHits(jsonStringText(text), { artifact: true })) hits.add(id);
    if (unknownBlobs) hits.add("binary-literal");
    if (denyActive && (denylist.test.test(written) || denylist.test.test(logical))) hits.add("denylist");
    for (const id of hits) {
      // Never echo the matching content or private filename.
      console.error(`privacy-scan: file ${scanned} matches ${describe(id)}`);
      bad++;
    }
  }
}
// Scan roots: [directory, flag it came from]. A render-check looks at PNGs only: the default <root>/out (when it exists), every
// --artifacts and every --extra directory. A normal scan walks the root, which already contains any --artifacts directory inside it.
const rootsToScan = [];
const addRoot = (dir, from) => { if (!rootsToScan.some(([d]) => underDir(dir, d))) rootsToScan.push([dir, from]); };
if (renderCheck) {
  if (existsSync(join(root, "out"))) addRoot(join(root, "out"), "out");
  for (const d of artifactDirs) addRoot(d, "--artifacts");
} else {
  addRoot(root, "root");
  for (const d of artifactDirs) addRoot(d, "--artifacts");
}
for (const e of extras) addRoot(resolve(e), "--extra");
for (const [dir, from] of rootsToScan) {
  try { scan(dir, dir); }
  catch { console.error(from === "root" ? "privacy-scan: cannot read the scan root" : from === "out" ? "privacy-scan: cannot read the out directory" : `privacy-scan: cannot read an ${from} directory`); process.exit(2); }
}
const label = renderCheck ? "render-check" : "privacy-scan";
if (bad) { console.error(`${label} FAIL (${bad})`); process.exit(1); }
console.log(`${label} PASS (${scanned} ${renderCheck ? "png " : ""}files)`);
