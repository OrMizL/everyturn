import { describe, expect, it } from "vitest";
import * as P from "../src/patterns.mjs";

// a key aligned far from its separator, Markdown emphasis around keys, Markdown table cells, and the quadratic quote scan.
// Secret-shaped inputs are assembled at runtime (j) so the repository scan never sees a literal key/value line; only the fake values
// `violetzz maplezz` and `fake-violetzz-2468` appear.
const j = (...parts: string[]) => parts.join("");
const VALUE = j("never add comments violet", "zz maple", "zz");
const FAKE = "fake-violetzz-2468";
const WORDS = ["violetzz", "maplezz", "never add comments violet", "2468"];
const redact = (text: string) => P.redactGeneric(text);
const cover = (text: string) => [...P.secretBlockLines(text)].join("");
const family = (id: string) => P.FAMILIES.find((f) => f.id === id)!;
const full = (text: string) => family("secret-keys").apply(text);
const classic = (text: string) => family("secret-keys-core").apply(text);
const lineCount = (text: string) => text.split("\n").length;
const PW = j("pass", "word");
const TOK = j("tok", "en");
const sp = (n: number, c = " ") => c.repeat(n);
const noWords = (out: string, label = "") => { for (const w of WORDS) expect(out, `${label} ${w}`).not.toContain(w); };

describe("any horizontal whitespace run between a key and its separator", () => {
  const gaps: [string, string][] = [
    ["17 spaces", sp(17)], ["64 spaces", sp(64)], ["1000 spaces", sp(1000)],
    ["17 tabs", sp(17, "\t")], ["200 tabs", sp(200, "\t")], ["mixed run", " \t".repeat(40)], ["NBSP run", sp(30, " ")], ["mixed NBSP run", `  \t`.repeat(30)],
  ];
  const names = [PW, PW.toUpperCase(), j("Pass", "word"), j("api_", "key"), j("GITHUB_", "TOKEN"), j("client", "Secret")];
  for (const [label, gap] of gaps) {
    it.each(names)(`${label}: %s = value is masked (full, classic, redactGeneric)`, (name) => {
      for (const sep of ["=", ":"]) {
        const text = `a: 1\n${name}${gap}${sep} violetzz\nafter this`;
        for (const out of [redact(text), full(text), classic(text)]) {
          noWords(out, label);
          expect(out).toMatch(/after this$/);
          expect(lineCount(out)).toBe(lineCount(text));
        }
        expect(redact(redact(text))).toBe(redact(text));
      }
    });
  }
  it("the gap does not make an ordinary line a key", () => {
    const ok = [`name${sp(40)}= violetzz`, `${sp(40)}= violetzz`, `Note${sp(40)}: hello`];
    for (const t of ok) expect(redact(t), t).toBe(t);
  });
  it("a 17-space aligned key with a triple-quoted value: nothing survives, the closer is covered", () => {
    for (const q of ['"""', "'''"]) {
      for (const body of [["", VALUE], [VALUE], ["", "", VALUE, "more violetzz"], [""]]) {
        const text = ["a: 1", j(PW, sp(17), "= ", q), ...body, q, "after this"].join("\n");
        noWords(redact(text), q);
        noWords(classic(text), q);
        expect(redact(redact(text))).toBe(redact(text));
        expect(lineCount(redact(text))).toBe(lineCount(text));
        expect(redact(text)).toMatch(/after this$/);
        expect(cover(text)).toBe(`0${"1".repeat(body.length + 2)}0`);
      }
    }
  });
  it("the OCR matcher sees a key far from its separator", () => {
    for (const n of [17, 64, 200]) expect(P.looseSecretKey(j("pass", "word", sp(n), "= violetzz")), String(n)).toBe(true);
    expect(P.looseSecretKey(j("Auth", "or", sp(100), ": Someone"))).toBe(false);
  });
  it("hasSecretKeyPair and literal keys also see the aligned key", () => {
    expect(P.hasSecretKeyPair(j(PW, sp(40), "= violetzz"))).toBe(true);
    expect(P.hasSecretKeyPair(j(PW, sp(40, " "), "= violetzz"))).toBe(true);
  });
});

describe("Markdown emphasis around a key", () => {
  const bare = [PW, TOK, j("API_", "KEY"), j("Pass", "word"), j("secr", "et"), j("api_", "key")];
  const wraps: [string, (k: string) => string][] = [
    ["**k**", (k) => `**${k}**`], ["*k*", (k) => `*${k}*`], ["__k__", (k) => `__${k}__`], ["_k_", (k) => `_${k}_`], ["`k`", (k) => `\`${k}\``],
    ["***k***", (k) => `***${k}***`], ["**`k`**", (k) => `**\`${k}\`**`], ["`**k**`", (k) => `\`**${k}**\``], ["*`k`*", (k) => `*\`${k}\`*`], ["**k:**", (k) => `**${k}:**`],
  ];
  for (const [label, wrap] of wraps) {
    it.each(bare)(`${label}: %s`, (k) => {
      const key = wrap(k);
      const forms = [
        `- ${key}: ${FAKE}`, `- ${key} : ${FAKE}`, `- ${key}${sp(20)}: ${FAKE}`, `${key} = ${FAKE}`, `* ${key}: ${FAKE}`, `1. ${key}: ${FAKE}`,
        `- ${key} = ${FAKE}`,
      ];
      for (const t of forms) {
        const text = `Intro line\n\n${t}\n\nafter this`;
        for (const out of [redact(text), full(text), classic(text)]) {
          noWords(out, t);
          expect(out).toMatch(/after this$/);
          expect(lineCount(out)).toBe(5);
        }
        expect(redact(redact(text))).toBe(redact(text));
      }
    });
  }
  it("an emphasised key with a multi-line value masks the value lines, and the excerpt gate covers them", () => {
    const text = [j("- **", PW, "**:"), `  ${FAKE}`, `  more violetzz`, "- ordinary: 1"].join("\n");
    noWords(redact(text));
    expect(cover(text).slice(0, 3)).toBe("111");
  });
  it("ordinary emphasis is untouched", () => {
    for (const t of ["- **Note**: keep it short", "- *Author*: someone", "- **Keyboard**: us", "__init__: 1", "- **Rule**: never add comments", "**bold** and *it* and `code`"]) expect(redact(t), t).toBe(t);
  });
  it("hasSecretKeyPair sees an emphasised key", () => {
    expect(P.hasSecretKeyPair(j("- **", PW, "**: ", FAKE))).toBe(true);
  });
});

describe("Markdown table cells", () => {
  const T = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const rows: Record<string, string> = {
    "key cell, value cell": T([j("API_", "KEY"), FAKE]),
    "Password row": T([j("Pass", "word"), "violetzz"]),
    "bold key, two cells to the right": T([`**${TOK}**`, "violetzz", "maplezz note"]),
    "backtick key": T([`\`${j("api_", "key")}\``, FAKE]),
    "key is the second cell": T(["Service", j("API_", "KEY"), FAKE, "violetzz"]),
    "multi-word key": T([j("API ", "key"), FAKE]),
    "no closing pipe": `| ${j("API_", "KEY")} | ${FAKE}`,
    "indented row": `   | ${j("API_", "KEY")} | ${FAKE} |`,
    "plural key": T([j("Pass", "words"), FAKE]),
    "tight pipes": `|${j("API_", "KEY")}|${FAKE}|`,
    "colon in the key cell": T([`${PW}:`, FAKE]),
  };
  it.each(Object.keys(rows))("%s: the cells to the right of the key are masked", (k) => {
    const text = `Intro\n\n${rows[k]}\n\nafter this`;
    for (const out of [redact(text), full(text), classic(text)]) {
      noWords(out, k);
      expect(out).toMatch(/after this$/);
      expect(lineCount(out)).toBe(5);
    }
    expect(redact(redact(text))).toBe(redact(text));
    expect(cover(text)[2]).toBe("1");
  });
  it("the key cell and the cells to its left keep their text; the row shape is kept", () => {
    expect(redact(T([j("API_", "KEY"), FAKE]))).toBe(T([j("API_", "KEY"), "[secret]"]));
    expect(redact(T(["Service", `**${TOK}**`, "violetzz", "x"]))).toBe(T(["Service", `**${TOK}**`, "[secret]", "[secret]"]));
  });
  it("a header-style table masks the column of a secret-named header in every following row", () => {
    const text = ["| Name | " + j("API_", "KEY") + " | Note |", "| --- | :---: | --- |", "| a | violetzz | ok |", "| b | " + FAKE + " | fine |", "| c | maplezz |", "", "| other | 1 | 2 |"].join("\n");
    const out = redact(text);
    noWords(out);
    expect(out.split("\n")).toEqual(["| Name | " + j("API_", "KEY") + " | Note |", "| --- | :---: | --- |", "| a | [secret] | ok |", "| b | [secret] | fine |", "| c | [secret] |", "", "| other | 1 | 2 |"]);
    noWords(full(text));
    noWords(classic(text));
    expect(redact(out)).toBe(out);
    expect(cover(text).slice(2, 5)).toBe("111");
  });
  it("a header-style table: the column rule and the row rule both apply", () => {
    const text = ["| Name | Value | " + TOK + " |", "|---|---|---|", "| " + PW + " | violetzz | x |", "| plain | keep | violetzz |"].join("\n");
    expect(redact(text).split("\n")).toEqual(["| Name | Value | " + TOK + " |", "|---|---|---|", "| " + PW + " | [secret] | [secret] |", "| plain | keep | [secret] |"]);
  });
  it("a header row followed by its delimiter row does not mask its own other cells", () => {
    const h = "| Name | " + TOK + " | Note |";
    expect(redact(`${h}\n|---|---|---|`)).toBe(`${h}\n|---|---|---|`);
  });
  it("a column ends with its table", () => {
    const text = ["| Name | " + TOK + " |", "|---|---|", "| a | violetzz |", "text break", "| b | keep |"].join("\n");
    expect(redact(text).split("\n")).toEqual(["| Name | " + TOK + " |", "|---|---|", "| a | [secret] |", "text break", "| b | keep |"]);
  });
  it("ordinary tables stay as they are", () => {
    const tables = [
      "| Name | Value |\n|---|---|\n| a | 1 |\n| b | 2 |", "| Key | Action |\n|---|---|\n| Ctrl+C | copy |", "| Endpoint | Auth |\n|---|---|\n| /a | required |",
      "| File | Lines |\n| --- | --- |\n| CLAUDE.md | 12 |", "| a | b |\n| c | d |", "| Rule | Source |\n|---|---|\n| Never add comments | CLAUDE.md |",
      "| Rotate the token every 90 days | monthly |", "| Author | Someone |", "| Primary key | id |",
    ];
    for (const t of tables) expect(redact(t), t).toBe(t);
  });
  it("placeholder cells and delimiter rows are left alone", () => {
    const t = ["| Name | Value |", "| --- | --- |", "| " + j("API_", "KEY") + " | [secret] |", "| " + PW + " | `[secret]` | [secret] |"].join("\n");
    expect(redact(t)).toBe(t);
  });
  it("escaped pipes stay inside their cell", () => {
    const out = redact("| " + j("API_", "KEY") + " | violetzz \\| maplezz | x |");
    noWords(out);
    expect(out).toBe("| " + j("API_", "KEY") + " | [secret] | [secret] |");
  });
  it("snippet and block gates withhold a table with a secret row", () => {
    expect(cover("a\n" + T([j("API_", "KEY"), FAKE]) + "\nb")).toBe("010");
  });
});

// ---- performance ---------------------------------------------------------------------------------------
const KIB = 1024;
const timeIt = (fn: () => unknown) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
const fit = (s: string, n = 256 * KIB) => s.repeat(Math.ceil(n / s.length)).slice(0, n);

describe("perf: 256 KiB adversarial inputs, each under 500 ms", () => {
  const inputs: Record<string, string> = {
    "key + spaces, no separator": fit(j(PW, " ").concat(sp(1000)), 256 * KIB),
    "key + 256 KiB of spaces": j(PW, sp(256 * KIB)),
    "key + 256 KiB of tabs": j(PW, sp(256 * KIB, "\t")),
    "key + 256 KiB of NBSP": j(PW, sp(256 * KIB, " ")),
    "key + 128 KiB of spaces + separator": j(PW, sp(128 * KIB), "= x"),
    "key + 40 spaces + = , repeated on a line": fit(j(PW, sp(40), "= x ")),
    "spaces + =, repeated": fit(" = ".repeat(10)),
    "aligned keys, one per line": fit(j(PW, sp(200), "= x\n")),
    "emphasis runs": fit(j("*".repeat(1000), "x", "*".repeat(1000), ": ")),
    "emphasis + backticks": fit("**`".repeat(100) + ": "),
    "stars and colons": fit("*:"),
    "quotes and colons": fit("\":"),
    "table rows with a hit": fit(`| ${j("API_", "KEY")} | ${FAKE} | x |\n`),
    "table: header + column": `| a | ${TOK} |\n|---|---|\n` + fit("| x | y |\n", 256 * KIB),
    "table: one huge row": `| ${j("API_", "KEY")} ` + "| x ".repeat(60_000),
    "table: one huge row, no key": "| a ".repeat(60_000),
    "table: pipes only": "|".repeat(256 * KIB),
    "table: escaped pipes": "| a \\".repeat(60_000),
    "table: many headers": fit(`| ${TOK} | ${TOK} |\n|---|---|\n`),
    "table: delimiter rows": fit("|---|---|\n"),
  };
  it.each(Object.keys(inputs))("%s", (name) => {
    const text = inputs[name]!;
    const ms = {
      redactGeneric: timeIt(() => P.redactGeneric(text)),
      blockLines: timeIt(() => P.secretBlockLines(text)),
      full: timeIt(() => full(text)),
      classic: timeIt(() => classic(text)),
      loose: timeIt(() => P.looseSecretKey(text)),
      pair: timeIt(() => P.hasSecretKeyPair(text)),
    };
    console.log(`[perf] ${name}: ${Object.entries(ms).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(", ")} ms`);
    for (const [k, v] of Object.entries(ms)) expect(v, `${name}: ${k}`).toBeLessThan(500);
  }, 60_000);
});

describe("perf: the quote scan is linear", () => {
  const unit = (q: string) => `${q}x${q} `;
  const shapes: Record<string, (n: number) => string> = {
    '"""x"""': (n) => `${PW}: x\n${unit('"""').repeat(n)}`,
    "'''x'''": (n) => `${PW}: x\n${unit("'''").repeat(n)}`,
    '"x"': (n) => `${PW}: x\n${unit('"').repeat(n)}`,
    "'x'": (n) => `${PW}: x\n${unit("'").repeat(n)}`,
    mixed: (n) => `${PW}: x\n${(unit('"""') + unit("'''") + unit('"') + unit("'")).repeat(n)}`,
    "no key line": (n) => unit('"""').repeat(n),
    "value quotes": (n) => `${PW}: x\n${'= "x" '.repeat(n)}`,
    "dash quotes": (n) => `${PW}: x\n${'- "x" '.repeat(n)}`,
    "colon quotes, no key": (n) => `a: x\n${'a: "x" '.repeat(n)}`,
    "unclosed triples": (n) => `${PW}: x\n${'"""x '.repeat(n)}`,
  };
  it.each(Object.keys(shapes))("%s", (name) => {
    const make = (size: number) => shapes[name]!(Math.ceil(size / 6)).slice(0, size);
    const text = make(256 * KIB);
    const ms = {
      redactGeneric: timeIt(() => P.redactGeneric(text)),
      blockLines: timeIt(() => P.secretBlockLines(text)),
      full: timeIt(() => full(text)),
      classic: timeIt(() => classic(text)),
    };
    console.log(`[perf] quotes ${name}: ${Object.entries(ms).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(", ")} ms`);
    for (const [k, v] of Object.entries(ms)) expect(v, `${name}: ${k}`).toBeLessThan(500);
    // doubling the size stays well under quadratic growth
    const small = make(128 * KIB);
    const t128 = Math.max(timeIt(() => P.redactGeneric(small)), 20);
    const t256 = timeIt(() => P.redactGeneric(text));
    expect(t256, `${name}: 128 KiB ${t128.toFixed(0)} ms, 256 KiB ${t256.toFixed(0)} ms`).toBeLessThan(t128 * 3.2);
  }, 60_000);
  it("a quote-heavy reproducer", () => {
    const text = (`${PW}: x\n` + '"""x""" '.repeat(40_000)).slice(0, 256 * KIB);
    const ms = timeIt(() => P.redactGeneric(text));
    console.log(`[perf] quote reproducer redactGeneric: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(500);
  });
});
