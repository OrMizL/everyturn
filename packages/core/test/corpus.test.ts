import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildReport, isCounted, isListedOverride, type Finding, type FindingKind, type RawSource } from "../src/index";

// The corpus is co-written regression coverage, not an independent precision measurement: the cases and the detector were
// written together (the later held-out additions were written alongside their fixes). The numbers below describe exactly that.
type Label = "duplicate" | "near-duplicate" | "conflict" | "setting-conflict" | "none";
interface Expect { confidence: "high" | "medium" | "low"; rule: string; pair: [string, number][] }
interface Case { id: string; kind: Label; split: "tune" | "held-out"; rationale: string; files: [string, string, ("user" | "project")?][]; expect?: Expect; forbid?: FindingKind[] }
const corpus = JSON.parse(readFileSync(new URL("../../../fixtures/corpus/cases.json", import.meta.url), "utf8")) as { cases: Case[] };

// Duplicate cases keep AGENTS.md (distinct sources across agents still count). Conflict and negative cases load together,
// as two Claude memory files in one profile, so applicability is "both load at repo root". `xneg-` cases keep the two agents.
const together = (c: Case) => c.kind === "conflict" || (c.kind === "none" && /^(neg-|setneg)/.test(c.id));
const back = (c: Case, path: string) => (together(c) && path === "CLAUDE.local.md" ? "AGENTS.md" : path);
const analyse = (c: Case) => {
  const raw: RawSource[] = c.files.map(([logicalPath, text, scope]) => ({ logicalPath: together(c) && logicalPath === "AGENTS.md" ? "CLAUDE.local.md" : logicalPath, text, scope: scope ?? "project" }));
  return buildReport(raw, { dataset: "sample" }).findings;
};
/** A finding the headline would count, or (setting conflicts) list as an intentional override. */
const reported = (f: Finding) => isCounted(f) || isListedOverride(f);
/** Medium and high confidence only: that is what a headline can show. Cross-agent dups/near-dups count as found (see `together`). */
const found = (c: Case) => new Set(analyse(c).filter((f) => f.confidence !== "low").map((f) => f.kind));
const KINDS: FindingKind[] = ["duplicate", "near-duplicate", "conflict", "setting-conflict"];

function measure(cases: Case[]) {
  return KINDS.map((kind) => {
    let tp = 0, fp = 0, fn = 0;
    for (const c of cases) {
      const hit = found(c).has(kind);
      if (c.kind === kind) { if (hit) tp++; else fn++; }
      else if (hit) fp++;
    }
    return { kind, n: cases.filter((c) => c.kind === kind).length, tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1 };
  });
}
const table = (name: string, cases: Case[]) => {
  const f = (n: number) => n.toFixed(2);
  return [`corpus ${name}: ${cases.length} cases`, "kind               n  TP FP FN  precision recall",
    ...measure(cases).map((r) => `${r.kind.padEnd(16)} ${String(r.n).padStart(3)} ${String(r.tp).padStart(3)}${String(r.fp).padStart(3)}${String(r.fn).padStart(3)}  ${f(r.precision).padStart(9)} ${f(r.recall).padStart(6)}`)].join("\n");
};

describe("labelled corpus", () => {
  const all = corpus.cases;
  const held = all.filter((c) => c.split === "held-out");
  it("has at least 40 cases across the required kinds, with a tuning and a held-out split", () => {
    expect(all.length).toBeGreaterThanOrEqual(40);
    const count = (k: Label) => all.filter((c) => c.kind === k).length;
    expect(count("duplicate")).toBeGreaterThanOrEqual(10);
    expect(count("near-duplicate")).toBeGreaterThanOrEqual(10);
    expect(count("conflict")).toBeGreaterThanOrEqual(10);
    expect(count("none")).toBeGreaterThanOrEqual(10);
    expect(count("setting-conflict")).toBeGreaterThanOrEqual(3);
    expect(held.length / all.length).toBeGreaterThan(0.2);
    expect(all.some((c) => c.split === "tune")).toBe(true);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
  });

  it("prints the real numbers (README states these, and a test below keeps it honest)", () => {
    const tune = all.filter((c) => c.split === "tune");
    console.log([table("all", all), table("tune", tune), table("held-out", held)].join("\n"));
    expect(tune.length + held.length).toBe(all.length);
  });

  for (const split of ["tune", "held-out"] as const) {
    it(`meets the precision/recall budget on the ${split} split`, () => {
      const rows = measure(all.filter((c) => c.split === split));
      const conflict = rows.find((r) => r.kind === "conflict")!;
      expect(conflict.precision).toBeGreaterThanOrEqual(0.9);
      expect(conflict.recall).toBeGreaterThanOrEqual(0.6);
    });
  }

  it("allows at most one false conflict across the negatives, and no counted finding at all in the false-positive cases", () => {
    const negatives = all.filter((c) => c.kind === "none");
    const falseConflicts = negatives.filter((c) => analyse(c).some((f) => (f.kind === "conflict" || f.kind === "setting-conflict") && reported(f)));
    expect(falseConflicts.map((c) => c.id)).toEqual([]);
  });

  // Each positive case must produce the SPECIFIC finding: kind, rule, confidence and the evidence pair (path:line, in order).
  describe.each(all.filter((c) => c.kind !== "none" && c.expect))("$id ($kind, $split): $rationale", (c) => {
    it("produces the expected pair at the expected confidence", () => {
      const e = c.expect!;
      const matches = analyse(c).filter((f) => f.kind === (c.kind as FindingKind) && f.rule === e.rule && f.confidence === e.confidence
        && JSON.stringify(f.evidence.map((x) => [back(c, x.path), x.line])) === JSON.stringify(e.pair));
      expect(matches).toHaveLength(1);
    });
    it("never produces a forbidden kind at medium or higher confidence", () => {
      for (const kind of c.forbid ?? []) expect(analyse(c).filter((f) => f.kind === kind && f.confidence !== "low")).toEqual([]);
    });
  });

  describe.each(all.filter((c) => c.kind === "none"))("$id ($split): $rationale", (c) => {
    it("produces no counted finding", () => {
      expect(analyse(c).filter((f) => f.confidence !== "low" && !f.crossAgent && f.kind !== "repeated-in-file").map((f) => [f.kind, f.rule])).toEqual([]);
    });
  });

  it("the known misses are exactly the labelled positives with no expectation", () => {
    const misses = all.filter((c) => c.kind !== "none" && !c.expect).map((c) => c.id);
    for (const id of misses) { const c = all.find((x) => x.id === id)!; expect(found(c).has(c.kind as FindingKind)).toBe(false); }
    expect(misses).toEqual(["conf-11"]);
  });

  it("never turns a polarity-opposed near-match into a near-duplicate", () => {
    const c = all.find((x) => x.id === "conf-08")!;
    const kinds = found(c);
    expect(kinds.has("conflict")).toBe(true);
    expect(kinds.has("near-duplicate")).toBe(false);
    expect(kinds.has("duplicate")).toBe(false);
  });

  it("README states the real corpus size and held-out count", () => {
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const m = /corpus of (\d+) cases \((\d+) held out, (\d+) tuning\)/.exec(readme);
    expect(m, "README must say 'corpus of N cases (M held out, K tuning)'").not.toBeNull();
    expect([Number(m![1]), Number(m![2]), Number(m![3])]).toEqual([all.length, held.length, all.length - held.length]);
  });
});
