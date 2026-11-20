import { describe, expect, it } from "vitest";
import {
  buildPosterModel, buildReport, compileDenylist, light, middleTruncate, poster, renderPosterHtml, renderPosterSvg, renderSourcesTableHtml, theme, dark,
  type PosterFindings, type PosterModel, type RawSource,
} from "../src/index";

const j = (...parts: string[]) => parts.join("");
const raw = (logicalPath: string, tokens: number, scope: RawSource["scope"] = "project"): RawSource => ({ logicalPath, text: "x".repeat(tokens * 4), scope });
const skill = (name: string, desc = "does a thing"): RawSource => ({ logicalPath: `.claude/skills/${name.replace(/[^a-z0-9]/gi, "")}/SKILL.md`, text: `---\nname: ${name}\ndescription: ${desc}\n---\nbody`, scope: "project" });
const skillAt = (logicalPath: string, name: string): RawSource => ({ logicalPath, text: `---\nname: ${name}\ndescription: does a thing\n---\nbody`, scope: "project" });
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
/** Visible text nodes (tspans merged), decoded. */
const texts = (svg: string) => [...svg.matchAll(/<text [^>]*>(.*?)<\/text>/g)].map((m) => decode(m[1]!.replace(/<[^>]+>/g, "")));

/** A rule file with YAML frontmatter, padded to about `tokens` tokens. */
const withFm = (logicalPath: string, fm: string, tokens: number, scope: RawSource["scope"] = "project"): RawSource =>
  ({ logicalPath, text: `---\n${fm}\n---\n` + "x".repeat(Math.max(0, tokens * 4 - fm.length - 9)), scope });
const settings = (): RawSource => ({ logicalPath: ".claude/settings.json", text: JSON.stringify({ model: "sonnet", permissions: { allow: ["a", "b"] }, hooks: { Stop: [{ hooks: [{}] }] } }), scope: "project" });
const mcp = (): RawSource => ({ logicalPath: ".mcp.json", text: JSON.stringify({ mcpServers: { one: { url: "https://h.example/x" } } }), scope: "project" });
const demo = () => buildReport([
  raw("CLAUDE.md", 195), raw("AGENTS.md", 104), withFm(".cursor/rules/typescript.mdc", 'globs: "**/*.ts"\nalwaysApply: false', 53), raw("apps/web/CLAUDE.md", 45, "nested"),
  raw("packages/api/AGENTS.md", 38, "nested"), withFm(".cursor/rules/general.mdc", "alwaysApply: true", 36), raw("CLAUDE.local.md", 29), raw(".github/copilot-instructions.md", 20),
  raw(".claude/rules/style.md", 12), settings(), mcp(),
]);
const manyRaw = (n: number): RawSource[] => [
  ...Array.from({ length: n }, (_, i) => raw(`apps/pkg${String(i).padStart(2, "0")}/CLAUDE.md`, 100 - i * 2, "nested")),
  raw(".claude/rules/a.md", 60), raw(".claude/rules/b.md", 5), skill("alpha"), skill("beta"), raw("CLAUDE.local.md", 7),
];
const many = (n: number) => buildReport(manyRaw(n));
/** `n` counted rules plus a few other counted sources: grouped mode is chosen from counted sources only (the not-counted row is separate). */
const groupedRaw = (n: number): RawSource[] => [
  ...Array.from({ length: n }, (_, i) => raw(`.claude/rules/r${String(i).padStart(2, "0")}.md`, 100 - i)),
  raw("CLAUDE.md", 120), skill("alpha"), skill("beta"), raw("CLAUDE.local.md", 7),
];
const findings = (): PosterFindings => ({
  conflicts: [
    { a: { text: "Don't add comments to code; write self-explanatory names instead.", ref: { path: "CLAUDE.md", line: 13 } },
      b: { text: "Document as you go: add a comment above every non-obvious function.", ref: { path: "AGENTS.md", line: 6 } },
      confidence: "medium", note: "Both load at repo root. No clear precedence; which one wins is unknown." },
    { a: { text: "low", ref: { path: "CLAUDE.md", line: 1 } }, b: { text: "low", ref: { path: "AGENTS.md", line: 2 } }, confidence: "low", note: "n/a" },
  ],
  duplicates: [{ text: "Always run `npm test` before committing.", refs: [{ path: "CLAUDE.md", line: 4 }, { path: "AGENTS.md", line: 5 }, { path: ".cursor/rules/general.mdc", line: 5 }] }],
});

/** Approximate glyph box: ascent 0.9em above and 0.25em below the baseline. */
function outsideCrop(model: PosterModel) {
  return model.items.filter((it) => it.type === "text" && ["hero", "list", "card"].includes(it.zone))
    .filter((it) => it.type === "text" && (it.y - it.size * 0.9 < poster.cropTop || it.y + it.size * 0.25 > poster.cropBottom))
    .map((it) => it.type === "text" ? it.text : "");
}

describe("theme", () => {
  it("keeps the table keys and adds the design tokens", () => {
    expect(theme).toBe(light);
    for (const k of ["font", "mono", "ink", "muted", "rule", "bar", "paper"] as const) expect(light[k]).toBeTruthy();
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
    expect(light.paper).toBe("#F7F7F4");
    expect(poster.width).toBe(1600);
  });
});

describe("poster svg", () => {
  it("is a 1600x2000 svg with the hero, labels, eyebrow and footer", () => {
    const report = demo();
    const svg = renderPosterSvg(report, { version: "9.9.9" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="1600" height="2000"');
    const all = texts(svg);
    const claude = report.sources.filter((s) => s.agent === "claude-code");
    const always = claude.filter((s) => s.activation === "always");
    const hero = always.reduce((s, x) => s + x.estTokens, 0);
    expect(all).toContain(`~${hero}`);
    expect(all).toContain("est. tokens");
    expect(all).toContain(`from ${always.length} always-loaded sources, before you type anything`);
    expect(all).toContain("Conflicts and duplicates not checked"); // findings were not run: the header never claims "none found"
    // Not-counted sources collapse into one muted row; they are not listed one by one any more.
    expect(all).toContain(`Also found, not counted: ${claude.length - always.length}`);
    expect(all).toContain("1 nested · 2 config (settings, MCP) · not in the total");
    expect(all.some((t) => t.startsWith("+") && t.includes("listed, not counted"))).toBe(false);
    expect(all).toContain("WHAT CLAUDE CODE IS TOLD EVERY TURN · REPO ROOT");
    expect(all).toContain("SAMPLE SETUP");
    for (const s of claude) {
      const shown = s.activation === "always";
      if (shown) expect(all).toContain(s.label);
      expect(all.includes(s.logicalPath)).toBe(shown);
    }
    expect(all.some((t) => t.startsWith(`everyturn 9.9.9 · Claude Code profile · ${claude.length} sources · `))).toBe(true);
    expect(all).toContain("@OrMiz");
    expect(all).toContain("Static scan, not a recording of a live turn. Tokens estimated (UTF-8 bytes ÷ 4). Conflicts are heuristic; check the evidence.");
    expect(svg).toContain(">every<tspan");
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    expect(renderPosterSvg(report, { dataset: "REDACTED REAL SET" })).toContain("REDACTED REAL SET");
  });

  it("counts only always-loaded text in the hero: no nested files, glob-scoped rules or config summaries", () => {
    const report = demo();
    const svg = renderPosterSvg(report);
    // CLAUDE.md 195 + CLAUDE.local.md 29 + unscoped rule 12; apps/web/CLAUDE.md (45), settings and MCP are excluded.
    expect(texts(svg)).toContain("~236");
    expect(buildPosterModel(report).totals).toMatchObject({ sources: 3, tokens: 236, listed: 3, inventorySources: 6 });
    const claudeAll = report.sources.filter((s) => s.agent === "claude-code").reduce((s, x) => s + x.estTokens, 0);
    expect(claudeAll).toBeGreaterThan(236);
    expect(texts(svg)).not.toContain(`~${claudeAll}`);
    expect(texts(svg)).toContain("from 3 always-loaded sources, before you type anything");
    expect(texts(svg).some((t) => /^from \d+ sources/.test(t))).toBe(false);
    expect(svg).toContain("<title>Every Turn poster: ~236 estimated tokens from 3 always-loaded Claude Code sources</title>");
  });

  it("codex counts root AGENTS.md and skill listings; cursor counts alwaysApply rules and .cursorrules", () => {
    const report = buildReport([
      raw("AGENTS.md", 40), raw("AGENTS.override.md", 10), raw("packages/api/AGENTS.md", 99, "nested"), skillAt(".codex/skills/x/SKILL.md", "x"),
      raw("~/.codex/AGENTS.md", 5, "user"),
      raw(".cursorrules", 7), withFm(".cursor/rules/a.mdc", "alwaysApply: true", 20), withFm(".cursor/rules/b.mdc", "alwaysApply: false", 30),
      withFm(".cursor/rules/c.mdc", 'description: when asked\nglobs: "*.ts"', 50), raw(".cursor/rules/d.mdc", 60), settings(),
    ]);
    const codex = report.sources.filter((s) => s.agent === "codex");
    // Codex loads ONE of AGENTS.override.md / AGENTS.md per directory: the shadowed AGENTS.md is listed, not counted.
    const codexAlways = codex.filter((s) => !s.logicalPath.startsWith("packages/") && s.logicalPath !== "AGENTS.md").reduce((s, x) => s + x.estTokens, 0);
    expect(report.sources.find((s) => s.logicalPath === "AGENTS.md")!.activation).toBe("inactive");
    expect(buildPosterModel(report, { agent: "codex" }).totals).toMatchObject({ sources: 3, tokens: codexAlways, listed: 2 });
    const cursor = buildPosterModel(report, { agent: "cursor" });
    const a = report.sources.find((s) => s.logicalPath === ".cursor/rules/a.mdc")!.estTokens;
    const rules = report.sources.find((s) => s.logicalPath === ".cursorrules")!.estTokens;
    expect(cursor.totals).toMatchObject({ sources: 2, tokens: a + rules, listed: 3, inventorySources: 5 });
    expect(cursor.rows.at(-1)).toMatchObject({ kind: "not-counted", label: "Also found, not counted: 3", meta: "3 conditional · not in the total" });
    const m = buildPosterModel(buildReport([raw("CLAUDE.md", 5), raw(".github/copilot-instructions.md", 9), raw(".windsurfrules", 11)]), { agent: "windsurf" });
    expect(m.totals).toMatchObject({ sources: 1, tokens: 11, listed: 0 });
    expect(texts(renderPosterSvg(m)).some((t) => t.includes("listed, not counted"))).toBe(false);
    const copilot = buildPosterModel(buildReport([raw(".github/copilot-instructions.md", 9)]), { agent: "copilot" });
    expect(copilot.totals).toMatchObject({ sources: 1, tokens: 9 });
  });

  it("collapses everything not counted into one muted row after the counted rows: no bar, share '—', summed tokens", () => {
    const report = demo();
    const model = buildPosterModel(report);
    expect(model.mode).toBe("flat");
    const last = model.rows.at(-1)!;
    expect(model.rows.filter((r) => r.kind === "not-counted")).toHaveLength(1);
    expect(model.rows.filter((r) => !r.counted)).toEqual([last]);
    expect(last).toMatchObject({ kind: "not-counted", label: "Also found, not counted: 3", meta: "1 nested · 2 config (settings, MCP) · not in the total", share: "—", counted: false, flags: [] });
    const uncounted = report.sources.filter((s) => s.agent === "claude-code" && s.activation !== "always").reduce((s, x) => s + x.estTokens, 0);
    expect(last.tokens).toBe(uncounted);
    // Individual not-counted sources have no row of their own and counted rows carry no "not counted" marker.
    for (const r of model.rows.slice(0, -1)) {
      expect(r.counted).toBe(true);
      expect(r.share).toMatch(/^(<1|\d+)%$/);
      expect(r.meta).not.toMatch(/ · (nested|conditional|config)/);
    }
    expect(model.rows.map((r) => r.meta)).not.toContain("apps/web/CLAUDE.md · nested");
    const svg = renderPosterSvg(model);
    const all = texts(svg);
    expect(all).toContain("Also found, not counted: 3");
    expect(all).toContain(`~${uncounted}`);
    expect(all.filter((t) => t === "—")).toHaveLength(1);
    // One solid bar per counted row, no hollow bars, and no track on the not-counted row.
    expect(svg.match(new RegExp(`height="${poster.barH}" rx="3" fill="${light.bar}"`, "g"))).toHaveLength(model.rows.length - 1);
    expect(svg).not.toContain(`fill="none" stroke="${light.bar}"`);
    expect(svg.match(new RegExp(`height="${poster.barH}" rx="3" fill="${light.track}"`, "g"))).toHaveLength(model.rows.length - 1);
    // The number inside the label is mono; the sentence is Inter.
    expect(svg).toContain(`Also found, not counted: <tspan font-family="JetBrains Mono NL" font-weight="500">3</tspan>`);
    // Conditional rule rows are counted in the not-counted row too.
    const cond = buildPosterModel(buildReport([withFm(".claude/rules/api.md", 'paths:\n  - "src/**"', 20), raw("CLAUDE.md", 10)]));
    expect(cond.rows.at(-1)).toMatchObject({ label: "Also found, not counted: 1", meta: "1 conditional · not in the total" });
    expect(cond.totals).toMatchObject({ sources: 1, listed: 1 });
  });

  it("says 'not memory' (not 'nested') in the not-counted row for a CLAUDE.md under .claude/skills", () => {
    const m = buildPosterModel(buildReport([raw("CLAUDE.md", 5), raw(".claude/skills/x/CLAUDE.md", 5, "nested"), raw("apps/web/CLAUDE.md", 5, "nested")]));
    expect(m.rows.at(-1)).toMatchObject({ label: "Also found, not counted: 2", meta: "1 nested · 1 not memory · not in the total" });
  });

  it("shows the not-counted row alone when every source is excluded, and it takes one of the 10 slots", () => {
    const none = buildPosterModel(buildReport([settings(), mcp(), raw("apps/a/CLAUDE.md", 5, "nested")]));
    expect(none.totals).toMatchObject({ sources: 0, tokens: 0, listed: 3 });
    expect(none.rows).toHaveLength(1);
    expect(none.rows[0]).toMatchObject({ kind: "not-counted", share: "—", counted: false });
    expect(texts(renderPosterSvg(none))).toContain("from 0 always-loaded sources, before you type anything");
    // Flat mode: 8 counted rows, the +N more row and the not-counted row make 10.
    const flat = buildPosterModel(buildReport([
      ...Array.from({ length: 9 }, (_, i) => raw(`.claude/rules/p${i}.md`, 100 - i)), raw("apps/x/CLAUDE.md", 3, "nested"), raw("CLAUDE.local.md", 1), settings(),
    ]));
    expect(flat.rows).toHaveLength(10);
    expect(flat.rows.at(-1)).toMatchObject({ kind: "not-counted", label: "Also found, not counted: 2" });
    const more = flat.rows.at(-2)!;
    expect(more).toMatchObject({ kind: "more", counted: true, label: "+ 2 more sources" });
    expect(more.meta).not.toContain("not counted");
    // Grouped mode: group rows are counted only, the not-counted row follows, and the table stays at 10 rows.
    const grouped = buildPosterModel(buildReport([...groupedRaw(30), settings(), mcp()]));
    expect(grouped.mode).toBe("grouped");
    expect(grouped.rows.find((r) => r.label === "Settings & MCP")).toBeUndefined();
    expect(grouped.rows.length).toBeLessThanOrEqual(10);
    expect(grouped.rows.at(-1)!.kind).toBe("not-counted");
    expect(grouped.rows.filter((r) => r.kind !== "not-counted").every((r) => r.counted)).toBe(true);
    expect(grouped.rows.find((r) => r.label === "Instructions")!.counted).toBe(true);
  });

  it("centres the findings card between the table and the footer rule, in every card state and table length", () => {
    const FOOTER = 1812, CARD_H = 448;
    const cardTop = (m: PosterModel) => {
      const rect = m.items.find((it) => it.type === "shape" && it.zone === "card" && it.svg.includes(`height="${CARD_H - 2}"`) && it.svg.includes(`rx="${poster.radius}"`));
      return Number(/ y="([\d.]+)"/.exec(rect && rect.type === "shape" ? rect.svg : "")?.[1]) - 1;
    };
    const long = "Always write a detailed explanation of every single change you make, including the reasoning behind it, the alternatives you considered and why you rejected each of them. ".repeat(2);
    const longest: PosterFindings = {
      conflicts: [{ a: { text: long, ref: { path: "CLAUDE.md", line: 13 } }, b: { text: long, ref: { path: "AGENTS.md", line: 6 } }, confidence: "high", note: "Both load at repo root." }],
      duplicates: findings().duplicates,
    };
    const full = buildReport([...groupedRaw(30), settings()]);
    const cases: [string, PosterModel][] = [
      ["findings", buildPosterModel(demo(), { findings: findings() })],
      ["findings off", buildPosterModel(demo())],
      ["none found", buildPosterModel(demo(), { findings: { conflicts: [], duplicates: [] } })],
      ["longest card", buildPosterModel(demo(), { findings: longest })],
      ["10 rows", buildPosterModel(full, { findings: findings() })],
      ["10 rows, longest card", buildPosterModel(full, { findings: longest })],
      ["no sources", buildPosterModel(buildReport([]), { findings: findings() })],
    ];
    for (const [name, m] of cases) {
      const tableEnd = 560 + Math.max(1, m.rows.length) * poster.rowHeight;
      const top = cardTop(m);
      expect(top - tableEnd, name).toBe(FOOTER - (top + CARD_H)); // the gap above the card equals the gap above the footer
      expect(top - tableEnd, name).toBeGreaterThanOrEqual(22);
      expect(top + CARD_H, name).toBeLessThanOrEqual(poster.cropBottom);
    }
    expect(cases[0]![1].rows).toHaveLength(4); // 3 counted rows + 1 not-counted row
    expect(cardTop(cases[0]![1])).toBe((560 + 4 * poster.rowHeight + FOOTER - CARD_H) / 2);
    expect(cases[4]![1].rows).toHaveLength(10);
    expect(cardTop(cases[4]![1])).toBe(1342);
  });

  it("is per agent profile and never sums across agents", () => {
    const report = demo();
    const codex = report.sources.filter((s) => s.agent === "codex");
    const svg = renderPosterSvg(report, { agent: "codex" });
    const all = texts(svg);
    expect(all).toContain(`~${codex.filter((s) => s.activation === "always").reduce((s, x) => s + x.estTokens, 0)}`);
    expect(all).toContain("WHAT CODEX IS TOLD EVERY TURN · REPO ROOT");
    expect(all).not.toContain("CLAUDE.md");
    expect(all).not.toContain("CLAUDE.local.md");
    expect(all).not.toContain("Cursor rule");
    expect(all).toContain("AGENTS.md");
    expect(all.some((t) => t.includes("Codex profile · 2 sources"))).toBe(true);
    const total = report.totals.estTokens;
    expect(texts(renderPosterSvg(report))).not.toContain(`~${total}`);
  });

  it("handles a profile with no sources", () => {
    const svg = renderPosterSvg(demo(), { agent: "windsurf" });
    expect(texts(svg)).toContain("No Windsurf sources found.");
    expect(texts(svg)).toContain("~0");
  });

  it("sorts bars from zero: the largest fills the track and tiny ones keep a 4px sliver", () => {
    const svg = renderPosterSvg(buildReport([raw("CLAUDE.md", 1000), raw(".claude/rules/a.md", 1)]));
    expect(svg).toContain(`width="${poster.barW}" height="${poster.barH}" rx="3" fill="${light.bar}"`);
    expect(svg).toContain(`width="${poster.barMin}" height="${poster.barH}" rx="3" fill="${light.bar}"`);
    expect(buildPosterModel(buildReport([raw("apps/a/CLAUDE.md", 1, "nested"), raw("CLAUDE.md", 1000)])).rows.map((r) => r.meta)).toEqual(["CLAUDE.md", "1 nested · not in the total"]);
  });

  it("shows at most 10 rows with a +N more row, kind breakdown and segmented bar", () => {
    const report = buildReport([
      ...Array.from({ length: 9 }, (_, i) => raw(`.claude/rules/p${i}.md`, 100 - i)),
      raw(".claude/rules/a.md", 20), raw(".claude/rules/b.md", 15), skill("one"), raw("CLAUDE.local.md", 10),
    ]);
    const model = buildPosterModel(report);
    expect(model.mode).toBe("flat");
    expect(model.rows).toHaveLength(10);
    const more = model.rows[9]!;
    expect(more.kind).toBe("more");
    expect(more.label).toBe("+ 4 more sources");
    expect(more.meta).toMatch(/^1 instruction, 1 skill, 2 rules · each under \d+%$/);
    const claudeSorted = report.sources.filter((s) => s.agent === "claude-code").sort((a, b) => b.estTokens - a.estTokens);
    expect(more.tokens).toBe(claudeSorted.slice(9).reduce((s, x) => s + x.estTokens, 0));
    expect(renderPosterSvg(model).match(new RegExp(`fill="${light.muted}"/>`, "g"))!.length).toBeGreaterThanOrEqual(4);
  });

  it("switches to kind-grouped mode for more than 24 counted sources", () => {
    const model = buildPosterModel(buildReport(groupedRaw(30)));
    expect(model.mode).toBe("grouped");
    expect(model.rows.length).toBeLessThanOrEqual(10);
    const heads = model.rows.filter((r) => r.kind === "group").map((r) => r.label);
    expect(heads).toEqual(expect.arrayContaining(["Instructions", "Rules", "Skills"]));
    expect(model.rows[0]!.kind).toBe("group");
    expect(texts(renderPosterSvg(model))).toContain("Instructions");
    expect(model.rows.find((r) => r.label === "Rules")!.meta).toMatch(/more not shown/);
    // Nested sources are not counted, so thirty of them do not trigger grouping.
    expect(buildPosterModel(many(30)).mode).toBe("flat");
  });

  it("switches to kind-grouped mode when +N more would hold over 35% of tokens", () => {
    const report = buildReport(Array.from({ length: 16 }, (_, i) => raw(`.claude/rules/p${i}.md`, 100)));
    expect(buildPosterModel(report).mode).toBe("grouped");
    const skewed = buildReport([raw("CLAUDE.md", 900), ...Array.from({ length: 11 }, (_, i) => raw(`.claude/rules/p${i}.md`, 5))]);
    expect(buildPosterModel(skewed).mode).toBe("flat");
  });

  it("middle-truncates paths with the mono advance and keeps the scope suffix", () => {
    expect(middleTruncate(".claude/skills/very-long-skill-name-here/SKILL.md", 34)).toBe(".claude/skills/…/SKILL.md");
    expect(middleTruncate("short.md", 34)).toBe("short.md");
    expect(middleTruncate("a/" + "x".repeat(60) + ".md", 20).length).toBeLessThanOrEqual(20);
    const long = "packages/" + "deeply/".repeat(8) + "nested/AGENTS.md";
    const all = texts(renderPosterSvg(buildReport([raw(long, 10, "user")]), { agent: "codex" }));
    const shown = all.find((t) => t.endsWith("AGENTS.md · user"))!;
    expect(shown).toContain("…/");
    expect(shown.length).toBeLessThanOrEqual(Math.floor((poster.barX - 16 - poster.margin) / (poster.path * poster.monoAdvance)));
  });

  it("truncates long labels with an ellipsis", () => {
    const svg = renderPosterSvg(buildReport([skill("a-very-long-skill-name-".repeat(5))]));
    expect(texts(svg).some((t) => t.startsWith("Skill: a-very") && t.endsWith("…"))).toBe(true);
  });

  it.each([16 * 1024, 256 * 1024])("renders a poster with a %i-byte skill name in under 500 ms (linear truncation)", (size) => {
    const shapes = [
      "a-very-long-skill-name-".repeat(Math.ceil(size / 23)).slice(0, size),
      "x".repeat(size),
      "word ".repeat(Math.ceil(size / 5)).slice(0, size),
      "Wide Mm@".repeat(Math.ceil(size / 8)).slice(0, size),
    ];
    for (const name of shapes) {
      const started = performance.now();
      const report = buildReport([{ logicalPath: ".claude/skills/long/SKILL.md", text: `---\nname: ${name}\ndescription: d\n---\nbody`, scope: "project" }, raw("CLAUDE.md", 5)]);
      const svg = renderPosterSvg(report);
      const elapsed = performance.now() - started;
      expect(elapsed, `name shape ${name.slice(0, 8)}`).toBeLessThan(500);
      const label = texts(svg).find((t) => t.startsWith("Skill: "))!;
      expect(label.endsWith("…")).toBe(true);
      expect(label.length).toBeLessThan(80);
    }
  });

  it("truncates labels and paths to the same widths as before and keeps long paths' file names", () => {
    const hugePath = "packages/" + "deeply/".repeat(2000) + "nested/AGENTS.md";
    const model = buildPosterModel(buildReport([raw(hugePath, 10, "user")]), { agent: "codex" });
    const meta = model.rows[0]!.meta;
    expect(meta.endsWith("AGENTS.md · user")).toBe(true);
    expect(meta.length).toBeLessThanOrEqual(Math.floor((poster.barX - 16 - poster.margin) / (poster.path * poster.monoAdvance)));
    // Text items are cut at a code point, never inside a surrogate pair.
    const emoji = "😀".repeat(4000);
    const svg = renderPosterSvg(buildReport([skill(emoji)]));
    expect(svg).not.toContain("�");
    expect(texts(svg).some((t) => t.startsWith("Skill: 😀") && t.endsWith("…"))).toBe(true);
    // A 20-character name is untouched; a name just over the track gets one ellipsis.
    expect(texts(renderPosterSvg(buildReport([skill("short-skill")])))).toContain("Skill: short-skill");
  });

  it("is deterministic across runs and input order", () => {
    const rawSources = [raw("CLAUDE.md", 50), raw("apps/a/CLAUDE.md", 50, "nested"), raw("CLAUDE.local.md", 7), skill("zeta"), skill("alpha")];
    const a = renderPosterSvg(buildReport(rawSources), { version: "1.2.3" });
    expect(renderPosterSvg(buildReport(rawSources), { version: "1.2.3" })).toBe(a);
    expect(renderPosterSvg(buildReport([...rawSources].reverse()), { version: "1.2.3" })).toBe(a);
    expect(JSON.stringify(buildPosterModel(buildReport([...manyRaw(30)].reverse())))).toBe(JSON.stringify(buildPosterModel(many(30))));
    expect(a).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  it("escapes XML and drops characters XML cannot carry", () => {
    const name = `a<b&"c'>d`;
    const report = buildReport([skill(name), raw(`dir\u0001x/CLAUDE.md`, 5, "nested")]);
    const svg = renderPosterSvg(report);
    expect(svg).not.toContain("<b&");
    expect(svg).not.toContain('"c\'>d');
    expect(svg).toContain("&#60;b&#38;&#34;c&#39;&#62;d");
    expect(svg).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    const f = findings();
    f.conflicts[0]!.note = "<script>alert(1)</script>";
    expect(renderPosterSvg(report, { findings: f })).not.toContain("<script");
  });

  it("redacts canaries from sources and findings", () => {
    const email = j("private", "@", "company.test");
    const ghCanary = j("gh", "p_abcdefghijklmnopqrstuv12");
    const home = j("/ho", "me/fakeuser/proj");
    const report = buildReport([skill(`mail ${email}`, `token ${ghCanary}`), raw("CLAUDE.md", 5)]);
    const f = findings();
    f.conflicts[0]!.a.text = `use ${ghCanary} from ${home}`;
    f.conflicts[0]!.b.ref.path = `${home}/AGENTS.md`;
    f.conflicts[0]!.note = `see ${email}`;
    f.duplicates[0]!.text = `contact ${email}`;
    const svg = renderPosterSvg(report, { findings: f });
    for (const c of [email, ghCanary, home, "fakeuser"]) expect(svg).not.toContain(c);
    expect(svg).toContain("[email]");
  });

  it("redacts a secret placed in a skill name: no secret in the poster SVG, JSON or label", () => {
    const value = j("fakeSmall9", "xyz1");
    const names = [j("deploy API ke", "y: ", value), j("deploy sec", "ret key = ", value), j("run --db-pass", "word ", value), j("sshpass -", "p ", value, " ssh host"), j("export DB_PA", "SS=", value)];
    for (const name of names) {
      const listing: RawSource = { logicalPath: ".claude/skills/leaky/SKILL.md", text: `---\nname: ${name}\ndescription: d\n---\nbody`, scope: "project" };
      const report = buildReport([listing, raw("CLAUDE.md", 5)]);
      const svg = renderPosterSvg(report);
      expect(svg).not.toContain(value);
      expect(JSON.stringify(report)).not.toContain(value);
      expect(texts(svg).some((t) => t.startsWith("Skill: ") && t.includes("[secret]"))).toBe(true);
    }
  });

  it("renders the not-checked-yet card with no badges or flags when findings are undefined", () => {
    const model = buildPosterModel(demo());
    expect(model.card).toBe("unchecked");
    const all = texts(renderPosterSvg(model));
    expect(all).toContain("CONFLICTS & DUPLICATES");
    expect(all).toContain("Not checked in this run (findings off).");
    expect(all.join("\n")).not.toMatch(/POSSIBLE CONFLICT|DUPLICATE ×|FLAGS/);
    expect(model.rows.every((r) => r.flags.length === 0)).toBe(true);
    expect(renderPosterSvg(model)).not.toContain(light.conflict);
    expect(renderPosterSvg(model)).not.toContain(light.duplicate);
  });

  it("renders the findings line, ink flags and the findings card when findings are provided", () => {
    const model = buildPosterModel(demo(), { findings: findings() });
    expect(model.card).toBe("checked");
    const all = texts(renderPosterSvg(model));
    // Header: one ink mono line, then the muted subline. No badges in the header.
    expect(all).toContain("1 possible conflict · 1 duplicate"); // the low-confidence conflict is excluded
    expect(all).toContain("from 3 always-loaded sources, before you type anything");
    expect(all).not.toContain("1 POSSIBLE CONFLICT");
    expect(all).not.toContain("1 DUPLICATE");
    expect(all.filter((t) => t === "POSSIBLE CONFLICT")).toHaveLength(1); // the card badge only
    const line = model.items.find((it) => it.type === "text" && it.text === "1 possible conflict · 1 duplicate");
    expect(line).toMatchObject({ zone: "hero", mono: true, weight: 400, size: poster.findingsLine, fill: light.ink, y: 456 });
    const sub = model.items.find((it) => it.type === "text" && it.text.startsWith("from 3 always-loaded"));
    expect(sub).toMatchObject({ zone: "hero", mono: false, size: poster.subline, fill: light.muted });
    expect((sub as { y: number }).y).toBeGreaterThan((line as { y: number }).y + poster.findingsLine); // the second line sits below the first, no overlap
    // Colour: vermilion only in the card, blue only in the duplicate strip; the header and rows carry none.
    for (const it of model.items) {
      if (it.type !== "shape" || it.zone === "card") continue;
      expect(it.svg, it.zone).not.toContain(light.conflict);
      expect(it.svg, it.zone).not.toContain(light.duplicate);
    }
    for (const it of model.items) if (it.type === "text" && it.zone !== "card") { expect(it.fill).not.toBe(light.conflict); expect(it.fill).not.toBe(light.duplicate); }
    // Row icons: triangle filled ink with a paper "!", copy icon in ink outline.
    const icons = model.items.filter((it) => it.type === "shape" && it.zone === "list" && /<path d="M/.test(it.svg));
    expect(icons.length).toBeGreaterThan(0);
    for (const it of icons) expect((it as { svg: string }).svg).toContain(`fill="${light.ink}"`);
    expect(model.items.some((it) => it.type === "shape" && it.zone === "list" && it.svg.includes(`fill="none" stroke="${light.ink}"`))).toBe(true);
    expect(all).toContain("POSSIBLE CONFLICT");
    expect(all).toContain("DUPLICATE ×3");
    expect(all).toContain("medium confidence · heuristic");
    expect(all).toContain("CLAUDE.md:13");
    expect(all).toContain("AGENTS.md:6");
    expect(all).toContain(".cursor/rules/general.mdc:5");
    expect(all).toContain("Both load at repo root. No clear precedence; which one wins is unknown.");
    expect(all).toContain("FLAGS");
    expect(all.some((t) => t.startsWith("“Don't add comments"))).toBe(true);
    const claudeRow = model.rows.find((r) => r.label === "CLAUDE.md" && r.meta === "CLAUDE.md")!;
    expect(claudeRow.flags).toEqual(["conflict", "duplicate"]);
    expect(renderPosterSvg(model)).toContain(light.conflict);
    expect(renderPosterSvg(model)).toContain(`stroke-dasharray="${poster.dupDash}"`);
    expect(all).not.toContain("not checked");
  });

  it("supports near-duplicates, setting conflicts, duplicate-only and empty findings", () => {
    const f = findings();
    f.conflicts = [{ ...f.conflicts[0]!, setting: true }];
    f.duplicates = [{ text: "same", similarity: 0.91, refs: [{ path: "CLAUDE.md", line: 1 }, { path: "AGENTS.md", line: 2 }] }];
    const all = texts(renderPosterSvg(demo(), { findings: f }));
    expect(all).toContain("SETTING CONFLICT");
    expect(all).toContain("NEAR-DUPLICATE ≈0.91");
    const dupOnly = texts(renderPosterSvg(demo(), { findings: { conflicts: [], duplicates: f.duplicates } }));
    expect(dupOnly).toContain("No possible conflicts found by the heuristics.");
    expect(dupOnly).toContain("1 duplicate");
    expect(all).toContain("1 possible conflict · 1 duplicate");
    const none = texts(renderPosterSvg(demo(), { findings: { conflicts: [], duplicates: [] } }));
    expect(none).toContain("No possible conflicts or duplicates found by the heuristics.");
    expect(none).toContain("No conflicts or duplicates found");
  });

  it("pluralises the findings line and drops the override line from the header", () => {
    const f = findings();
    const many3 = { ...f.conflicts[0]!, confidence: "high" as const };
    const line = (fs: PosterFindings) => texts(renderPosterSvg(demo(), { findings: fs })).find((t) => /possible conflict|duplicate|no conflicts/.test(t) && !/^“|heuristics|DUPLICATE|POSSIBLE/.test(t));
    expect(line({ conflicts: [many3, many3, many3, many3], duplicates: [f.duplicates[0]!] })).toBe("4 possible conflicts · 1 duplicate");
    expect(line({ conflicts: [many3], duplicates: [f.duplicates[0]!, f.duplicates[0]!] })).toBe("1 possible conflict · 2 duplicates");
    expect(line({ conflicts: [many3], duplicates: [] })).toBe("1 possible conflict");
    expect(line({ conflicts: [], duplicates: [f.duplicates[0]!] })).toBe("1 duplicate");
    const withOverride = texts(renderPosterSvg(demo(), { findings: { conflicts: [many3], duplicates: [], overrides: [{ ...many3, override: true }] } }));
    expect(withOverride.some((t) => t.includes("likely intentional override"))).toBe(false);
  });

  it("keeps hero, list and card text inside the 1:1 crop (y 200-1800)", () => {
    const longQuote = "word ".repeat(80);
    const heavy = findings();
    heavy.conflicts[0]!.a.text = longQuote;
    heavy.conflicts[0]!.b.text = longQuote;
    heavy.duplicates[0]!.text = longQuote;
    const models = [
      buildPosterModel(demo()), buildPosterModel(demo(), { findings: findings() }), buildPosterModel(demo(), { findings: heavy }),
      buildPosterModel(many(30)), buildPosterModel(many(30), { findings: heavy }), buildPosterModel(demo(), { agent: "windsurf" }),
      buildPosterModel(demo(), { findings: { conflicts: [], duplicates: heavy.duplicates } }),
      buildPosterModel(buildReport(Array.from({ length: 10 }, (_, i) => raw(`apps/p${i}/CLAUDE.md`, 40 - i, "nested"))), { findings: heavy }),
    ];
    for (const m of models) expect(outsideCrop(m)).toEqual([]);
    // Three-line quotes are capped with an ellipsis, and the ref is always kept.
    const texts3 = texts(renderPosterSvg(demo(), { findings: heavy }));
    expect(texts3.filter((t) => t.endsWith("…”") || t.endsWith("…")).length).toBeGreaterThan(0);
    expect(texts3).toContain("CLAUDE.md:13");
  });

  it("flags in the highlighted finding replace the smallest unflagged row instead of hiding in +N more", () => {
    const report = buildReport([
      ...Array.from({ length: 11 }, (_, i) => raw(`.claude/rules/p${i}.md`, 100 - i)),
      raw("CLAUDE.md", 2),
    ]);
    const f = findings();
    f.conflicts[0]!.a.ref.path = "CLAUDE.md";
    f.duplicates = [];
    const model = buildPosterModel(report, { findings: f });
    const row = model.rows.find((r) => r.meta === "CLAUDE.md");
    expect(row?.flags).toEqual(["conflict"]);
    expect(model.rows).toHaveLength(10);
  });
});

describe("poster html", () => {
  it("wraps an svg under a restrictive CSP with no scripts or remote URLs", () => {
    const svg = renderPosterSvg(demo());
    const html = renderPosterHtml(svg, { title: "T <x>" });
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"`);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    expect(html).toContain("T &#60;x&#62;");
  });

  it("redacts custom titles in the poster html and the sources table", () => {
    const email = j("private", "@", "company.test");
    const ghCanary = j("gh", "p_abcdefghijklmnopqrstuv12");
    const deny = compileDenylist(["zebracorp"]);
    const svg = renderPosterSvg(demo());
    const page = renderPosterHtml(svg, { title: `Report for ${email} ${ghCanary} zebracorp`, alt: `alt ${ghCanary} zebracorp`, denylist: deny });
    const table = renderSourcesTableHtml(demo(), `Sources ${email} ${ghCanary} zebracorp`, { denylist: deny });
    for (const html of [page, table]) {
      for (const c of [email, ghCanary, "zebracorp"]) expect(html).not.toContain(c);
      expect(html).toContain("[email]");
    }
    expect(table).toContain('<span class="rd" role="img" aria-label="redacted">[redacted]</span>');
    expect(renderPosterHtml(svg, { title: `T ${email}` })).not.toContain(email);
  });
});
