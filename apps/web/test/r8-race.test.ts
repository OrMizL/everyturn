// Review r8, minors 1-3: the drop's generation, the 5 MiB cap under overlapping adds, and a render that must not mix an old import with a new workspace.
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/app";
import type { Candidate } from "../src/app";
import { sampleCandidates } from "../src/sample";

const enc = new TextEncoder();
const KIB = 1024;
const tick = () => new Promise<void>((ok) => setTimeout(ok, 0));
const quick = (path: string, body: string): Candidate => { const bytes = enc.encode(body); return { path, size: bytes.length, direct: true, read: async () => bytes }; };
/** A candidate of `kib` KiB whose read finishes only when `release()` is called (immediately when `gated` is false). */
function sized(path: string, kib: number, gated = false): { candidate: Candidate; release: () => void } {
  const bytes = enc.encode("a".repeat(kib * KIB));
  let release!: () => void;
  const gate = gated ? new Promise<void>((ok) => { release = ok; }) : Promise.resolve();
  if (!gated) release = () => undefined;
  return { candidate: { path, size: bytes.length, direct: true, read: async () => { await gate; return bytes; } }, release };
}
/** An import-only file (not an instruction source): kept as a handle and read only when `@imported`. */
function slowExtra(path: string, body: string): { candidate: Candidate; release: () => void } {
  const bytes = enc.encode(body);
  let release!: () => void;
  const gate = new Promise<void>((ok) => { release = ok; });
  return { candidate: { path, size: bytes.length, direct: false, read: async () => { await gate; return bytes; } }, release };
}
const fill = (n: number) => Array.from({ length: n }, (_, i) => sized(`d${i}/CLAUDE.md`, 256).candidate);

describe("the generation is captured at the drop event", () => {
  it("add() with a generation captured before Remove all / the sample is stale, even when the folder walk ends later", async () => {
    const ws = new Workspace();
    const gen = ws.generation; // the drop event
    ws.clear(); // ...the folder is still being walked when "Try the sample setup" is clicked
    await ws.add(sampleCandidates());
    const before = ws.rows.map((r) => r.path).sort();
    const result = await ws.add([quick("CLAUDE.md", "- Zorblatt owns this repo.\n")], gen); // the walk ends and hands over its list
    expect(result.stale).toBe(true);
    expect(ws.rows.map((r) => r.path).sort()).toEqual(before);
    expect(ws.sample).toBe(true);
    expect(JSON.stringify((await ws.prepare()).files)).not.toContain("Zorblatt");
  });
  it("Remove all after the drop event: nothing of the drop is added", async () => {
    const ws = new Workspace();
    const gen = ws.generation;
    ws.clear();
    expect((await ws.add([quick("CLAUDE.md", "- x\n")], gen)).stale).toBe(true);
    expect(ws.rows).toEqual([]);
  });
  it("a current generation adds as before", async () => {
    const ws = new Workspace();
    const result = await ws.add([quick("CLAUDE.md", "- x\n")], ws.generation);
    expect(result.stale).toBeUndefined();
    expect(ws.rows).toHaveLength(1);
  });
});

describe("overlapping adds cannot pass the 5 MiB cap", () => {
  it("19 x 256 KiB, then two concurrent 256 KiB adds: the total stays within 5 MiB and one is over the limit", async () => {
    const ws = new Workspace();
    await ws.add(fill(19));
    expect(ws.usableBytes).toBe(19 * 256 * KIB);
    const a = sized("x1/CLAUDE.md", 256, true);
    const b = sized("x2/CLAUDE.md", 256, true);
    const pa = ws.add([a.candidate]);
    const pb = ws.add([b.candidate]);
    await tick();
    a.release(); b.release();
    const results = await Promise.all([pa, pb]);
    expect(ws.usableBytes).toBeLessThanOrEqual(5 * KIB * KIB);
    expect(results.filter((r) => r.overLimit)).toHaveLength(1);
    expect(ws.usable).toBe(20);
  });
  it("a failed read releases its reservation", async () => {
    const ws = new Workspace();
    await ws.add(fill(19));
    const failing: Candidate = { path: "bad/CLAUDE.md", size: 256 * KIB, direct: true, read: async () => { throw new Error("nope"); } };
    await ws.add([failing]);
    const result = await ws.add([sized("ok/CLAUDE.md", 256).candidate]);
    expect(result.overLimit).toBe(false);
    expect(ws.usable).toBe(20);
  });
  it("pasted text counts the reservation of a read in flight", async () => {
    const ws = new Workspace();
    await ws.add(fill(19));
    const a = sized("x1/CLAUDE.md", 256, true);
    const pending = ws.add([a.candidate]);
    await tick();
    expect(ws.addText("pasted/CLAUDE.md", "a".repeat(256 * KIB))).toMatchObject({ overLimit: true });
    a.release();
    await pending;
    expect(ws.usableBytes).toBeLessThanOrEqual(5 * KIB * KIB);
  });
});

describe("a render never mixes an old import with a new workspace", () => {
  it("prepare() works on the files as they were when it began and returns that generation, so a Clear + paste meanwhile is detected", async () => {
    const ws = new Workspace();
    ws.addText("CLAUDE.md", "- Old root.\n\n@docs/style.md\n");
    const extra = slowExtra("docs/style.md", "- Old import.\n");
    await ws.add([extra.candidate]); // an import-only extra; its read is gated
    const startedAt = ws.generation;
    const pending = ws.prepare();
    await tick();
    ws.clear();
    ws.addText("CLAUDE.md", "- Brand new root.\n");
    extra.release();
    const prepared = await pending;
    expect(prepared.gen).toBe(startedAt);
    expect(prepared.gen).not.toBe(ws.generation);
    expect(JSON.stringify(prepared.files)).not.toContain("Brand new root");
    expect(prepared.files.some((f) => f.path === "CLAUDE.md" && f.text.includes("Old root"))).toBe(true);
  });
  it("revision moves on every change of the list", () => {
    const ws = new Workspace();
    const r0 = ws.revision;
    ws.addText("CLAUDE.md", "- x\n");
    const r1 = ws.revision;
    ws.remove("CLAUDE.md");
    const r2 = ws.revision;
    ws.clear();
    expect(r1).toBeGreaterThan(r0);
    expect(r2).toBeGreaterThan(r1);
    expect(ws.revision).toBeGreaterThan(r2);
  });
});
