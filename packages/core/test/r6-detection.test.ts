import { describe, expect, it } from "vitest";
import { buildReport, isCounted, type RawSource } from "../src/index";

const src = (logicalPath: string, text: string): RawSource => ({ logicalPath, text, scope: "project" });
/** Findings of one file. */
const one = (text: string) => buildReport([src("CLAUDE.md", text)], { dataset: "sample" }).findings;
/** Findings for two memory files that load together. */
const pair = (a: string, b: string) => buildReport([src("CLAUDE.md", a), src("CLAUDE.local.md", b)], { dataset: "sample" }).findings;
const counted = (findings: ReturnType<typeof one>) => findings.filter((f) => f.kind === "conflict" && f.confidence !== "low" && isCounted(f));

describe("a descriptive per-package inventory is not a directive", () => {
  it("synthetic stand-in for the real-file false positive: 'Most packages: vitest' and '`pkg`: jest' give no medium conflict", () => {
    const text = "## Testing\n\n- Most packages: **vitest** with the shared config in `tooling/`.\n- `date-helpers`: **jest** (migration is tracked separately).\n- `ui-kit`: **mocha** for the legacy browser suite.\n";
    expect(one(text).filter((f) => f.kind === "conflict")).toEqual([]);
  });
  it.each([
    ["- Most packages: **vitest** for unit tests.\n", "- `date-helpers`: **jest** for unit tests.\n"],
    ["- Other packages: **jest**.\n", "- Most packages: **vitest**.\n"],
    ["- Some libraries: **mocha** (legacy).\n", "- `core`: **vitest**.\n"],
    ["- `packages/legacy/`: **jest**.\n", "- All other packages: **vitest**.\n"],
    ["- `@acme/utils`: **jest**\n", "- `@acme/ui`: **vitest**\n"],
  ])("%s vs %s", (a, b) => {
    expect(pair(a, b).filter((f) => f.kind === "conflict")).toEqual([]);
  });
  it("an instruction after the label is still a directive, and terse non-inventory labels are unchanged", () => {
    for (const [a, b] of [
      ["- Use **vitest** for tests.\n", "- Use **jest** for tests.\n"],
      ["- Tests: **vitest**.\n", "- Tests: **jest**.\n"],
      ["- Most packages: use **vitest** for tests.\n", "- Always use **jest** for tests.\n"],
      ["- `date-helpers`: always use **jest**.\n", "- Never use **jest**.\n"],
      ["- `src/`: only **vitest** tests.\n", "- Use **jest** for tests.\n"],
    ] as const) {
      expect(pair(a, b).some((f) => f.kind === "conflict" && f.confidence !== "low"), `${a} / ${b}`).toBe(true);
    }
  });
  it("the guard is the `label:` shape (documented limit): the same words joined by a dash are still read as directives", () => {
    const f = one("- Most packages - **vitest** with config.\n- `date-helpers` - **jest** (migration).\n");
    expect(f.some((x) => x.kind === "conflict" && x.rule === "curated:test-framework" && x.confidence === "medium")).toBe(true);
  });
  it("inventory lines are still seen by the duplicate detector (they are text, only not directives)", () => {
    const f = buildReport([src("CLAUDE.md", "- `date-helpers`: **jest** for unit tests.\n"), src("AGENTS.md", "- `date-helpers`: **jest** for unit tests.\n")], { dataset: "sample" }).findings;
    expect(f.some((x) => x.kind === "duplicate")).toBe(true);
  });
});

describe("'no longer need to' reports a dropped requirement, it is not a directive", () => {
  it.each([
    ["We no longer need to run lint.", "Run lint."],
    ["You no longer have to add comments.", "Add comments."],
    ["Running the formatter is no longer required.", "Run the formatter."],
  ])("%s vs %s is not counted", (a, b) => {
    expect(counted(pair(`- ${a}\n`, `- ${b}\n`))).toEqual([]);
  });
  it("'no longer use X' stays a counted directive", () => {
    expect(counted(pair("- No longer use default exports.\n", "- Use default exports.\n")).length).toBeGreaterThan(0);
  });
});
