// The page's markup and CSS against the web spec, read as text. No browser here; the built page is
// driven by `npm run web-accept` (gate:full), which checks the live DOM, the coarse-pointer heading and the focus move.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync("apps/web/index.html", "utf8");
const css = readFileSync("apps/web/src/styles.css", "utf8");
const main = readFileSync("apps/web/src/main.ts", "utf8");
/** Text of the first element matching a regex over the markup, tags stripped. */
const textOf = (re: RegExp) => (re.exec(html)?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const block = (open: string, close: string) => { const a = html.indexOf(open); return html.slice(a, html.indexOf(close, a)); };

describe("page structure", () => {
  it("has every element main.ts looks up by id", () => {
    const ids = [...main.matchAll(/\$(?:<[^>]+>)?\("([\w-]+)"\)/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(30);
    for (const id of ids) expect(html, `#${id}`).toContain(`id="${id}"`);
  });

  it("opens Sources with one drop zone: a heading and one outline button, no hint text inside", () => {
    const zone = block('<div class="drop"', '<p class="sample-line">');
    expect(zone.match(/<button\b/g)).toHaveLength(1);
    expect(zone).toContain('id="pick-dir"><bdi>Choose folder…</bdi></button>'); // the whole label is isolated (right-to-left pages)
    expect(zone.match(/<p\b/g)).toHaveLength(1); // the heading only
    expect(zone).not.toMatch(/KiB|MiB|\.env|hint|Up to/);
    expect(zone).toContain('role="group" aria-labelledby="drop-h"');
    // Order in the column: drop zone, the sample link right under it, the agent row, the paste details, files, render, footnote last.
    const order = ['id="drop"', 'id="sample">Try the sample setup', 'class="agent-row"', '<details class="paste"', 'id="files"', 'id="render"', 'class="footnote"'].map((s) => html.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.indexOf('class="footnote"')).toBeLessThan(html.indexOf("</section>", html.indexOf('id="sources"')));
  });

  it("keeps both heading strings in the DOM and shows exactly one: pointer, touch (pointer: coarse) or drag", () => {
    const heading = block('<p class="drop-h"', "</p>");
    expect(heading).toContain('<span class="when-pointer">Drop your repo folder</span>');
    expect(heading).toContain('<span class="when-touch">Choose your repo folder</span>');
    expect(heading).toContain('<span class="when-drag" id="drag-text">Drop to add files</span>');
    // Hidden variants are display:none (out of the accessibility tree), so the accessible name is what is shown.
    expect(css).toMatch(/\.when-touch,\.when-drag\{display:none\}/);
    expect(css).toMatch(/@media \(pointer:coarse\)\{\s*\.when-pointer\{display:none\}\s*\.when-touch\{display:inline\}/);
    expect(css).toMatch(/#sources\.dragover \.when-pointer,#sources\.dragover \.when-touch\{display:none\}/);
    expect(css).toMatch(/#sources\.dragover \.when-drag\{display:inline\}/);
    // Narrow width alone does not switch the heading (a narrow desktop window can still drop).
    expect(css.replace(/\s+/g, " ")).not.toMatch(/max-width:959px\)[^{]*\{[^}]*\.when-touch/);
    expect(main).toContain('`Drop to add ${n} ${n === 1 ? "file" : "files"}`'); // no full stop, like the heading
  });

  it("puts paste behind a closed native <details>, with File path, Contents, Add file and Choose files…", () => {
    const details = block('<details class="paste"', "</details>");
    expect(details).not.toMatch(/<details[^>]*\sopen/);
    expect(details).toContain("<summary>Paste one file instead</summary>");
    for (const s of ["File path", "Contents", 'id="add">Add file', 'id="pick"><bdi>Choose files…</bdi>']) expect(details).toContain(s);
    expect(html.indexOf('id="agent"')).toBeLessThan(html.indexOf("<details"));
  });

  it("has the lede (18 words), the privacy line and one muted footnote with the limits", () => {
    const lede = textOf(/<p class="lede">(.*?)<\/p>/);
    expect(lede).toBe("See how many tokens your agent’s instruction files add before you type, and which rules repeat or contradict.");
    expect(lede.split(/\s+/)).toHaveLength(18);
    expect(textOf(/<p class="privacy">(.*?)<\/p>/)).toBe("Runs in your browser. Nothing is uploaded. Don’t paste secrets anyway.");
    const note = textOf(/<p class="footnote">(.*?)<\/p>/);
    expect(note).toBe("Up to 256 KiB a file and 5 MiB in all. A SKILL.md over that is read up to its first 64 KiB. .env files are never read.");
    // The limits live there and nowhere else on the page.
    expect(html.replace(/<p class="footnote">.*?<\/p>/s, "").match(/KiB|MiB/g)).toBeNull();
  });

  it("has number-free sentence-case section heads, and the Poster heading is the focus target after a render", () => {
    expect(textOf(/<h2 id="h-sources">(.*?)<\/h2>/)).toBe("Sources");
    expect(textOf(/<h2 id="h-poster" tabindex="-1">(.*?)<\/h2>/)).toBe("Poster");
    expect(html).toContain('<span class="meta">PNG · <bdi class="num">1600 × 2000</bdi></span>');
    expect(html).not.toMatch(/class="n"|>0[12]</);
    expect(css).toMatch(/\.sec\{[^}]*font:600 13px\/20px var\(--font\)/);
    expect(css).toMatch(/\.sec\{[^}]*border-block-start:1px solid var\(--ink\)/);
    expect(css).not.toMatch(/text-transform:uppercase|letter-spacing:\.12em/);
    expect(main).toContain("posterHead: $(\"h-poster\")");
    expect(main).toMatch(/el\.posterHead\.focus\(\{ preventScroll: true \}\);\s*el\.posterHead\.scrollIntoView\(POSTER_SCROLL\)/);
    expect(html).toContain('<a class="skip" href="#poster">Skip to poster</a>');
  });

  it("labels the frame above it and shows the sample at 35% when empty: no 'No poster yet', no crop marks", () => {
    expect(html.indexOf('id="cap-l">Sample · synthetic data')).toBeLessThan(html.indexOf('id="frame"'));
    expect(css).toMatch(/\.frame img\.dim\{opacity:\.35\}/);
    expect(css).toMatch(/\.frame-label\{[^}]*color:var\(--ink\)/);
    expect(css).toMatch(/\.frame-label \.mono\{font-size:12px\}/);
    expect(main).toContain('alt: "Sample poster"');
    expect(main).toContain('class: "dim"');
    expect(main).not.toMatch(/No poster yet|crop/i);
    expect(css).not.toMatch(/\.crop|\.empty\b/);
    expect(html).not.toMatch(/<img\b/i); // images are only ever created from blob: URLs (the CSP says img-src blob:)
    expect(main).not.toMatch(/data:image|fetch\(/);
    expect(main).toContain("frameLabel(a && state.input)");
    expect(main).toContain("frameCaption(state.input?.files.read ?? 0, a.model.totals.inventorySources)");
    expect(html).toContain('<p class="frame-label"><span class="mono" id="cap-l">Sample · synthetic data</span><span id="cap-r"></span></p>');
  });

  it("gives the Poster heading no focus ring of its own, and leaves every other focus style alone", () => {
    expect(html).toContain('<h2 id="h-poster" tabindex="-1">Poster</h2>');
    expect(css).toMatch(/#h-poster:focus,#h-poster:focus-visible\{outline:none\}/);
    expect(css.match(/#h-poster/g)).toHaveLength(2);
    expect(css).toMatch(/:focus-visible\{outline:2px solid var\(--focus\);outline-offset:2px\}/);
    expect(main).toMatch(/el\.posterHead\.focus\(\{ preventScroll: true \}\)/);
    expect(readFileSync("apps/web/src/app.ts", "utf8")).toContain('const POSTER_READY = "Poster ready.";');
  });

  it("keeps mono for paths, filenames, sizes and numbers: hints, the version line and the kbd hint are Inter", () => {
    expect(css).not.toMatch(/(?:\.hint|\.kbd|kbd|\.foot \.v|\.mast \.ver|\.caption|\.files \.head \.count)\{[^}]*var\(--mono\)/);
    expect(css).toMatch(/\.num\{font-family:var\(--mono\)/);
    expect(html).not.toMatch(/<kbd|<code/);
    expect(html).toContain('<button class="link" type="button" id="svg">SVG</button>');
  });

  it("keeps the 1px inset focus line on text fields and one ink ring elsewhere", () => {
    expect(css).toMatch(/input:focus-visible,textarea:focus-visible,select:focus-visible\{outline:0;border-color:var\(--focus\);box-shadow:inset 0 0 0 1px var\(--focus\)\}/);
    expect(css).toMatch(/:focus-visible\{outline:2px solid var\(--focus\);outline-offset:2px\}/);
    expect(css.match(/box-shadow/g)).toHaveLength(1); // no other shadow anywhere
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/gradient|backdrop-filter|border-radius:\s*(?:[3-9]|\d\d)/);
  });

  it("says POSSIBLE CONFLICT everywhere on the page", () => {
    expect(main).toContain('group("Possible conflicts", "conflict")');
    for (const text of [html, css, main]) expect(text).not.toMatch(/otential/);
  });
});
