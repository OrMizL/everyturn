// Review r9, minor 2 and the isolate() nit: a render for an agent that is no longer selected leaves the page out of date, and isolate() is linear.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Workspace, staleRender } from "../src/app";
import { isolate } from "../src/isolate";

const main = readFileSync("apps/web/src/main.ts", "utf8");

describe("switching the agent during a render leaves the page out of date", () => {
  it("staleRender: a changed revision or a changed agent makes the finished render stale", () => {
    expect(staleRender({ revision: 3, agent: "claude-code" }, { revision: 3, agent: "claude-code" })).toBe(false);
    expect(staleRender({ revision: 3, agent: "claude-code" }, { revision: 4, agent: "claude-code" })).toBe(true);
    expect(staleRender({ revision: 3, agent: "claude-code" }, { revision: 3, agent: "codex" })).toBe(true);
    expect(staleRender({ revision: 3, agent: "claude-code" }, { revision: 4, agent: "codex" })).toBe(true);
  });
  it("Workspace.touch() advances the revision, so an agent change is a change of the workspace", () => {
    const ws = new Workspace();
    const before = ws.revision;
    ws.touch();
    expect(ws.revision).toBe(before + 1);
    ws.touch();
    expect(ws.revision).toBe(before + 2);
  });
  it("the page: the agent handler touches the workspace; a finished render compares its own revision and agent", () => {
    const handler = /el\.agent\.addEventListener\("change", \(\) => \{[\s\S]*?\n\}\);/.exec(main)?.[0] ?? "";
    expect(handler).toContain("state.agent = el.agent.value");
    expect(handler).toContain("ws.touch()");
    expect(handler).toContain("state.dirty = true");
    expect(main).toMatch(/staleRender\(\{ revision, agent: input\.agent \}, \{ revision: ws\.revision, agent: state\.agent \}\)/);
    // the render's own input records the agent it was made for, and a stale render is never claimed as current
    expect(main).toMatch(/state\.dirty = opts\.reuse \? state\.dirty : staleRender\(/);
  });
});

describe("isolate() is linear", () => {
  const KIB256 = 256 * 1024;
  const join = (parts: ReturnType<typeof isolate>) => parts.map((p) => ("text" in p ? p.text : p.run)).join("");
  const inputs: [string, string][] = [
    ["a. tokens", "a.".repeat(KIB256 / 2)],
    ["a/ tokens", "a/".repeat(KIB256 / 2)],
    ["1, tokens", "1,".repeat(KIB256 / 2)],
    ["a-b.c@d/ tokens", "a-b.c@d/".repeat(KIB256 / 8)],
    ["words and file names", "see docs/a.md and 12 files · ".repeat(KIB256 / 28)],
    ["a long path-like token ending in an extension", `${"a/".repeat(KIB256 / 2 - 4)}x.md`],
  ];
  it.each(inputs)("256 KiB of %s: under 500 ms, and the text is kept exactly", (name, text) => {
    isolate(text.slice(0, 4096));
    const t0 = performance.now();
    const parts = isolate(text);
    const ms = performance.now() - t0;
    console.log(`[perf] isolate ${name}: ${ms.toFixed(0)} ms at ${text.length / 1024} KiB`);
    expect(ms, name).toBeLessThan(500);
    expect(join(parts)).toBe(text);
  }, 60_000);
});
