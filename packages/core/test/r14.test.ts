import { describe, expect, it } from "vitest";
import { extractRules } from "../src/rules";

// an HTML comment line or a quotation line right after a table ended nothing, so the next prose line with a pipe was read as a
// table row and dropped. Both now end the table.
const rules = (text: string) => extractRules("CLAUDE.md", text).map((r) => r.text);
const DIRECTIVE = "Never add comments | use prose.";
const TABLE = ["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
const PIPELESS = ["a | b", "--- | ---", "1 | 2"].join("\n");

describe("a comment or a quotation ends a table", () => {
  const forms: Record<string, string> = {
    "comment after a pipeless table": `${PIPELESS}\n<!-- note -->\n${DIRECTIVE}`,
    "comment after a piped table": `${TABLE}\n<!-- note -->\n${DIRECTIVE}`,
    "multi-line comment": `${PIPELESS}\n<!-- a\nb -->\n${DIRECTIVE}`,
    "quotation after a pipeless table": `${PIPELESS}\n> a quoted line\n${DIRECTIVE}`,
    "quotation after a piped table": `${TABLE}\n> a quoted line\n${DIRECTIVE}`,
    "quotation with a pipe": `${PIPELESS}\n> quoted | piped\n${DIRECTIVE}`,
  };
  it.each(Object.keys(forms))("%s: the directive is extracted", (k) => {
    expect(rules(forms[k]!).some((t) => /Never add comments/.test(t)), k).toBe(true);
  });
  it("quotations and table rows are still not directives", () => {
    expect(rules(`${PIPELESS}\n> Never add comments.\n| Never add comments. |`)).toEqual([]);
  });
});
