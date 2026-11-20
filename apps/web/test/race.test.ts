// A slow read must never land in a workspace that was cleared or replaced after the read started, and the
// "sample" badge is derived from what is in the workspace, never from a flag set around an await.
import { describe, expect, it } from "vitest";
import { Workspace, analyze } from "../src/app";
import type { Candidate } from "../src/app";
import { sampleCandidates } from "../src/sample";

const enc = new TextEncoder();
/** A candidate whose read finishes only when `release()` is called. */
function slow(path: string, body: string): { candidate: Candidate; release: () => void } {
  const bytes = enc.encode(body);
  let release!: () => void;
  const gate = new Promise<void>((ok) => { release = ok; });
  return { candidate: { path, size: bytes.length, direct: false, read: async () => { await gate; return bytes; } }, release };
}
const quick = (path: string, body: string): Candidate => { const bytes = enc.encode(body); return { path, size: bytes.length, direct: true, read: async () => bytes }; };
const tick = () => new Promise<void>((ok) => setTimeout(ok, 0));

describe("workspace generation token", () => {
  it("drops a slow folder read that finishes after the sample was loaded: the sample stays a sample, with only its own files", async () => {
    const ws = new Workspace();
    const real = slow("CLAUDE.md", "- Zorblatt owns this repo.\n");
    const pending = ws.add([real.candidate]);
    await tick();
    // loadSample(): clear, then add the bundled files
    ws.clear();
    await ws.add(sampleCandidates());
    const before = ws.rows.map((r) => r.path).sort();
    real.release();
    const result = await pending;
    expect(result.stale).toBe(true);
    expect(ws.rows.map((r) => r.path).sort()).toEqual(before);
    expect(ws.sample).toBe(true);
    const prepared = await ws.prepare();
    expect(JSON.stringify(prepared.files)).not.toContain("Zorblatt");
    // and the poster drawn from it is the sample's, with the sample badge
    const a = analyze({ files: prepared.files, imported: prepared.imported, warnings: prepared.warnings, agent: "claude-code", sample: ws.sample });
    expect(a.dataset).toBe("SAMPLE SETUP");
  });

  it("the reverse: a sample load that is still reading when real files are added never makes the mix a sample", async () => {
    const ws = new Workspace();
    const first = sampleCandidates();
    const gated = slow("zz-late/CLAUDE.md", "- late sample file\n");
    const sampleAdd = ws.add([{ ...gated.candidate, sample: true }, ...first]);
    await tick();
    await ws.add([quick("AGENTS.md", "- Use spaces.\n")]);
    gated.release();
    await sampleAdd;
    expect(ws.rows.some((r) => r.path === "AGENTS.md")).toBe(true);
    expect(ws.sample).toBe(false);
    expect(analyze({ files: (await ws.prepare()).files, agent: "claude-code", sample: ws.sample }).dataset).toBe("UNREVIEWED REAL SET");
  });

  it("a slow read that finishes after Remove all adds nothing", async () => {
    const ws = new Workspace();
    const real = slow("CLAUDE.md", "- hello\n");
    const pending = ws.add([real.candidate]);
    await tick();
    ws.clear();
    real.release();
    expect((await pending).stale).toBe(true);
    expect(ws.rows).toEqual([]);
    expect(ws.sample).toBe(false);
  });

  it("sample is derived from the contents: the sample, then any pasted or added file or a replaced sample file, is not a sample", async () => {
    const ws = new Workspace();
    expect(ws.sample).toBe(false);
    await ws.add(sampleCandidates());
    expect(ws.sample).toBe(true);
    ws.addText("notes/CLAUDE.md", "- Use spaces.\n");
    expect(ws.sample).toBe(false);
    ws.remove("notes/CLAUDE.md");
    expect(ws.sample).toBe(true);
    await ws.add([quick("CLAUDE.md", "- Mine.\n")]); // replaces the sample's CLAUDE.md
    expect(ws.sample).toBe(false);
    ws.clear();
    await ws.add(sampleCandidates());
    expect(ws.sample).toBe(true);
    await ws.add([{ ...quick("docs/x.md", "x"), direct: false }]); // an import-only extra from the user
    expect(ws.sample).toBe(false);
  });

  it("a real add before the sample load is replaced by it (clear), and two real adds in flight both land", async () => {
    const ws = new Workspace();
    const a = slow("a/CLAUDE.md", "- a\n");
    const b = slow("b/CLAUDE.md", "- b\n");
    const pa = ws.add([a.candidate]);
    const pb = ws.add([b.candidate]);
    await tick();
    b.release(); a.release();
    await Promise.all([pa, pb]);
    expect(ws.rows.map((r) => r.path).sort()).toEqual(["a/CLAUDE.md", "b/CLAUDE.md"]);
    expect(ws.sample).toBe(false);
  });
});
