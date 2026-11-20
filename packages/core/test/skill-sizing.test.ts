import { describe, expect, it } from "vitest";
import { buildPosterModel, buildReport, renderPosterSvg } from "../src/index";

// A skill counts only its frontmatter listing (name + description), never the SKILL.md body,
// for every agent profile that loads skill listings (Claude Code, Codex via .codex/ and .agents/).
const head = "---\nname: release-notes\ndescription: Draft release notes from merged PRs.\n---\n";
const shortBody = "# Release notes\nShort body.\n";
const longBody = "# Release notes\n" + "- Never add comments to code.\n- Always add comments to code.\n".repeat(2000);

const cases: Array<[string, string, "claude-code" | "codex"]> = [
  ["claude", ".claude/skills/release-notes/SKILL.md", "claude-code"],
  ["codex", ".codex/skills/release-notes/SKILL.md", "codex"],
  ["agents", ".agents/skills/release-notes/SKILL.md", "codex"],
];

describe("skill rows count the listing only", () => {
  for (const [name, path, agent] of cases) {
    it(`${name}: a long SKILL.md body does not change the skill's size, hero or findings`, () => {
      const small = buildReport([{ logicalPath: path, text: head + shortBody, scope: "project" }]);
      const big = buildReport([{ logicalPath: path, text: head + longBody, scope: "project" }]);
      const a = small.sources[0]!, b = big.sources[0]!;
      expect(b.kind).toBe("skill-listing");
      expect(b.agent).toBe(agent);
      expect(b.represented).toBe("- release-notes: Draft release notes from merged PRs.");
      expect([b.bytes, b.chars, b.estTokens]).toEqual([a.bytes, a.chars, a.estTokens]);
      // Exact listing size: "- release-notes: Draft release notes from merged PRs." = 53 UTF-8 bytes = 14 tokens (bytes / 4, rounded up).
      expect([b.bytes, b.chars, b.estTokens]).toEqual([53, 53, 14]);
      expect(b.rawBytes).toBeGreaterThan(100_000); // raw size is kept for reference only
      expect(big.totals.estTokens).toBe(14);
      // Body rules are never analysed: build the report WITH an instruction file so detection really runs on this input.
      const withMemory = buildReport([{ logicalPath: path, text: head + longBody, scope: "project" }, { logicalPath: "CLAUDE.md", text: "- Be brief.\n", scope: "project" }]);
      expect(withMemory.findings).toEqual([]);
      expect(withMemory.findingCounts.headline).toEqual({ conflicts: 0, duplicates: 0, overrides: 0 });
      // Poster: the hero counts the listing (its subline says 1 always-loaded source) and equals the sum of the always-loaded rows.
      const modelBig = buildPosterModel(big, { agent });
      expect(modelBig.totals).toMatchObject({ sources: 1, tokens: 14 });
      const counted = modelBig.rows.filter((r) => r.counted);
      expect(modelBig.totals.tokens).toBe(counted.reduce((n, r) => n + r.tokens, 0));
      expect(counted.map((r) => r.tokens)).toEqual([14]);
      const svgSmall = renderPosterSvg(buildPosterModel(small, { agent }));
      const svgBig = renderPosterSvg(modelBig);
      expect(svgBig).toBe(svgSmall);
      expect(svgBig).toContain("from 1 always-loaded source");
      // Mutation guard: a hero that dropped skill listings would show 0 here.
      expect(modelBig.totals.tokens).toBeGreaterThan(0);
    });
  }
});
