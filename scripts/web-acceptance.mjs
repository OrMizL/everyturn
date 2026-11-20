// Browser acceptance for the built paste page (items 12-13): drives headless google-chrome over the DevTools protocol, with Node's
// built-in WebSocket and child_process only (no new dependencies). Run `npm run build` first. `npm run web-accept`; part of gate:full.
//
// What it does, against apps/web/dist served on 127.0.0.1 WITH the headers from vercel.json (so the CSP header is the one under test):
//   12. network: loads the page, pastes synthetic files that carry fake marker strings through the real UI (set the fields, click Add file),
//       renders (a normal click) and downloads PNG, SVG and JSON by clicking their buttons. Asserts that the only requests ever made are
//       same-origin GETs of the document, scripts, styles and fonts during load (and that every one of them is a file in dist), that there is
//       NO request at all after the page is ready (the DevTools Network log and the server's own log agree), and that no request URL, header
//       or body, on either side, contains a marker. blob: (the poster <img>) is in-memory, not network, and is only ever same-origin.
//   13. offline: after load, Network.emulateNetworkConditions({ offline: true }); then loads the sample, pastes a file, renders and exports all
//       three formats again. CSP: fetch / XHR / sendBeacon / WebSocket / an <img> to a same-origin URL are all blocked by the policy
//       (securitypolicyviolation events captured, connect-src and img-src) and never reach the server.
// Exits 0 on PASS, 1 on a failed assertion, 2 when it cannot run (no dist), and 0 with a SKIP message when google-chrome (or CHROME_BIN) or
// a global WebSocket (Node 22+) is missing. Everything is cleaned up on exit: the browser is killed and its temporary profile removed.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(root, "apps/web/dist");
const chromeBin = process.env.CHROME_BIN || "google-chrome";
const DEADLINE_MS = 180_000;

if (!existsSync(join(dist, "index.html"))) { console.error("web-accept: apps/web/dist is missing; run `npm run build` first"); process.exit(2); }
if (typeof WebSocket === "undefined") { console.log("web-accept SKIP: this Node has no global WebSocket (Node 22+ needed)"); process.exit(0); }
if (spawnSync(chromeBin, ["--version"], { stdio: "ignore" }).status !== 0) { console.log(`web-accept SKIP: ${chromeBin} not found (set CHROME_BIN to a Chrome/Chromium binary)`); process.exit(0); }

// ---- the static server, with vercel.json's headers, and its own request log ------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".ttf": "font/ttf", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
const headers = Object.fromEntries((vercel.headers ?? []).filter((h) => h.source === "/(.*)").flatMap((h) => h.headers.map((x) => [x.key, x.value])));
/** Every request the server received: method, URL, headers, body. */
const served = [];
const distFiles = new Set(readdirSync(dist, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => "/" + relative(dist, join(e.parentPath, e.name)).split(sep).join("/")));
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    served.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("latin1") });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "") || "index.html";
    const file = resolve(dist, rel);
    if (req.method !== "GET" || (file !== dist && !file.startsWith(dist + sep)) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, headers).end("not found"); return; }
    res.writeHead(200, { ...headers, "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- Chrome ------------------------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), "everyturn-accept-"));
let chrome;
const cleanup = () => {
  try { if (chrome?.pid) process.kill(-chrome.pid, "SIGKILL"); } catch { /* already gone */ }
  try { server.close(); server.closeAllConnections?.(); } catch { /* closed */ }
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
};
const timer = setTimeout(() => { console.error("web-accept FAIL: timed out"); cleanup(); process.exit(1); }, DEADLINE_MS);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { cleanup(); process.exit(130); });

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); console.log(`${ok ? "  ok  " : " FAIL "} ${message}`); };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** Poll `fn` until it returns something truthy, or fail with `what` after `ms`. */
async function until(what, fn, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener("message", (event) => {
      const m = JSON.parse(String(event.data));
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (p && m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
        else if (p) p.resolve(m.result);
      }
      else for (const h of this.handlers) h(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method}: no answer`)); }, 60_000);
    });
  }
}

async function launch() {
  chrome = spawn(chromeBin, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--metrics-recording-only", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], detached: true }); // its own process group, so cleanup can take the helper processes with it
  let log = "";
  const wsUrl = await new Promise((ok, fail) => {
    chrome.on("exit", (code) => fail(new Error(`chrome exited early (${code})`)));
    chrome.stderr.on("data", (d) => { log += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(log); if (m) ok(m[1]); });
    setTimeout(() => fail(new Error("chrome did not announce a DevTools port")), 30_000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { ws.addEventListener("open", ok); ws.addEventListener("error", () => fail(new Error("DevTools connection failed"))); });
  return new Cdp(ws);
}

// ---- the run -----------------------------------------------------------------------------------
const marker = (tag) => `qzx${randomBytes(6).toString("hex")}${tag}`;
const MARKERS = { a: marker("alpha"), b: marker("bravo"), c: marker("charlie"), d: marker("delta"), path: marker("folder") };
const hasMarker = (value) => Object.values(MARKERS).some((s) => JSON.stringify(value).includes(s));

async function main() {
  const cdp = await launch();
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => cdp.send(method, params, sessionId);
  /** Network log of the page: every request the browser started, with what could carry content. */
  const net = [];
  const failed = new Map();
  cdp.handlers.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Network.requestWillBeSent") net.push({ id: m.params.requestId, url: m.params.request.url, method: m.params.request.method, type: m.params.type, headers: m.params.request.headers, postData: m.params.request.postData ?? null, hasPostData: !!m.params.request.hasPostData, t: Date.now() });
    if (m.method === "Network.loadingFailed") failed.set(m.params.requestId, m.params);
    if (m.method === "Network.webSocketCreated" || m.method === "Network.eventSourceMessageReceived") net.push({ id: m.params.requestId, url: m.params.url ?? "(event source)", method: "WS", type: "WebSocket", headers: {}, postData: null });
  });
  await call("Page.enable"); await call("Network.enable"); await call("Runtime.enable");
  await call("Network.setCacheDisabled", { cacheDisabled: true });
  // Page-side hooks (run before any page script; they are DevTools-injected, not page scripts): CSP violations, downloads, blob contents.
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__csp = []; window.__downloads = []; window.__blobs = new Map();
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI }));
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { const u = create(b); window.__blobs.set(u, b); return u; };
    document.addEventListener("click", (e) => { const a = e.target instanceof Element ? e.target.closest("a[download]") : null; if (a) { window.__downloads.push({ name: a.getAttribute("download"), url: a.href }); e.preventDefault(); } }, true);
  ` });
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };

  // ---- load ----
  await call("Page.navigate", { url: `${origin}/` });
  await until("the page to be ready", () => evaluate(`document.readyState === "complete" && document.getElementById("render")?.getAttribute("aria-disabled") === "false"`));
  // The empty frame shows the bundled sample, drawn on this device (a blob: URL, so it is not in the network log below).
  await until("the dimmed sample", () => evaluate(`!!document.querySelector("#frame img.dim")?.complete && document.querySelector("#frame img.dim").naturalWidth === 1600`));
  await sleep(500); // anything the page would still start on its own
  const boot = net.filter((r) => /^https?:/.test(r.url));
  const bootServed = served.length;
  console.log(`\nloaded: ${boot.length} requests in the browser, ${bootServed} at the server`);
  const allowedTypes = new Set(["Document", "Script", "Stylesheet", "Font", "Other"]);
  check(boot.length > 0 && boot.every((r) => r.method === "GET" && r.url.startsWith(origin + "/") && !r.postData && !r.hasPostData), "12 · every request during load is a same-origin GET without a body");
  check(boot.every((r) => allowedTypes.has(r.type)), `12 · load requests are only document/script/style/font (${[...new Set(boot.map((r) => r.type))].join(", ")})`);
  check(boot.every((r) => distFiles.has(new URL(r.url).pathname) || new URL(r.url).pathname === "/"), "12 · every load request is a file of the build (dist), nothing else");
  check(!boot.some((r) => /\.wasm(?:$|\?)/.test(r.url)) && !boot.some((r) => /\.ttf$/.test(r.url) && !/^Font$/.test(r.type)), "12 · the renderer's wasm is not fetched (it is bytes in the bundle)");
  check(served.every((r) => r.method === "GET" && r.body === ""), "12 · the server saw only body-less GETs while loading");

  // ---- pass 3: empty state, drop-zone heading, accessible name ----
  check(await evaluate(`(() => { const i = document.querySelector("#frame img"); return i.classList.contains("dim") && i.alt === "Sample poster" && getComputedStyle(i).opacity === "0.35" && /^blob:/.test(i.src); })()`), "p3 · the empty frame shows the sample poster at 35% opacity, alt 'Sample poster', from a blob: URL");
  check(await evaluate(`document.getElementById("cap-l").textContent === "Sample · synthetic data" && getComputedStyle(document.getElementById("cap-l")).fontFamily.includes("JetBrains") && !document.body.innerText.includes("No poster yet")`), "p3 · the label above the frame reads 'Sample · synthetic data' (mono); no 'No poster yet'");
  check(await evaluate(`!document.getElementById("paste").open && document.getElementById("drop-h").innerText === "Drop your repo folder" && document.getElementById("pick-dir").innerText.trim() === "Choose folder…"`), "p3 · pointer heading 'Drop your repo folder', button 'Choose folder…', paste closed by default");
  const accessibleName = async (selector) => {
    const { root } = await call("DOM.getDocument", { depth: 0 });
    const { nodeId } = await call("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { nodes } = await call("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
    return nodes[0]?.name?.value;
  };
  await call("DOM.enable"); await call("Accessibility.enable");
  check((await accessibleName("#drop")) === "Drop your repo folder", `p3 · the drop zone's accessible name is the shown heading (${await accessibleName("#drop")})`);
  // Touch: with a coarse pointer the heading names the button instead, and the accessible name follows what is shown.
  await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }] }).catch(() => undefined);
  if (await evaluate(`matchMedia("(pointer: coarse)").matches`)) {
    check(await evaluate(`document.getElementById("drop-h").innerText === "Choose your repo folder"`), "p3 · (pointer: coarse): the heading reads 'Choose your repo folder'");
    check((await accessibleName("#drop")) === "Choose your repo folder", "p3 · (pointer: coarse): the accessible name is 'Choose your repo folder'");
  } else console.log("  info   this Chrome cannot emulate (pointer: coarse); the coarse heading is covered by the CSS test only");
  await call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "" }] }).catch(() => undefined);

  // ---- paste through the real UI, render, export (online) ----
  const paste = (path, text) => evaluate(`(() => {
    const set = (id, value) => { const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); };
    set("fpath", ${JSON.stringify(path)}); set("ftext", ${JSON.stringify(text)});
    document.getElementById("add").click();
    return document.getElementById("files-count").textContent;
  })()`);
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const rendered = () => evaluate(`document.getElementById("out").hidden === false && /Poster ready/.test(document.getElementById("status").textContent)`);

  // errors first: an empty paste, and a settings file that is not JSON (a skipped row), both carrying a marker
  await evaluate(`(() => { document.getElementById("fpath").value = ""; document.getElementById("ftext").value = ${JSON.stringify(MARKERS.a)}; document.getElementById("add").click(); })()`);
  check(await evaluate(`!document.getElementById("fpath-err").hidden`), "12 · an invalid path shows its field error (no request)");
  check(await evaluate(`document.getElementById("paste").open`), "p3 · the field error opens the closed 'Paste one file instead' so it can be seen");
  await paste(`${MARKERS.path}/.claude/settings.json`, `{ not json ${MARKERS.b}`);
  await paste("CLAUDE.md", `- Never add comments. ${MARKERS.a}\n- Use ${MARKERS.c} for notes.\n`);
  await paste("AGENTS.md", `- Add comments. ${MARKERS.d}\n`);
  await click("render");
  await until("the poster", rendered, 60_000);
  check(await evaluate(`document.activeElement?.id === "h-poster" && document.activeElement.textContent === "Poster" && /Poster ready/.test(document.getElementById("status").textContent)`), "p3 · after Render, focus is on the 'Poster' heading and the status says 'Poster ready'");
  check(await evaluate(`document.getElementById("h-poster").getAttribute("tabindex") === "-1" && getComputedStyle(document.getElementById("h-poster")).outlineStyle === "none"`), "p3 · the focused Poster heading has tabindex=-1 and no outline");
  check(await evaluate(`(() => { const i = document.querySelector("#frame img"); return !i.classList.contains("dim") && getComputedStyle(i).opacity === "1" && /possible conflict/.test(i.alt); })()`), "p3 · the rendered poster is at full strength, its alt summarises it");
  const exportAll = async (label) => {
    await evaluate(`window.__downloads.length = 0`);
    for (const id of ["png", "svg", "json"]) await click(id);
    const downloads = await until("three downloads", async () => { const d = await evaluate(`window.__downloads`); return d.length === 3 ? d : null; });
    const read = async (url, kind) => evaluate(`(async () => { const b = window.__blobs.get(${JSON.stringify(url)}); if (!b) return null; if (${JSON.stringify(kind)} === "png") { const u = new Uint8Array(await b.arrayBuffer()); return { size: u.length, head: Array.from(u.slice(0, 24)) }; } return { size: b.size, text: await b.text() }; })()`, true);
    const byName = Object.fromEntries(downloads.map((d) => [d.name, d.url]));
    check(["everyturn.png", "everyturn.svg", "everyturn.json"].every((n) => byName[n]?.startsWith(`blob:${origin}/`)), `${label} · PNG, SVG and JSON downloads are same-origin blob: URLs`);
    const png = await read(byName["everyturn.png"], "png");
    const be = (o) => (png.head[o] << 24 | png.head[o + 1] << 16 | png.head[o + 2] << 8 | png.head[o + 3]) >>> 0;
    check(png && png.head.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10" && be(16) === 1600 && be(20) === 2000 && png.size > 20_000, `${label} · the PNG is 1600 × 2000 (${png?.size} bytes)`);
    const svg = await read(byName["everyturn.svg"], "svg");
    check(!!svg && svg.text.startsWith("<svg") && !/<text\b/.test(svg.text) && svg.text.includes("</svg>"), `${label} · the SVG is outlined (no <text>)`);
    const json = await read(byName["everyturn.json"], "json");
    let parsed = null; try { parsed = JSON.parse(json?.text ?? ""); } catch { /* checked below */ }
    check(!!parsed && typeof parsed.schemaVersion === "string" && Array.isArray(parsed.sources) && parsed.sources.length > 0, `${label} · the JSON parses and lists sources`);
  };
  check(await evaluate(`/UNREVIEWED REAL SET/.test(document.getElementById("cap-l").textContent) === false && /Your files/.test(document.getElementById("cap-l").textContent)`), "12 · pasted files render as 'Your files · redacted' (real mode)");
  await exportAll("12");

  // ---- 12: nothing after the page was ready ----
  const afterOnline = net.filter((r) => /^https?:/.test(r.url)).slice(boot.length);
  check(afterOnline.length === 0, `12 · no request after load, through paste, render and three exports (${afterOnline.length})`);
  check(served.length === bootServed, "12 · the server received nothing after load (its log agrees with the browser's)");
  const blobs = net.filter((r) => /^blob:/.test(r.url));
  check(blobs.every((r) => r.url.startsWith(`blob:${origin}/`) && r.type === "Image"), "12 · the only blob: request is the poster image, same-origin");
  check(!hasMarker(net) && !hasMarker(served), "12 · no request URL, header or body, in the browser's log or the server's, contains a marker");

  // ---- CSP: probes from the page are blocked, and never reach the server ----
  const before = { net: net.length, served: served.length };
  const probe = await evaluate(`(async () => {
    const out = {};
    try { await fetch("/x-probe-fetch"); out.fetch = "allowed"; } catch { out.fetch = "blocked"; }
    try { const x = new XMLHttpRequest(); x.open("GET", "/x-probe-xhr"); x.send(); out.xhr = "sent"; } catch { out.xhr = "blocked"; }
    try { out.beacon = navigator.sendBeacon("/x-probe-beacon", "a") ? "queued" : "blocked"; } catch { out.beacon = "blocked"; }
    try { const w = new WebSocket("ws://127.0.0.1:1/x-probe-ws"); out.ws = "constructed"; w.onerror = () => {}; } catch { out.ws = "blocked"; }
    const img = new Image(); img.src = "/x-probe-img"; document.body.append(img);
    await new Promise((r) => setTimeout(r, 400));
    out.imgLoaded = img.complete && img.naturalWidth > 0;
    return out;
  })()`, true);
  const csp = await evaluate(`window.__csp`);
  const has = (dir, what) => csp.some((v) => v.directive === dir && v.blocked.includes(what));
  check(probe.fetch === "blocked" && has("connect-src", "/x-probe-fetch"), "13 · fetch('/x') is blocked by connect-src 'none'");
  check(has("connect-src", "/x-probe-xhr"), "13 · XMLHttpRequest to /x is blocked by connect-src");
  // sendBeacon may return true (it only queues); the policy still stops the request and reports the violation.
  check(has("connect-src", "/x-probe-beacon"), "13 · sendBeacon is blocked by connect-src");
  check(has("connect-src", "x-probe-ws"), "13 · a WebSocket is blocked by connect-src");
  check(has("img-src", "/x-probe-img") && probe.imgLoaded === false, "13 · new Image().src = '/x' is blocked by img-src (blob: only)");
  check(!served.slice(before.served).some((r) => r.url.includes("x-probe")), "13 · none of the probes reached the server");
  const probeNet = net.slice(before.net).filter((r) => /x-probe/.test(r.url));
  check(probeNet.every((r) => failed.get(r.id)?.blockedReason === "csp" || failed.get(r.id)?.errorText?.includes("BLOCKED")), `13 · every probe the browser began was blocked before the network (${probeNet.length})`);

  // ---- 13: offline after load ----
  await call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const offlineFrom = { net: net.length, served: served.length };
  await click("clear");
  await click("sample"); // "Try the sample setup" loads and renders the sample
  await until("the sample poster", rendered, 60_000);
  await paste("docs/CLAUDE.md", `- Prefer ${MARKERS.c} offline.\n`);
  await click("render");
  await until("the offline poster", rendered, 60_000);
  check(await evaluate(`/^\\d+ files? read · \\d+ sources?$/.test(document.getElementById("cap-r").textContent) && document.querySelectorAll("#cap-r .num").length === 2`), "p3 · the right caption reads '<N> files read · <M> sources' with both numbers in mono");
  check(await evaluate(`/Your files/.test(document.getElementById("cap-l").textContent)`), "13 · offline: sample plus a pasted file render as 'Your files' (a mixed workspace is not a sample)");
  await exportAll("13 offline");
  // Also the pure sample, offline
  await click("clear"); await evaluate(`document.getElementById("status").textContent = ""`); await click("sample");
  await until("the offline sample poster", rendered, 60_000);
  check(await evaluate(`/Sample · synthetic data/.test(document.getElementById("cap-l").textContent) && !!document.querySelector("#frame img:not(.dim)")`), "13 · offline: the pure sample renders at full strength under 'Sample · synthetic data'");
  check(await evaluate(`document.getElementById("cap-r").textContent === "13 files read · 9 sources"`), "p3 · the pure sample's caption reads '13 files read · 9 sources'");
  await exportAll("13 offline sample");
  check(net.slice(offlineFrom.net).filter((r) => /^https?:/.test(r.url)).length === 0 && served.length === offlineFrom.served, "13 · offline: no request was even attempted by the app (nothing to fail)");
  check(!hasMarker(net) && !hasMarker(served), "13 · still no marker in any request after the offline run");
}

try {
  await main();
} catch (error) {
  failures.push(`error: ${error instanceof Error ? error.message : String(error)}`);
  console.error(` FAIL  ${failures.at(-1)}`);
} finally {
  clearTimeout(timer);
  cleanup();
}
if (failures.length) { console.error(`web-accept FAIL (${failures.length})`); process.exit(1); }
console.log("web-accept PASS");
process.exit(0);
