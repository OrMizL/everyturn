import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HELP, run } from "../src/index";

// --help/-h prints the usage and every option, --version/-v prints the package version; both exit 0 and read or write nothing.
afterEach(() => vi.restoreAllMocks());
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const OPTIONS = ["--agent", "--out", "--allow-out-in-repo", "--overwrite", "--include-user", "--deny", "--denylist", "--findings", "--dataset", "--show-names", "--print-paths", "--help", "--version"];

async function capture(argv: string[]) {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const code = await run(argv, { home: "/nonexistent-home", temp: "/nonexistent-temp", xdgRuntimeDir: undefined });
  return { code, out: out.join("\n"), errors: err.mock.calls.length };
}

describe("help and version", () => {
  it.each([["--help"], ["-h"], ["some/repo", "--help"], ["--agent", "codex", "-h"]])("%s prints the usage and exits 0", async (...argv) => {
    const r = await capture(argv);
    expect(r.code).toBe(0);
    expect(r.errors).toBe(0);
    expect(r.out).toBe(HELP);
    expect(r.out).toMatch(/^Usage: everyturn \[repo\] \[options\]/);
  });
  it("the help lists every option the CLI accepts", () => {
    for (const o of OPTIONS) expect(HELP, o).toContain(o);
    expect(HELP).toContain("-h, --help");
    expect(HELP).toContain("-v, --version");
  });
  it.each([["--version"], ["-v"], ["some/repo", "--version"]])("%s prints the package version and exits 0", async (...argv) => {
    const r = await capture(argv);
    expect(r.code).toBe(0);
    expect(r.errors).toBe(0);
    expect(r.out).toBe(pkg.version);
    expect(pkg.version).toBe("0.1.0");
  });
  it("other unknown options are still refused", async () => {
    const r = await capture(["--helpme"]);
    expect(r.code).toBe(2);
  });
});
