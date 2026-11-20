import { describe, expect, it } from "vitest";
import * as P from "../src/patterns.mjs";
import { extractRules } from "../src/rules";

// pipeless Markdown tables (rows after a `---|---` delimiter row), emphasis variants around a key, and the poster path (rules).
// Secret-shaped inputs are assembled at runtime (j); only the fake values `violetzz maplezz` and `fake-violetzz-2468` appear.
const j = (...parts: string[]) => parts.join("");
const VALUE = j("never add comments violet", "zz maple", "zz");
const WORDS = ["violetzz", "maplezz", "never add comments violet", "2468"];
const PW = j("pass", "word");
const KEY = j("API_", "KEY");
const redact = (text: string) => P.redactGeneric(text);
const cover = (text: string) => [...P.secretBlockLines(text)].join("");
const family = (id: string) => P.FAMILIES.find((f) => f.id === id)!;
const full = (text: string) => family("secret-keys").apply(text);
const classic = (text: string) => family("secret-keys-core").apply(text);
const noWords = (out: string, label = "") => { for (const w of WORDS) expect(out, `${label} ${w}`).not.toContain(w); };
const lineCount = (text: string) => text.split("\n").length;

describe("pipeless tables: rows after a delimiter row are table rows", () => {
  const forms: Record<string, string> = {
    "secret header column": [`name | ${PW}`, "--- | ---", `db | ${VALUE}`].join("\n"),
    "secret header, tight delimiter": [`name | ${PW}`, "---|---", `db | ${VALUE}`].join("\n"),
    "secret header, aligned delimiter": [`name | ${PW}`, ":--|--:", `db | ${VALUE}`].join("\n"),
    "secret header, spaced aligned delimiter": [`Name | ${PW[0]!.toUpperCase()}${PW.slice(1)}`, " :---: | ---: ", `db | ${VALUE}`].join("\n"),
    "secret header, several rows": [`name | ${PW}`, "--- | ---", `a | ${VALUE}`, "b | violetzz", `c | ${VALUE}`].join("\n"),
    "secret header, three columns": [`name | note | ${j("tok", "en")}`, "--- | --- | ---", `db | ok | ${VALUE}`].join("\n"),
    "secret header, pipeless header with outer-pipe rows": [`name | ${PW}`, "--- | ---", `| db | ${VALUE} |`].join("\n"),
    "outer-pipe header, pipeless delimiter and rows": [`| name | ${PW} |`, "--- | ---", `db | ${VALUE}`].join("\n"),
    "outer-pipe header and delimiter, pipeless rows": [`| name | ${PW} |`, "|---|---|", `db | ${VALUE}`].join("\n"),
    "key cell in a pipeless row": ["Name | Value", "--- | ---", `${KEY} | ${VALUE}`].join("\n"),
    "key cell, not first": ["Name | Kind | Value", "--- | --- | ---", `db | ${PW} | ${VALUE}`].join("\n"),
    "key cell, note to the right": ["Name | Value | Note", "--- | --- | ---", `${KEY} | ${VALUE} | note violetzz`].join("\n"),
  };
  for (const [label, text] of Object.entries(forms)) {
    it(`${label}: masked by redactGeneric, both scanner families and covered by secretBlockLines`, () => {
      for (const out of [redact(text), full(text), classic(text)]) { noWords(out, label); expect(lineCount(out)).toBe(lineCount(text)); }
      expect(redact(redact(text))).toBe(redact(text));
      expect(cover(text).endsWith("1"), `${label}: value row withheld from excerpts`).toBe(true);
    });
  }
  it("the header and the key cell stay readable", () => {
    const out = redact([`name | ${PW}`, "--- | ---", `db | ${VALUE}`].join("\n"));
    expect(out).toContain(`name | ${PW}`);
    expect(out).toContain("db |");
    expect(out).toContain("[secret]");
  });
  it("rows stop at a blank line and at a line without a pipe", () => {
    const text = [`name | ${PW}`, "--- | ---", `db | ${VALUE}`, "", "x | violetzz", `plain violetzz line`].join("\n");
    const out = redact(text);
    expect(out).not.toContain("never add comments");
    expect(out).toContain("x | violetzz");
    expect(out).toContain("plain violetzz line");
    const out2 = redact([`name | ${PW}`, "--- | ---", `db | ${VALUE}`, "plain violetzz line"].join("\n"));
    expect(out2).toContain("plain violetzz line");
    expect(out2).not.toContain("never add comments");
  });
  it("the piped form keeps working", () => {
    for (const text of [
      [`| name | ${PW} |`, "|---|---|", `| db | ${VALUE} |`].join("\n"),
      [`| name | ${PW} |`, "| --- | --- |", `| db | ${VALUE} |`].join("\n"),
      `| ${KEY} | ${VALUE} |`,
    ]) noWords(redact(text));
  });
  it("horizontal rules, front matter and a pipe in prose are not tables", () => {
    const row = "x | violetzz";
    for (const text of [
      `name | ${PW}\n---\n${row}`,
      `---\nname | ${PW}\n---\n${row}`,
      `name | ${PW}\n***\n${row}`,
      `name | ${PW}\n\n--- | ---\n${row}`,
      `name | ${PW}\n--- text | ---\n${row}`,
      `plain\n--- | ---\n${row}`,
      `---\n${row}\n---`,
    ]) expect(redact(text), text).toContain(row);
  });
});

describe("rules: pipeless table rows are never directives", () => {
  const ids = (text: string) => extractRules("s", text).map((r) => r.text);
  it("a row after a pipeless delimiter is not extracted", () => {
    for (const delim of ["--- | ---", "---|---", ":--|--:", "|---|---|", "| --- | --- |"]) {
      const rules = ids([`name | ${PW}`, delim, `db | ${VALUE}`, `db2 | never use tabs`].join("\n"));
      expect(rules, delim).toEqual([]);
    }
  });
  it("an outer-pipe header with a pipeless row is not extracted", () => {
    expect(ids([`| name | ${PW} |`, "|---|---|", `db | ${VALUE}`].join("\n"))).toEqual([]);
  });
  it("a bullet after the table and the lines after a blank line still count", () => {
    const rules = ids([`name | ${PW}`, "--- | ---", `db | ${VALUE}`, "", "- Never add comments.", "", "Always run tests."].join("\n"));
    expect(rules).toEqual(["Never add comments.", "Always run tests."]);
  });
  it("a heading ends the table", () => {
    expect(ids([`name | ${PW}`, "--- | ---", `db | ${VALUE}`, "# Rules", "- Never add comments."].join("\n"))).toEqual(["Never add comments."]);
  });
  it("a horizontal rule or front matter is not a delimiter row", () => {
    expect(ids("Always do x | y\n---\n- Never add comments.")).toContain("Never add comments.");
    expect(ids("- Never a | b\n---\n- Always c")).toEqual(["Never a | b", "Always c"]);
  });
});

describe("emphasis around a key: ~~ and HTML <b>/<strong>", () => {
  const forms: Record<string, string> = {
    "strike": j("~~", PW, "~~: violetzz"),
    "b": j("<b>", PW, "</b>: violetzz"),
    "strong": j("<strong>", PW, "</strong>: violetzz"),
    "B upper": j("<B>", PW, "</B>: violetzz"),
    "strong, colon inside": j("<strong>", PW, ":</strong> violetzz"),
    "strike, equals": j("~~", PW, "~~ = violetzz"),
    "bullet strike": j("- ~~", PW, "~~: violetzz"),
    "strike and bold": j("**~~", PW, "~~**: violetzz"),
    "table key, strike": j("| ~~", KEY, "~~ | violetzz |"),
    "table key, b": j("| <b>", KEY, "</b> | violetzz |"),
    "table key, strong": j("| <strong>", KEY, "</strong> | violetzz |"),
    "table header, strong": [j("| <strong>", PW, "</strong> | Note |"), "|---|---|", "| violetzz | ok |"].join("\n"),
  };
  for (const [label, text] of Object.entries(forms)) {
    it(`${label}: masked`, () => {
      for (const out of [redact(text), full(text), classic(text)]) noWords(out, label);
    });
  }
  it("plain tildes and tags elsewhere are left alone", () => {
    expect(redact("run ~~old~~ then <b>bold</b> text")).toBe("run ~~old~~ then <b>bold</b> text");
  });
});
