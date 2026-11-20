import { describe, expect, it } from "vitest";
import * as P from "../src/patterns.mjs";
import { extractRules } from "../src/rules";

// the pipeless-table state in extractRules must end at a blank line, thematic break, heading, fence or bullet; a bullet ends a pipeless
// table in maskTables too; `<b>key </b>:` and `<em>`/`<i>` keys. Secret-shaped inputs are assembled at runtime (j); fake values only.
const j = (...parts: string[]) => parts.join("");
const PW = j("pass", "word");
const rules = (text: string) => extractRules("CLAUDE.md", text).map((r) => r.text);
const DIRECTIVE = "Never add comments | use prose.";
const TABLE = ["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
const PIPELESS = ["a | b", "--- | ---", "1 | 2"].join("\n");

describe("a table never swallows later directives", () => {
  const after: Record<string, string> = {
    "blank line": `${TABLE}\n\n- ${DIRECTIVE}`,
    "blank line, pipeless table": `${PIPELESS}\n\n- ${DIRECTIVE}`,
    "thematic break": `${PIPELESS}\n---\n- ${DIRECTIVE}`,
    heading: `${PIPELESS}\n## Style\n- ${DIRECTIVE}`,
    fence: `${PIPELESS}\n\`\`\`\ncode\n\`\`\`\n- ${DIRECTIVE}`,
    "blank line then paragraph": `${PIPELESS}\n\nNever add comments | use prose.`,
    "much later": `${PIPELESS}\n\n# Rules\n\nSome text.\n\n- ${DIRECTIVE}`,
  };
  it.each(Object.keys(after))("%s: the directive is extracted", (k) => {
    expect(rules(after[k]!).some((t) => /Never add comments/.test(t)), k).toBe(true);
  });
  it("rows of a pipeless table are still not directives", () => {
    expect(rules(["name | rule", "--- | ---", "a | Never add comments."].join("\n"))).toEqual([]);
  });
});

describe("a bullet ends a pipeless table (extractRules and maskTables)", () => {
  const text = [`name | ${PW}`, "--- | ---", "db | violetzz", `- ${DIRECTIVE}`].join("\n");
  it("extractRules keeps the bullet as a directive", () => {
    expect(rules(text).some((t) => /Never add comments/.test(t))).toBe(true);
  });
  it("maskTables still masks the real row and leaves the bullet", () => {
    const out = P.redactGeneric(text).split("\n");
    expect(out[2]).not.toContain("violetzz");
    expect(out[3]).toBe(`- ${DIRECTIVE}`);
  });
  it("a numbered item ends it too, and a secret key in the bullet is still masked by the key rules", () => {
    const t = [`name | ${PW}`, "--- | ---", "db | violetzz", `1. ${PW}: maplezz | note`].join("\n");
    const out = P.redactGeneric(t);
    expect(out).not.toMatch(/violetzz|maplezz/);
  });
});

describe("HTML emphasis variants around a key", () => {
  const forms = [`<b>${PW} </b>: violetzz`, `<b> ${PW}</b>: violetzz`, `<em>${PW}</em>: violetzz`, `<i>${PW}</i> = violetzz`, `<EM>${PW}</EM>: violetzz`, `- <strong>${PW} </strong>: violetzz`];
  it.each(forms)("%s is masked", (f) => {
    expect(P.redactGeneric(f)).not.toContain("violetzz");
  });
  it("plain prose with tags stays", () => {
    expect(P.redactGeneric("<em>Note</em>: keep this")).toBe("<em>Note</em>: keep this");
  });
});
