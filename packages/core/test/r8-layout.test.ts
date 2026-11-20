import { describe, expect, it } from "vitest";
import { buildPosterModel, buildReport, poster, type PosterConflict, type PosterFindings, type PosterModel, type RawSource } from "../src/index";

// The findings card is centred between the end of the table and the footer rule. Each gap is at least 40 poster units for
// tables up to 9 rows; at 10 rows (the maximum) the measured 22 / 22 is accepted. A card variant that would not fit is shown with fewer items
// (the "1 of N" picker handles the rest), never squeezed.
const raw = (logicalPath: string, tokens: number): RawSource => ({ logicalPath, text: "x".repeat(tokens * 4), scope: "project" });
/** `n` counted sources (n = 0: none). Flat mode, one row each. */
const sources = (n: number): RawSource[] => Array.from({ length: n }, (_, i) => raw(i === 0 ? "CLAUDE.md" : `.claude/rules/r${String(i).padStart(2, "0")}.md`, 100 - i));
const LONG = "Never add comments to code of any kind, because the names must carry the whole meaning, and reviewers read the diff, not the narrative around it, and so on and on and on and on and on.";
const quote = (text: string, path: string, line: number) => ({ text, ref: { path, line } });
const conflict = (a = "Don't add comments.", b = "Add comments.", extra: Partial<PosterConflict> = {}): PosterConflict =>
  ({ a: quote(a, "CLAUDE.md", 1), b: quote(b, "AGENTS.md", 2), confidence: "medium", note: "Both load at repo root. No clear precedence; which one wins is unknown.", ...extra });
const dup = { text: "Always run `npm test` before committing.", refs: [{ path: "CLAUDE.md", line: 4 }, { path: "AGENTS.md", line: 5 }, { path: ".cursor/rules/general.mdc", line: 5 }, { path: "docs/a.md", line: 1 }, { path: "docs/b.md", line: 2 }] };
const VARIANTS: Record<string, PosterFindings | undefined> = {
  "findings off": undefined,
  "none found": { conflicts: [], duplicates: [] },
  "overrides only": { conflicts: [], duplicates: [], overrides: [conflict()] },
  "conflict, short quotes": { conflicts: [conflict()], duplicates: [] },
  "conflict, 3-line quotes": { conflicts: [conflict(LONG, LONG)], duplicates: [] },
  "conflict, withheld quotes": { conflicts: [conflict("", "", {})].map((c) => ({ ...c, a: { ...c.a, withheld: true }, b: { ...c.b, withheld: true } })), duplicates: [] },
  "conflict + duplicate": { conflicts: [conflict()], duplicates: [dup] },
  "3-line conflict + duplicate (the tallest card)": { conflicts: [conflict(LONG, LONG), conflict()], duplicates: [dup, dup] },
  "duplicate only": { conflicts: [], duplicates: [dup] },
  "setting conflict": { conflicts: [conflict("\"model\": \"opus\"", "\"model\": \"sonnet\"", { setting: true })], duplicates: [] },
};

const num = (s: string, attr: string) => Number(new RegExp(`${attr}="(-?[\\d.]+)"`).exec(s)![1]);
/** Card rectangle, last table rule and footer rule, read from the model's shapes. */
function geometry(model: PosterModel) {
  const shapes = model.items.filter((it) => it.type === "shape") as { zone: string; svg: string }[];
  const cardRect = shapes.find((s) => s.zone === "card" && s.svg.startsWith("<rect") && /rx="/.test(s.svg))!;
  const cardTop = num(cardRect.svg, "y") - 1, cardBottom = cardTop + num(cardRect.svg, "height") + 2;
  const lists = shapes.filter((s) => s.zone === "list" && s.svg.startsWith("<line")).map((s) => num(s.svg, "y1"));
  const footer = shapes.find((s) => s.zone === "footer" && s.svg.startsWith("<line"))!;
  // The empty state ("No sources found.") takes the space of one row below the header rule at 560.
  return { cardTop, cardBottom, tableEnd: Math.max(560 + poster.rowHeight, ...lists), footerRule: num(footer.svg, "y1") };
}

describe("the centred findings card keeps its gaps", () => {
  const rows = Array.from({ length: 11 }, (_, n) => n);
  for (const [name, findings] of Object.entries(VARIANTS)) {
    it.each(rows)(`${name}: %i rows`, (n) => {
      const model = buildPosterModel(buildReport(sources(n), { dataset: "sample" }), { findings });
      const g = geometry(model);
      const above = g.cardTop - g.tableEnd;
      const below = g.footerRule - g.cardBottom;
      expect(Math.abs(above - below)).toBeLessThan(0.01); // centred
      const drawn = Math.max(1, (g.tableEnd - 560) / poster.rowHeight);
      if (drawn <= 9) expect(above, `${n} rows: gap ${above}`).toBeGreaterThanOrEqual(40);
      else expect(above).toBeGreaterThanOrEqual(22);
      expect(drawn).toBeLessThanOrEqual(10);
      // every element of the card layer sits inside the card
      for (const it of model.items.filter((x) => x.zone === "card")) {
        if (it.type === "text") {
          expect(it.y - it.size * 0.9, `${it.text}`).toBeGreaterThanOrEqual(g.cardTop);
          expect(it.y + it.size * 0.25, `${it.text}`).toBeLessThanOrEqual(g.cardBottom);
        }
      }
    });
  }
  it("the gap is 364 for 0-1 rows, 60 at 9 rows, 22 at 10 rows as measured", () => {
    const gap = (n: number) => { const g = geometry(buildPosterModel(buildReport(sources(n), { dataset: "sample" }), { findings: VARIANTS["conflict, short quotes"] })); return g.cardTop - g.tableEnd; };
    expect([gap(0), gap(1), gap(9), gap(10)]).toEqual([364, 364, 60, 22]);
  });
});
