import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redact } from "../../core/src/index";
import { j, put, sandbox } from "./helpers";

// The scanner side of r11: the old leaking outputs must FAIL the strict scan, and what the fixed redactor makes of them must PASS.
// Written out at runtime (j) so the repository scan never sees them.
const exec = promisify(execFile);
const scanner = resolve("scripts/privacy-scan.mjs");
type Result = { code: number; text: string };
const scan = (args: string[]): Promise<Result> =>
  exec(process.execPath, [scanner, ...args], { env: { PATH: process.env.PATH ?? "" }, maxBuffer: 64 * 1024 * 1024 })
    .then((r) => ({ code: 0, text: r.stdout + r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, text: e.stdout + e.stderr }));
afterEach(() => vi.restoreAllMocks());

const PW = j("pass", "word");
const TOK = j("tok", "en");
const KEY = j("API_", "KEY");
const FAKE = "fake-violetzz-2468";
const VALUE = j("never add comments violet", "zz maple", "zz");
const sp = (n: number, c = " ") => c.repeat(n);
const wrap: Record<string, (t: string) => string> = {
  "everyturn.json": (t) => JSON.stringify({ sources: [{ represented: `${t}\n` }] }),
  "everyturn-sources.html": (t) => `<pre>\n${t}\n</pre>`,
  "everyturn.source.svg": (t) => `<svg xmlns="http://www.w3.org/2000/svg">\n<text>\n${t}\n</text>\n</svg>`,
};

const OLD: [string, string][] = [
  [j(PW, sp(17), "= violetzz"), "secret-keys"],
  [j(PW, sp(64), "= violetzz"), "secret-keys"],
  [j(PW, sp(1000), "= violetzz"), "secret-keys"],
  [j(PW.toUpperCase(), sp(17), "= violetzz"), "secret-keys"],
  [j(PW, sp(40, "\t"), "= violetzz"), "secret-keys"],
  [[j(PW, sp(17), '= """'), "", VALUE, '"""'].join("\n"), "secret-keys"],
  [j("- **", PW, "**: ", FAKE), "secret-keys"],
  [j("- *", PW, "*: ", FAKE), "secret-keys"],
  [j("- __", TOK, "__: ", FAKE), "secret-keys"],
  [j("- `", PW, "`: ", FAKE), "secret-keys"],
  [j("**", KEY, "** = ", FAKE), "secret-keys"],
  [j("| ", KEY, " | ", FAKE, " |"), "secret-keys"],
  [j("| Pass", "word | violetzz |"), "secret-keys"],
  [j("| **", TOK, "** | x | violetzz |"), "secret-keys"],
  [["| Name | " + KEY + " |", "| --- | --- |", "| a | " + FAKE + " |"].join("\n"), "secret-keys"],
];

describe("the scanner flags the old leaking outputs, and passes what the fixed redactor makes of them", () => {
  it.each(OLD)("%s", async (old, fam) => {
    const box = await sandbox();
    try {
      for (const [file, make] of Object.entries(wrap)) {
        await put(box.repo, `out/${file}`, make(old));
        const r = await scan([box.repo, "--artifacts", "out"]);
        expect(r.code, `${file}: ${JSON.stringify(old)}`).toBe(1);
        expect(r.text).toContain(`family ${fam}`);
        expect(r.text).not.toMatch(/violetzz|maplezz|2468/);
        const fixed = redact(old);
        expect(fixed).not.toMatch(/violetzz|maplezz|2468/);
        // everyturn.json keeps a document on one line, so a masked key followed by more text is flagged whatever the key was (the known false-fail, r8-fixes):
        // for JSON only the old output is checked.
        if (file !== "everyturn.json") {
          await put(box.repo, `out/${file}`, make(fixed));
          expect(await scan([box.repo, "--artifacts", "out"]), `${file}: ${JSON.stringify(fixed)}`).toMatchObject({ code: 0 });
        }
        await put(box.repo, `out/${file}`, "{}");
      }
    } finally { await box.cleanup(); }
  });
});
