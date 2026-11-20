// Headless screenshots of the built paste page (apps/web/dist). Run `npm run build` first.
// Usage: web-shot.mjs [outDir]   (default out/web)
//
// Serves dist on 127.0.0.1 with a random port and the headers from vercel.json (so the CSP header is exercised too),
// then runs google-chrome headless. Plain --screenshot cannot click, so the page supports `?demo=sample`: it loads the bundled
// synthetic sample and renders it on start (sample only; nothing else loads via the URL). `?shot=1` only sets body data
// attributes (the page height), no content change.
// Per shot: a --dump-dom pass reads the page height and leaves the page text next to the PNG as X.html (the text source that
// render-check scans), then --screenshot captures the full page. --virtual-time-budget lets wasm and fonts finish.
// No --user-data-dir (it hangs on first-run init here).
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(root, "apps/web/dist");
const outDir = resolve(process.argv[2] ?? join(root, "out/web"));
if (!existsSync(join(dist, "index.html"))) { console.error("web-shot: apps/web/dist is missing; run `npm run build` first"); process.exit(2); }

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".ttf": "font/ttf", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
const headers = Object.fromEntries((vercel.headers ?? []).filter((h) => h.source === "/(.*)").flatMap((h) => h.headers.map((x) => [x.key, x.value])));

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "") || "index.html";
  const file = resolve(dist, rel);
  if (req.method !== "GET" || (file !== dist && !file.startsWith(dist + sep)) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, headers).end("not found"); return; }
  res.writeHead(200, { ...headers, "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const { port } = server.address();

const chrome = process.env.CHROME_BIN || "google-chrome";
const BASE = ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-background-networking", "--disable-component-update", "--no-first-run", "--hide-scrollbars", "--virtual-time-budget=10000"];
// Async on purpose: the static server lives in this process, so a blocking call would starve Chrome of its own page.
const exec = promisify(execFile);
const run = async (args) => (await exec(chrome, [...BASE, ...args], { timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 })).stdout;

// [file, query, CSS width, device scale]
const shots = [
  ["desktop-1440-empty", "", 1440, 2],
  ["desktop-1440-filled", "&demo=sample", 1440, 2],
  ["mobile-390-empty", "", 390, 2],
  ["mobile-390-filled", "&demo=sample", 390, 3], // 3x: the 390 file list mono is too small for OCR at 2x and garbles into path-like hits
];
mkdirSync(outDir, { recursive: true });
let failed = false;
for (const [name, query, width, scale] of shots) {
  const url = `http://127.0.0.1:${port}/?shot=1${query}`;
  const out = join(outDir, `${name}.png`);
  try {
    const dom = await run([`--window-size=${width},900`, `--force-device-scale-factor=${scale}`, "--dump-dom", url]);
    const height = Number(/data-height="(\d+)"/.exec(dom)?.[1]);
    if (!Number.isFinite(height) || height < 200) throw new Error("no page height");
    // Empty: the sample poster at 35% (alt "Sample poster"). Demo: the sample drawn at full strength (alt starts "Poster for").
    if (query.includes("demo") ? !(/Sample · synthetic data/.test(dom) && /alt="Poster for/.test(dom) && !/class="dim"/.test(dom)) : !/class="dim"[^>]*alt="Sample poster"|alt="Sample poster"[^>]*class="dim"/.test(dom)) throw new Error("page did not render");
    // The blob: URL of the rendered poster is a random id, not content; the text source keeps the markup without it.
    writeFileSync(join(outDir, `${name}.html`), dom.replace(/blob:[^"\s]+/g, "blob:"), { mode: 0o600 });
    await run([`--window-size=${width},${height}`, `--force-device-scale-factor=${scale}`, `--screenshot=${out}`, url]);
    chmodSync(out, 0o600);
    console.log(`wrote ${name}.png (${width}x${height} @${scale}x)`);
  } catch (error) {
    console.error(`web-shot: ${name} failed: ${error instanceof Error ? error.message : "Chrome unavailable, timed out, or restricted"}`);
    failed = true;
  }
}
server.close();
process.exit(failed ? 1 : 0);
