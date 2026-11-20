// main.ts is read as text (no browser here; web-accept drives the built page).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync("apps/web/src/main.ts", "utf8");

describe("the generation is captured at the event, before any await", () => {
  it("the drop handler takes ws.generation synchronously, before the async walk, and passes it to addCandidates", () => {
    const drop = main.slice(main.indexOf('document.addEventListener("drop"'), main.indexOf("async function loadSample"));
    expect(drop).toMatch(/const gen = ws\.generation/);
    expect(drop.indexOf("const gen = ws.generation")).toBeLessThan(drop.indexOf("void (async () =>"));
    expect(drop).toMatch(/await addCandidates\(out, gen\)/);
  });
  it("both picker handlers capture it before reading the list", () => {
    for (const input of ["fileInput", "dirInput"]) {
      const line = main.split("\n").find((l) => l.startsWith(`el.${input}.addEventListener("change"`))!;
      expect(line, input).toMatch(/const gen = ws\.generation;.*fromFileList.*addCandidates\(list, gen\)/);
    }
  });
  it("addCandidates hands the generation to Workspace.add", () => {
    expect(main).toMatch(/async function addCandidates\(candidates: Candidate\[\], gen: number\)/);
    expect(main).toMatch(/ws\.add\(candidates, gen\)/);
    expect(main.match(/addCandidates\(\w+, gen\)/g)).toHaveLength(3); // the two pickers and the drop
  });
});

describe("a render started under an older generation is discarded", () => {
  const render = main.slice(main.indexOf("async function runRender"), main.indexOf("el.agent.replaceChildren") > 0 ? main.indexOf("async function runRender") + 3500 : undefined);
  it("compares the generation of what was prepared with the workspace's after the raster, before anything is committed", () => {
    expect(render).toMatch(/input\.files\.gen !== ws\.generation/);
    expect(render.indexOf("input.files.gen !== ws.generation")).toBeLessThan(render.indexOf("URL.createObjectURL"));
    expect(render.indexOf("input.files.gen !== ws.generation")).toBeLessThan(render.indexOf("state.analysis = analysis"));
  });
  it("a stale render leaves dirty true and clears the status; a change during a render leaves dirty true too", () => {
    expect(render).toMatch(/gen !== ws\.generation\) \{ state\.dirty = true; setStatus\(""\); return; \}/);
    // the revision comparison is staleRender's (unit-tested in r10.test.ts), which also compares the agent the render was made for
    expect(render).toMatch(/state\.dirty = opts\.reuse \? state\.dirty : staleRender\(\{ revision, agent: input\.agent \}, \{ revision: ws\.revision, agent: state\.agent \}\)/);
  });
});
