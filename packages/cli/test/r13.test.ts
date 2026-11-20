import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index";
import { put, sandbox } from "./helpers";

// a table, a blank line, then a directive with a pipe, against an imported `- Add comments.`, must give the conflict
// (f648a6a gave 1; 06364d2 gave 0 because the table state survived the blank line).
afterEach(() => vi.restoreAllMocks());

async function conflicts(claude: string) {
  const box = await sandbox();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await put(box.repo, "CLAUDE.md", claude);
    await put(box.repo, "notes.md", "- Add comments.\n");
    const out = join(box.root, "out");
    const code = await run([box.repo, "--out", out, "--allow-out-in-repo", "--dataset", "real"], { home: box.home, temp: box.temp, xdgRuntimeDir: undefined });
    expect(code).toBe(0);
    const json = JSON.parse(await readFile(join(out, "everyturn.json"), "utf8")) as { findings: { kind: string }[] };
    return json.findings.filter((f) => f.kind === "conflict").length;
  } finally { await box.cleanup(); }
}

describe("directives after a table are not dropped", () => {
  const forms: Record<string, string> = {
    "piped table, blank line": "| a | b |\n|---|---|\n| 1 | 2 |\n\n- Never add comments | use prose.",
    "pipeless table, blank line": "a | b\n--- | ---\n1 | 2\n\n- Never add comments | use prose.",
    "pipeless table, then a bullet": "a | b\n--- | ---\n1 | 2\n- Never add comments | use prose.",
    "pipeless table, heading": "a | b\n--- | ---\n1 | 2\n## Style\n- Never add comments | use prose.",
  };
  it.each(Object.keys(forms))("%s: one conflict", async (k) => {
    expect(await conflicts(`See @notes.md here.\n\n${forms[k]}\n`), k).toBe(1);
  }, 30_000);
});
