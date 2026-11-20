// The page works in a right-to-left context. Every mixed-direction run (the handle, the version lines, a count with its noun,
// sizes, file names and paths, the pickers' labels) is isolated with <bdi> (or dir="ltr" where it is an input or an option), and the poster,
// SVG and PNG are untouched (the byte-identity tests of app.test.ts cover those). No browser here: the markup and main.ts are read as text and
// isolate() is unit-tested; `npm run web-accept` checks the live DOM with dir=rtl.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isolate } from "../src/isolate";

const html = readFileSync("apps/web/index.html", "utf8");
const css = readFileSync("apps/web/src/styles.css", "utf8");
const main = readFileSync("apps/web/src/main.ts", "utf8");
const text = (parts: ReturnType<typeof isolate>) => parts.map((p) => ("text" in p ? p.text : p.run)).join("");
const runs = (s: string) => isolate(s).flatMap((p) => ("run" in p ? [p.run] : []));

describe("isolate(): runs that need isolating", () => {
  it("keeps the text exactly (full stops and ellipses included) and isolates each count with its noun", () => {
    for (const s of ["13 files · 3,106 bytes", "13 files read · 9 sources", "Rendered 13 files.", "Rendering 3 files…", "Rendered 3 of 4 files. 1 skipped.", "~394 est. tokens · 13 files", "Replaced CLAUDE.md.", "Preview 0.1.0"]) {
      expect(text(isolate(s)), s).toBe(s);
    }
    expect(runs("13 files · 3,106 bytes")).toEqual(["13 files", "3,106 bytes"]);
    expect(runs("13 files read · 9 sources")).toEqual(["13 files read", "9 sources"]);
    expect(runs("~394 est. tokens · 13 files")).toEqual(["~394 est. tokens", "13 files"]);
    expect(runs("1 file ready.")).toEqual(["1 file"]); // never the full stop
    expect(runs("Rendering 3 files…")).toEqual(["3 files"]); // never the ellipsis
    expect(runs("402.3 KiB")).toEqual(["402.3 KiB"]);
    expect(runs("read first 64 KiB")).toEqual(["64 KiB"]);
  });
  it("isolates file names and paths, but not the full stop after them", () => {
    expect(runs("Replaced CLAUDE.md.")).toEqual(["CLAUDE.md"]);
    expect(runs("Saved everyturn.png.")).toEqual(["everyturn.png"]);
    expect(runs("see docs/style.md and src/a.mdc.")).toEqual(["docs/style.md", "src/a.mdc"]);
  });
  it("marks the mono part (the number and its B / KiB / MiB unit) and leaves the noun plain", () => {
    const [a, b] = isolate("13 files · 2.0 KiB").filter((p) => "run" in p);
    expect(a).toEqual({ run: "13 files", mono: "13" });
    expect(b).toEqual({ run: "2.0 KiB", mono: "2.0 KiB" });
  });
  it("leaves plain sentences alone", () => {
    expect(isolate("Nothing is uploaded.")).toEqual([{ text: "Nothing is uploaded." }]);
  });
});

describe("the page markup isolates every mixed-direction run", () => {
  it("the @OrMiz handle (footer) and the wordmark (masthead and footer)", () => {
    expect(html).toContain('<bdi class="handle">@OrMiz</bdi>');
    const marks = html.match(/<span class="mark"[^>]*>/g) ?? [];
    expect(marks).toHaveLength(2);
    for (const m of marks) expect(m).toContain('dir="ltr"');
  });
  it("the version lines", () => {
    expect(html).toMatch(/id="ver-top"><bdi>Preview 0\.1\.0<\/bdi>/);
    expect(html).toMatch(/id="ver-foot"><bdi>everyturn 0\.1\.0 · Claude Code profile 0\.1<\/bdi>/);
    expect(main).toMatch(/verTop\.replaceChildren\(h\("bdi"/);
    expect(main).toMatch(/verFoot\.replaceChildren\(h\("bdi"/);
  });
  it("every count, size and file name written in the markup is a <bdi>", () => {
    expect(html).not.toMatch(/<span class="num">/);
    expect(html.match(/<bdi class="num">/g)?.length).toBeGreaterThanOrEqual(5);
    expect(html).toContain('<bdi class="mono">.env</bdi>');
    expect(html).toContain("<bdi>SKILL.md</bdi>");
    expect(html).toContain('id="kbd" aria-hidden="true" dir="ltr"');
  });
  it("the pickers' labels are isolated as a whole", () => {
    expect(html).toContain('id="pick-dir"><bdi>Choose folder…</bdi></button>');
    expect(html).toContain('id="pick"><bdi>Choose files…</bdi></button>');
    expect(main).toMatch(/pickDir\.replaceChildren\(h\("bdi", \{\}, "Choose files…"\)\)/);
  });
  it("main.ts builds counts, sizes, paths, options and statuses through isolate()", () => {
    expect(main).not.toContain("withNumbers");
    expect(main).toMatch(/isolated\(countLabel\(ws\), true\)/);
    expect(main).toMatch(/h\("bdi", \{ class: "sz" \}/); // sizes
    expect(main).toMatch(/h\("bdi", \{ class: "pt"/); // paths in the list
    expect(main).toMatch(/h\("option", \{ value: c\.id, dir: "ltr"/); // the finding picker
    expect(main).toMatch(/const setStatus = \(t[^)]*\) => \{ el\.status\.replaceChildren\(\.\.\.isolate/);
    expect(main).toMatch(/frameCaption\(/);
    for (const call of main.match(/isolate\([^;]*;/g) ?? []) expect(call).not.toMatch(/\.\.\.\.|…\)/);
  });
  it("styles: bdi and dir=ltr elements isolate, whatever the page direction", () => {
    expect(css).toMatch(/bdi,\[dir=ltr\]\{unicode-bidi:isolate\}/);
  });
});
