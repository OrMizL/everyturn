// Build output audit. `npm run gate` builds before it tests, so dist exists there; a bare `vitest run` without a build skips this.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FAMILIES } from "../../../packages/core/src/patterns.mjs";
import { jsStringText } from "../../../scripts/js-strings.mjs";

const dist = "apps/web/dist";
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const built = existsSync(join(dist, "index.html"));
const textFiles = () => (built ? walk(dist).filter((f) => [".js", ".html", ".css"].includes(extname(f))) : []);
const posix = (f: string) => f.split("\\").join("/");
const isChunk = (f: string, name: string) => new RegExp(`(?:^|/)assets/${name}-[\\w-]+\\.js$`).test(posix(f));
const BLOB = /"[A-Za-z0-9+/=]{256,}"/g;
/** Text of a built file as the privacy scan reads it: the binary chunk's base64 literals blanked, nothing else changed. */
const read = (f: string) => { const text = readFileSync(f, "utf8"); return isChunk(f, "binary") ? text.replace(BLOB, '"[blob]"') : text; };

describe.skipIf(!built)("apps/web/dist", () => {
  it("has no network APIs and no fetch() in the app: the renderer's wasm and fonts are bytes in the bundle", () => {
    const files = textFiles();
    expect(files.length).toBeGreaterThan(2);
    for (const file of files) {
      const text = read(file);
      for (const api of ["XMLHttpRequest", "WebSocket", "sendBeacon", "EventSource", "importScripts", "WebTransport"]) {
        expect(text.includes(api), `${relative(dist, file)} uses ${api}`).toBe(false);
      }
    }
    // The one `fetch(` in the build is resvg-wasm's own URL branch (`initWasm(url)`, third-party code in the vendor chunk). The page calls
    // initWasm with bytes (render.ts), so the branch cannot run; the CSP (connect-src 'none') and the browser acceptance test (npm run
    // web-accept) enforce that. No other file may contain a fetch call.
    const calls = files.flatMap((f) => (read(f).match(/\bfetch\(/g) ?? []).map(() => posix(relative(dist, f))));
    expect(calls.filter((f) => !/^assets\/vendor-[\w-]+\.js$/.test(f))).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(1);
    // render.ts never hands initWasm a URL, a string or a Response.
    const app = readFileSync("apps/web/src/render.ts", "utf8");
    expect(app).toContain("initWasm(decodeBase64(wasmBase64))");
    expect(app).not.toMatch(/\bfetch\s*\(/);
  });

  it("has no remote URLs except the allowlist", () => {
    // Allowlist:
    //  - http://www.w3.org/2000/svg: the SVG namespace string in the poster markup (an identifier, never requested).
    //  - https://tracker.example.com/mcp: text inside the bundled synthetic sample (fixtures/demo-repo/.mcp.json), shown
    //    only as redacted summary data; example.com is reserved and nothing requests it.
    const allowed = new Set(["http://www.w3.org/2000/svg", "https://tracker.example.com/mcp"]);
    for (const file of textFiles()) {
      for (const url of read(file).match(/\b(?:https?|wss?|ftp):\/\/[^\s"'`)<>\\]+/g) ?? []) {
        expect(allowed.has(url), `${relative(dist, file)} has ${url.slice(0, 40)}`).toBe(true);
      }
    }
    for (const file of textFiles().filter((f) => !f.endsWith(".js"))) expect(read(file)).not.toMatch(/\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it("ships the plan's CSP (connect-src 'none') in index.html and in the vercel.json header, and no inline script or style", () => {
    const html = read(join(dist, "index.html"));
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
    const header = vercel.headers.find((h) => h.source === "/(.*)")!.headers.find((h) => h.key === "Content-Security-Policy")!.value;
    const directives = (policy: string) => Object.fromEntries(policy.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...values] = d.split(/\s+/); return [name!, values.join(" ")]; }));
    const m = directives(meta), h = directives(header);
    expect(m).toEqual({
      "default-src": "'none'", "script-src": "'self' 'wasm-unsafe-eval'", "style-src": "'self'", "img-src": "blob:", "font-src": "'self'",
      "connect-src": "'none'", "object-src": "'none'", "base-uri": "'none'", "form-action": "'none'",
    });
    // The header carries the same policy plus frame-ancestors (not allowed in a meta tag).
    expect(h).toEqual({ ...m, "frame-ancestors": "'none'" });
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    // No same-origin images are used, so img-src has no 'self' and no data:; the only <img> is the poster's blob: URL.
    expect(html).not.toMatch(/<img\b/i);
    expect(readFileSync("apps/web/src/styles.css", "utf8")).not.toMatch(/url\((?!\.\.\/\.\.\/\.\.\/packages\/core\/assets\/fonts\/)/);
  });

  it("contains no corpus, negative-repo or other fixture content, only the demo repo", () => {
    const bundle = textFiles().map(read).join("\n");
    for (const dir of ["fixtures/corpus", "fixtures/negative-repo", "fixtures/basic"]) {
      if (!existsSync(dir)) continue;
      const demo = walk("fixtures/demo-repo").map((f) => readFileSync(f, "utf8")).join("\n");
      for (const file of walk(dir)) {
        const lines = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 40 && !demo.includes(l));
        for (const line of lines) expect(bundle.includes(JSON.stringify(line).slice(1, -1)) || bundle.includes(line), `${dir} line leaked into dist`).toBe(false);
      }
    }
  });

  it("passes the redactor's own families, strict ones included, except the redactor and vendor chunks the privacy scan also excludes", () => {
    // Exactly two chunks are excluded, as their sources are in the scan: `redactor` (patterns.mjs + redact.ts, which contain the very shapes
    // they mask) and `vendor` (node_modules). Nothing else: HTML and CSS get every family; scripts get the source families on their whole text
    // and the strict, artifact-only families (every non-repo-relative path, every secret key) on the text of their string literals, where data lives.
    const scanned = textFiles().filter((f) => !isChunk(f, "redactor") && !isChunk(f, "vendor"));
    expect(scanned.length).toBeGreaterThanOrEqual(3);
    // The excluded chunks hold only what their names say: no application or sample code.
    const redactor = textFiles().filter((f) => isChunk(f, "redactor")).map(read).join("");
    expect(redactor).not.toContain("Static scan, not a recording");
    for (const file of scanned) {
      const text = read(file);
      const script = extname(file) === ".js";
      const hits = FAMILIES.filter((f) => (script ? !f.artifactsOnly : true) && f.apply(text) !== text).map((f) => f.id);
      expect(hits, relative(dist, file)).toEqual([]);
      if (script) {
        const data = jsStringText(text);
        expect(FAMILIES.filter((f) => f.apply(data) !== data).map((f) => f.id), `${relative(dist, file)} string literals`).toEqual([]);
      }
    }
    // The sample's own text is among those literals and must be clean too (it is what ships as data).
    expect(textFiles().some((f) => /assets\/index-/.test(posix(f)) && jsStringText(read(f)).includes("Every Turn poster"))).toBe(true);
  });

  it("holds the renderer's wasm and six fonts, byte for byte, in the binary chunk and nothing else", () => {
    // Why this chunk may carry long base64 that the scan blanks: it consists of exactly these seven literals. Decoding each one gives
    // the very file it was built from (so no secret or path can ride along in them), and the rest of the chunk is a bare export list.
    const chunks = textFiles().filter((f) => isChunk(f, "binary"));
    expect(chunks).toHaveLength(1);
    const raw = readFileSync(chunks[0]!, "utf8");
    const literals = [...raw.matchAll(BLOB)].map((m) => m[0].slice(1, -1));
    expect(literals).toHaveLength(7);
    expect(raw.replace(BLOB, '"[blob]"')).toMatch(/^const [\w$]+="\[blob\]"(?:,[\w$]+="\[blob\]")*;export\{[\w$ ,]+\};?\s*$/);
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const sources = [
      "node_modules/@resvg/resvg-wasm/index_bg.wasm",
      ...["inter/Inter-Regular", "inter/Inter-Medium", "inter/Inter-SemiBold", "inter/Inter-Bold", "jetbrains-mono/JetBrainsMonoNL-Regular", "jetbrains-mono/JetBrainsMonoNL-Medium"].map((n) => `packages/core/assets/fonts/${n}.ttf`),
    ].map((f) => sha(readFileSync(f)));
    expect(literals.map((l) => sha(Buffer.from(l, "base64"))).sort()).toEqual(sources.sort());
  });

  it("references only same-origin relative assets", () => {
    const html = read(join(dist, "index.html"));
    for (const [, url] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) expect(url!.startsWith("./") || url!.startsWith("assets/"), url).toBe(true);
  });
});
