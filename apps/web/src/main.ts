// Browser glue for the paste page. All analysis is in app.ts (pure) and packages/core; rasterizing is render.ts.
// Privacy: content only ever flows through memory. No storage, no network request carries it (see the CSP in index.html).
import { middleTruncate } from "@everyturn/core";
import {
  ALERTS, ANALYZER_VERSION, AGENT_OPTIONS, POSTER_SCROLL, PROFILE_VERSION, SKIPPED_DIRS, STATUS, Workspace, agentLabel, analyze, countLabel, formatSize, frameCaption, frameLabel, isAgent,
  normalizePath, reportJson, skipSummary, staleRender, stripPickedRoot,
} from "./app";
import type { Agent, Alert, Analysis, Candidate, Row } from "./app";
import { isolate } from "./isolate";
import { loadRenderer, rasterize } from "./render";
import type { Exports } from "./render";
import { sampleCandidates } from "./sample";

const MAX_ENTRIES = 20000;
const PATH_CHAR = 8.4; // JetBrains Mono at 14px: 0.6 em per character, exact

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  agent: $<HTMLSelectElement>("agent"), pick: $<HTMLButtonElement>("pick"), pickDir: $<HTMLButtonElement>("pick-dir"), paste: $<HTMLDetailsElement>("paste"),
  fileInput: $<HTMLInputElement>("file-input"), dirInput: $<HTMLInputElement>("dir-input"), dragText: $("drag-text"), sources: $("sources"),
  path: $<HTMLInputElement>("fpath"), text: $<HTMLTextAreaElement>("ftext"), pathErr: $("fpath-err"), textErr: $("ftext-err"),
  add: $<HTMLButtonElement>("add"), sample: $<HTMLButtonElement>("sample"),
  files: $("files"), count: $("files-count"), clear: $<HTMLButtonElement>("clear"), list: $("file-list"), more: $<HTMLButtonElement>("more"),
  alert: $("alert"), render: $<HTMLButtonElement>("render"), kbd: $("kbd"), status: $("status"),
  posterHead: $("h-poster"), frame: $("frame"), out: $("out"), capL: $("cap-l"), capR: $("cap-r"),
  findingField: $("finding-field"), finding: $<HTMLSelectElement>("finding"),
  png: $<HTMLButtonElement>("png"), svg: $<HTMLButtonElement>("svg"), json: $<HTMLButtonElement>("json"),
  verTop: $("ver-top"), verFoot: $("ver-foot"),
};

type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | undefined> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined) node.setAttribute(key, value);
  for (const kid of kids) if (kid) node.append(kid);
  return node;
}

/**
 * Text with its mixed-direction runs (a count with its noun, a size, a file name or path) isolated in <bdi>, so a right-to-left page cannot reorder them
 * or pull the punctuation around them in (isolate.ts); the number itself is set in the mono face (mono is for paths, filenames, sizes and numbers only).
 * textContent is unchanged, and a full stop or ellipsis is never inside a run.
 */
function isolated(text: string, mono = false): (Node | string)[] {
  return isolate(text).map((p) => ("text" in p ? p.text : h("bdi", {}, ...(mono && p.mono ? [h("span", { class: "num" }, p.mono), p.run.slice(p.mono.length)] : [p.run])))).filter((n) => n !== "");
}
const query = new URLSearchParams(location.search);
const narrow = matchMedia("(max-width: 959px)");

const ws = new Workspace();
const state = {
  agent: "claude-code" as Agent,
  busy: false,
  ready: false,
  expanded: false,
  /** An alert from an action (replaced by the next one; cleared when the list changes). */
  transient: null as Alert | null,
  /** The inputs changed since the poster was drawn. */
  dirty: true,
  choice: undefined as string | undefined,
  analysis: undefined as Analysis | undefined,
  exports: undefined as Exports | undefined,
  /** What the poster on screen was drawn from, so a finding change re-draws the same inputs. */
  input: undefined as { files: Awaited<ReturnType<Workspace["prepare"]>>; agent: Agent; sample: boolean } | undefined,
  url: undefined as string | undefined,
};
/** The dimmed sample in the empty frame (its own blob: URL, never the user's poster). */
const preview = { img: undefined as HTMLImageElement | undefined };

const paint = () => new Promise<void>((done) => { requestAnimationFrame(() => setTimeout(done, 0)); setTimeout(done, 60); });
const setStatus = (text: string) => { el.status.replaceChildren(...isolated(text)); };

// ---------- list ----------
const limit = () => (narrow.matches ? 3 : 6);

function fitPaths(): void {
  for (const node of el.list.querySelectorAll<HTMLElement>(".pt")) {
    const full = node.dataset.full ?? "";
    const width = node.parentElement?.clientWidth ?? 0;
    node.textContent = width > 0 ? middleTruncate(full, Math.max(8, Math.floor(width / PATH_CHAR))) : full;
  }
}

function rowItem(row: Row): HTMLLIElement {
  const pt = h("bdi", { class: "pt", "data-full": row.path }, row.path);
  // A large file is not an error: the kind line gains a muted "· read first 64 KiB".
  const kind = h("small", {}, ...(row.skip ? [`Skipped: ${row.skip}`] : [row.kind, ...(row.note ? [" · ", ...isolated(row.note, true)] : [])]));
  return h("li", row.skip ? { class: "bad" } : {},
    h("span", { class: "p", title: row.path }, pt, kind),
    h("bdi", { class: "sz" }, formatSize(row.size)),
    h("button", { class: "rm", type: "button", "aria-label": `Remove ${row.path}`, "data-path": row.path }, "Remove"));
}

function paintList(): void {
  const rows = ws.rows;
  el.files.hidden = rows.length === 0;
  el.count.replaceChildren(...isolated(countLabel(ws), true));
  const ordered = ws.orderedRows();
  const shown = state.expanded ? ordered : ordered.slice(0, limit());
  el.list.replaceChildren(...shown.map(rowItem));
  const overflow = rows.length > limit();
  el.more.hidden = !overflow;
  el.more.setAttribute("aria-expanded", String(state.expanded));
  el.more.replaceChildren(...isolated(state.expanded ? "Show fewer" : `Show all ${rows.length} files`));
  fitPaths();
}

function paintAlert(): void {
  const alert = state.transient ?? skipSummary(ws.rows.length, ws.usable);
  el.alert.hidden = !alert;
  el.alert.replaceChildren(...(alert ? [h("p", {}, h("b", {}, ...isolated(alert.title))), h("p", {}, ...isolated(alert.body))] : []));
}

// ---------- poster ----------
function paintControls(): void {
  const poster = !!state.analysis;
  const allSkipped = ws.rows.length > 0 && ws.usable === 0;
  const primaryRender = state.busy || (!allSkipped && (state.dirty || !poster));
  el.render.classList.toggle("primary", primaryRender);
  el.render.setAttribute("aria-disabled", String(state.busy || !state.ready));
  el.render.textContent = state.busy ? "Rendering…" : "Render poster";
  el.png.classList.toggle("primary", poster && !state.dirty && !state.busy);
  el.verFoot.replaceChildren(h("bdi", {}, `everyturn ${ANALYZER_VERSION} · ${agentLabel(state.agent)} profile ${PROFILE_VERSION}`));
}

function paintPoster(): void {
  const a = state.analysis;
  el.out.hidden = !a;
  // The label above the frame says what the frame shows: the sample (dimmed before a render, or drawn from the sample) or the user's own files.
  el.capL.textContent = frameLabel(a && state.input);
  el.capR.replaceChildren(...(a ? [...isolated(frameCaption(state.input?.files.read ?? 0, a.model.totals.inventorySources), true), state.dirty ? " · out of date" : ""] : []));
  if (!a) return;
  el.findingField.hidden = a.choices.length === 0;
  const group = (label: string, kind: "conflict" | "duplicate") => {
    const items = a.choices.filter((c) => c.group === kind);
    return items.length ? h("optgroup", { label }, ...items.map((c) => h("option", { value: c.id, dir: "ltr", ...(c.id === a.selected ? { selected: "" } : {}) }, c.label))) : null;
  };
  el.finding.replaceChildren(...[group("Possible conflicts", "conflict"), group("Duplicates", "duplicate")].filter((g): g is HTMLOptGroupElement => !!g));
}

/**
 * Before a render the frame shows the bundled sample poster at 35% (decorative, alt "Sample poster"), drawn on this device by the same
 * renderer as every poster (see buildSamplePreview). Until it is ready the frame is simply empty at its full 4:5 size.
 */
function paintEmptyFrame(): void {
  if (state.analysis || !preview.img) return;
  if (el.frame.firstChild !== preview.img) el.frame.replaceChildren(preview.img);
}

/** Everything that depends on the list changing. */
function changed(opts: { keepTransient?: boolean } = {}): void {
  state.dirty = true;
  if (!opts.keepTransient) state.transient = null;
  paintList(); paintAlert(); paintEmptyFrame(); paintControls(); paintPoster();
}

function showAlert(alert: Alert): void { state.transient = alert; paintAlert(); }

// ---------- adding files ----------
function fileCandidate(file: File, path: string, direct: boolean): Candidate {
  return { path, size: file.size, direct, read: async (max) => new Uint8Array(await (max === undefined ? file : file.slice(0, max)).arrayBuffer()) };
}

/** `gen` is the workspace generation at the drop or picker EVENT (before any folder walk or read): files from before a Remove all / the sample are dropped. */
async function addCandidates(candidates: Candidate[], gen: number): Promise<void> {
  if (!candidates.length) return;
  const result = await ws.add(candidates, gen);
  // The workspace was cleared or replaced (the sample was loaded, Remove all) while these files were being read: nothing of them was kept.
  if (result.stale) return;
  changed();
  if (result.overLimit) showAlert(ALERTS.tooBig);
  setStatus(result.replaced.length === 1 ? STATUS.replaced(result.replaced[0]!) : ws.usable ? STATUS.ready(ws.usable) : "");
}

function fromFileList(list: FileList | null, direct: boolean): Candidate[] {
  return Array.from(list ?? []).slice(0, MAX_ENTRIES).flatMap((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const path = normalizePath(rel ? stripPickedRoot(rel) : file.name);
    return path ? [fileCandidate(file, path, direct && !rel)] : [];
  });
}

function addPasted(): "ok" | "error" | "limit" {
  el.pathErr.hidden = el.textErr.hidden = true;
  el.path.removeAttribute("aria-invalid"); el.text.removeAttribute("aria-invalid");
  const result = ws.addText(el.path.value, el.text.value);
  if ("error" in result) {
    const [input, err, message] = result.error === "path" ? [el.path, el.pathErr, "Add a file path, e.g. CLAUDE.md."] : [el.text, el.textErr, "Paste the file’s text first."];
    el.paste.open = true; // the error is inside the closed-by-default <details>: open it so it can be seen
    err.replaceChildren(...isolated(message)); err.hidden = false; input.setAttribute("aria-invalid", "true"); input.focus();
    return "error";
  }
  if (result.overLimit) { showAlert(ALERTS.tooBig); return "limit"; }
  const path = normalizePath(el.path.value)!;
  el.path.value = ""; el.text.value = "";
  changed();
  setStatus(result.replaced ? STATUS.replaced(path) : STATUS.ready(ws.usable));
  el.path.focus();
  return "ok";
}

// Dropped folders: walk the entries now (the DataTransfer is only valid during the event), collect File handles lazily.
type Entry = FileSystemEntry;
const entryFile = (entry: FileSystemFileEntry) => new Promise<File>((ok, fail) => entry.file(ok, fail));
async function readAll(dir: FileSystemDirectoryEntry): Promise<Entry[]> {
  const reader = dir.createReader();
  const out: Entry[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) return out;
    out.push(...batch);
    if (out.length > MAX_ENTRIES) return out;
  }
}
async function collect(entry: Entry, root: boolean, out: Candidate[]): Promise<void> {
  if (out.length >= MAX_ENTRIES) return;
  if (entry.isDirectory) {
    if (SKIPPED_DIRS.has(entry.name) && !root) return;
    for (const child of await readAll(entry as FileSystemDirectoryEntry)) await collect(child, false, out);
    return;
  }
  const file = await entryFile(entry as FileSystemFileEntry).catch(() => null);
  const full = entry.fullPath.replace(/^\/+/, "");
  const direct = !full.includes("/");
  const path = normalizePath(direct ? full : stripPickedRoot(full));
  if (file && path) out.push(fileCandidate(file, path, direct));
}

// ---------- rendering ----------
async function runRender(opts: { focus: boolean; choice?: string | undefined; reuse?: boolean }): Promise<void> {
  if (state.busy) return;
  if (!opts.reuse && ws.usable === 0) { showAlert(ALERTS.nothing); return; }
  if (!state.ready) {
    try { await loadRenderer(); state.ready = true; } catch { showAlert(ALERTS.noRenderer); paintControls(); return; }
  }
  state.busy = true;
  state.transient = null;
  const count = ws.usable;
  paintAlert(); paintControls(); // the frame keeps what it shows; the status line says what is happening

  setStatus(STATUS.rendering(count));
  await paint();
  try {
    // `sample` is read from the workspace in the same step that prepare() snapshots its files: the badge describes exactly what is drawn.
    const revision = ws.revision;
    const input = opts.reuse && state.input ? state.input : { sample: ws.sample, agent: state.agent, files: await ws.prepare() };
    const analysis = analyze({ files: input.files.files, imported: input.files.imported, warnings: input.files.warnings, agent: input.agent, sample: input.sample, choice: opts.choice });
    const exports = await rasterize(analysis.svg);
    // The workspace was cleared or replaced while this was being prepared and drawn: nothing of it is shown, the frame stays as it was and the page stays out of date.
    if (!opts.reuse && input.files.gen !== ws.generation) { state.dirty = true; setStatus(""); return; }
    const url = URL.createObjectURL(new Blob([exports.png as BlobPart], { type: "image/png" }));
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = url; state.analysis = analysis; state.exports = exports; state.input = input; state.choice = analysis.selected;
    // a file added or removed, or another agent selected, while this rendered leaves "out of date" showing (and the poster is not claimed as current)
    state.dirty = opts.reuse ? state.dirty : staleRender({ revision, agent: input.agent }, { revision: ws.revision, agent: state.agent });
    const img = h("img", { src: url, alt: analysis.alt, width: "1600", height: "2000" }); // the exact PNG that Download saves
    el.frame.replaceChildren(img);
    paintPoster();
    setStatus(!opts.reuse && input.agent !== state.agent ? STATUS.agentChanged : (opts.focus ? STATUS.doneReady : STATUS.done)(ws.usable, ws.rows.length));
  } catch {
    showAlert(ALERTS.threw);
    if (!state.analysis) paintEmptyFrame();
    setStatus("");
  } finally {
    state.busy = false;
    paintControls();
  }
  if (opts.focus && state.analysis) {
    el.posterHead.focus({ preventScroll: true });
    el.posterHead.scrollIntoView(POSTER_SCROLL);
  }
}

function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setStatus(STATUS.saved(name));
}

/** Ctrl/Cmd Enter and the Render button: pasted text is added first, with the same checks. */
async function renderPressed(): Promise<void> {
  if (state.busy) return;
  if (el.text.value.trim() && addPasted() !== "ok") return;
  await runRender({ focus: true });
}

// ---------- events ----------
function removeRow(path: string): void {
  const index = ws.orderedRows().findIndex((r) => r.path === path);
  ws.remove(path);
  changed();
  setStatus(ws.usable ? STATUS.ready(ws.usable) : "");
  const buttons = el.list.querySelectorAll<HTMLButtonElement>(".rm");
  (buttons[Math.min(index, buttons.length - 1)] ?? el.pick).focus();
}

el.list.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>(".rm");
  if (button?.dataset.path) removeRow(button.dataset.path);
});
el.clear.addEventListener("click", () => { ws.clear(); changed(); setStatus(""); el.pick.focus(); });
el.more.addEventListener("click", () => { state.expanded = !state.expanded; paintList(); });
narrow.addEventListener("change", paintList);
addEventListener("resize", fitPaths);

el.pick.addEventListener("click", () => el.fileInput.click());
// The drop zone's one button picks a folder; where the browser cannot, it reads "Choose files…" and opens the multi-file picker.
const canPickFolder = "webkitdirectory" in el.dirInput;
el.pickDir.addEventListener("click", () => (canPickFolder ? el.dirInput : el.fileInput).click());
el.fileInput.addEventListener("change", () => { const gen = ws.generation; const list = fromFileList(el.fileInput.files, true); el.fileInput.value = ""; void addCandidates(list, gen); });
el.dirInput.addEventListener("change", () => { const gen = ws.generation; const list = fromFileList(el.dirInput.files, false); el.dirInput.value = ""; void addCandidates(list, gen); });

el.add.addEventListener("click", () => { addPasted(); });
el.path.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); addPasted(); } });
// "Try the sample setup" renders the sample at full strength (and, like Render, moves focus to the Poster heading).
el.sample.addEventListener("click", () => { void trySample(); });
el.render.addEventListener("click", () => { void renderPressed(); });
addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void renderPressed(); } });

el.agent.addEventListener("change", () => {
  if (!isAgent(el.agent.value)) return;
  state.agent = el.agent.value;
  ws.touch(); // a render in flight was made for the old agent: it must not clear this flag
  state.dirty = true;
  paintList(); paintControls(); paintPoster();
  if (state.analysis) setStatus(STATUS.agentChanged);
});
el.finding.addEventListener("change", () => { void runRender({ focus: false, choice: el.finding.value, reuse: true }); });
el.png.addEventListener("click", () => { if (state.exports) download("everyturn.png", state.exports.png as BlobPart, "image/png"); });
el.svg.addEventListener("click", () => { if (state.exports) download("everyturn.svg", state.exports.outlinedSvg, "image/svg+xml"); });
el.json.addEventListener("click", () => { if (state.analysis) download("everyturn.json", reportJson(state.analysis.report), "application/json"); });

// Drag and drop: the whole page is the target. Only drags that carry files count.
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
function dragCount(e: DragEvent): string {
  const n = Array.from(e.dataTransfer?.items ?? []).filter((i) => i.kind === "file").length;
  return n > 0 ? `Drop to add ${n} ${n === 1 ? "file" : "files"}` : "Drop to add files";
}
for (const type of ["dragenter", "dragover"] as const) {
  document.addEventListener(type, (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    el.sources.classList.add("dragover");
    el.dragText.replaceChildren(...isolated(dragCount(e)));
  });
}
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) el.sources.classList.remove("dragover"); });
document.addEventListener("drop", (e) => {
  e.preventDefault(); // the browser never navigates to a dropped file
  el.sources.classList.remove("dragover");
  const gen = ws.generation; // the workspace this drop was made into: a folder still being walked when Remove all / the sample is clicked is discarded
  const items = Array.from(e.dataTransfer?.items ?? []);
  // Entries must be taken synchronously; reading them is async.
  const entries = items.filter((i) => i.kind === "file").map((i) => ({ entry: i.webkitGetAsEntry?.() ?? null, file: i.getAsFile() }));
  void (async () => {
    const out: Candidate[] = [];
    for (const { entry, file } of entries) {
      if (entry) await collect(entry, true, out).catch(() => undefined);
      else if (file) out.push(fileCandidate(file, file.name, true));
    }
    await addCandidates(out, gen);
  })();
});

async function loadSample(): Promise<void> {
  ws.clear();
  await ws.add(sampleCandidates());
  changed();
  setStatus(STATUS.ready(ws.usable));
}

async function trySample(): Promise<void> {
  if (state.busy) return;
  await loadSample();
  await runRender({ focus: true });
}

/**
 * Draw the bundled sample once, on this device, for the empty frame: a throwaway workspace (so it can never touch what the user adds or the
 * generation token), the same analyze() and rasterizer as every poster, and a blob: URL (img-src blob: already allows it). Best effort: if it
 * fails the frame stays empty at 4:5, and "Try the sample setup" still works.
 */
async function buildSamplePreview(): Promise<void> {
  try {
    const sampleWs = new Workspace();
    await sampleWs.add(sampleCandidates());
    const prepared = await sampleWs.prepare();
    const analysis = analyze({ files: prepared.files, imported: prepared.imported, warnings: prepared.warnings, agent: "claude-code", sample: sampleWs.sample });
    const drawn = await rasterize(analysis.svg);
    const url = URL.createObjectURL(new Blob([drawn.png as BlobPart], { type: "image/png" }));
    preview.img = h("img", { class: "dim", src: url, alt: "Sample poster", width: "1600", height: "2000" });
    paintEmptyFrame();
  } catch { /* the empty frame stays empty */ }
}

// ---------- start ----------
el.agent.replaceChildren(...AGENT_OPTIONS.map((a) => h("option", { value: a.value }, a.label)));
el.verTop.replaceChildren(h("bdi", {}, `Preview ${ANALYZER_VERSION}`));
el.kbd.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ Enter" : "Ctrl Enter";
if (canPickFolder) el.dirInput.setAttribute("webkitdirectory", ""); else el.pickDir.replaceChildren(h("bdi", {}, "Choose files…"));
if (query.get("shot") === "1") document.body.dataset.shot = "1";
changed();
setStatus(STATUS.loading);
/** `?shot=1` (screenshots only): publish the page height as a body attribute so the capture window can fit the page. */
async function markShot(): Promise<void> {
  if (query.get("shot") !== "1") return;
  await document.fonts.ready;
  await paint();
  document.body.dataset.height = String(document.documentElement.scrollHeight);
  document.body.dataset.overflow = String(document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

loadRenderer().then(async () => {
  state.ready = true;
  setStatus("");
  paintControls();
  await buildSamplePreview();
  // `?demo=sample` loads and draws the bundled sample, nothing else from the URL.
  if (query.get("demo") === "sample") {
    await loadSample();
    await runRender({ focus: false });
  }
  await markShot();
}, () => { setStatus(""); showAlert(ALERTS.noRenderer); paintControls(); void markShot(); });
