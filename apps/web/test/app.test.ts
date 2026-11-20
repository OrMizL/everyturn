// The page's logic without a DOM: the sample flow must equal the CLI's output, and every file error in the spec's table
// must come out as specified. The browser glue (main.ts) only draws what these functions return.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES as CLI_FILE, MAX_RUN_BYTES as CLI_RUN } from "../../../packages/cli/src/discover";
import { run } from "../../../packages/cli/src/index";
import { j, sandbox } from "../../../packages/cli/test/helpers";
import {
  AGENT_OPTIONS, ALERTS, MAX_FILE_BYTES, MAX_RUN_BYTES, STATUS, Workspace, analyze, countLabel, datasetFor, formatSize, jsonErrorLine,
  normalizePath, reportJson, skipSummary,
} from "../src/app";
import type { Candidate } from "../src/app";
import { sampleCandidates } from "../src/sample";

const enc = new TextEncoder();
const candidate = (path: string, body: string | Uint8Array, direct = true): Candidate => {
  const bytes = typeof body === "string" ? enc.encode(body) : body;
  return { path, size: bytes.length, read: async () => bytes, direct };
};

async function sampleAnalysis(agent: "claude-code" | "codex" = "claude-code") {
  const ws = new Workspace();
  await ws.add(sampleCandidates());
  const prepared = await ws.prepare();
  return analyze({ files: prepared.files, imported: prepared.imported, warnings: prepared.warnings, agent, sample: true });
}

describe("sample flow equals the CLI", () => {
  it("gives the CLI's poster source SVG and report JSON for fixtures/demo-repo", async () => {
    const box = await sandbox();
    try {
      const out = join(box.temp, "cli-out");
      const silent = { ...box };
      const logs: unknown[][] = [];
      const log = console.log, err = console.error;
      console.log = (...a: unknown[]) => { logs.push(a); }; console.error = (...a: unknown[]) => { logs.push(a); };
      let code: number;
      try { code = await run(["fixtures/demo-repo", "--agent", "claude-code", "--dataset", "sample", "--out", out, "--allow-out-in-repo"], silent); }
      finally { console.log = log; console.error = err; }
      expect(code).toBe(0);
      const cliSvg = await readFile(join(out, "everyturn.source.svg"), "utf8");
      const cliJson = await readFile(join(out, "everyturn.json"), "utf8");
      const web = await sampleAnalysis();
      expect(web.svg).toBe(cliSvg);
      expect(reportJson(web.report)).toBe(cliJson);
      // The browser's own rasterizer (resvg wasm from the bundled bytes, render.ts) gives the CLI's outlined SVG and PNG, byte for byte.
      const { rasterize } = await import("../src/render");
      const drawn = await rasterize(web.svg);
      expect(drawn.outlinedSvg).toBe(await readFile(join(out, "everyturn.svg"), "utf8"));
      expect(Buffer.from(drawn.png).equals(await readFile(join(out, "everyturn.png")))).toBe(true);
    } finally { await box.cleanup(); }
  });

  it("shows '4 possible conflicts · 1 duplicate', the subline and '1 of 4 shown'", async () => {
    const web = await sampleAnalysis();
    expect(web.hero.conflicts).toBe(4);
    expect(web.svg).toContain(">4 possible conflicts · 1 duplicate<");
    expect(web.svg).toContain(">from 5 always-loaded sources, before you type anything<");
    expect(web.svg).toContain(">POSSIBLE CONFLICT<");
    expect(web.svg).not.toContain("POTENTIAL");
    expect(web.svg).toContain("1 of 4 shown");
    // The alt text carries the same summary, the not-counted files and the highlighted finding.
    expect(web.alt).toContain("4 possible conflicts, 1 duplicate.");
    expect(web.alt).toContain("4 more files found, not counted.");
    expect(web.choices.filter((c) => c.group === "conflict")).toHaveLength(4);
    expect(web.dataset).toBe("SAMPLE SETUP");
  });

  it("loads only the bundled demo repo: no corpus, negative repo or .env", () => {
    const paths = sampleCandidates().map((c) => c.path);
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain(".mcp.json");
    expect(paths.some((p) => p.includes("corpus") || p.includes("negative"))).toBe(false);
    expect(paths.some((p) => /(^|\/)\.env/.test(p))).toBe(false);
  });

  it("picking another finding re-orders by identity and keeps the poster the CLI's for the default", async () => {
    const web = await sampleAnalysis();
    for (const choice of web.choices) {
      const ws = new Workspace();
      await ws.add(sampleCandidates());
      const prepared = await ws.prepare();
      const again = analyze({ files: prepared.files, imported: prepared.imported, warnings: prepared.warnings, agent: "claude-code", sample: true, choice: choice.id });
      expect(again.selected).toBe(choice.id);
      expect(again.hero).toEqual(web.hero);
      if (choice.group === "conflict") expect(again.alt).toContain(choice.label.split(" ≠ ")[0]!.split(":")[0]!);
    }
  });

  it("lists only agents core supports end to end, in the spec's order", () => {
    expect(AGENT_OPTIONS.map((a) => a.label)).toEqual(["Claude Code", "Codex", "Cursor", "GitHub Copilot", "Windsurf"]);
  });

  it("renders for every listed agent without throwing", async () => {
    for (const { value } of AGENT_OPTIONS) {
      const web = await sampleAnalysis(value as "claude-code");
      expect(web.svg.startsWith("<svg")).toBe(true);
    }
  });
});

describe("badge logic (same as the CLI without a denylist)", () => {
  it("sample is SAMPLE SETUP, user files are UNREVIEWED REAL SET", async () => {
    expect(datasetFor(true)).toBe("SAMPLE SETUP");
    expect(datasetFor(false)).toBe("UNREVIEWED REAL SET");
    const ws = new Workspace();
    ws.addText("CLAUDE.md", "- Always run tests.\n");
    const prepared = await ws.prepare();
    const real = analyze({ files: prepared.files, agent: "claude-code", sample: false });
    expect(real.dataset).toBe("UNREVIEWED REAL SET");
    expect(real.svg).toContain("UNREVIEWED REAL SET");
  });

  it("redacts a pasted secret and an absolute home path in real mode", async () => {
    const ws = new Workspace();
    const home = j("/ho", "me/someone");
    ws.addText("CLAUDE.md", `- Use the key ${j("sk", "_live_", "abcdefghijklmnop1234")} for deploys.\n- See ${home}/notes.md for more.\n- Always run tests.\n`);
    const prepared = await ws.prepare();
    const real = analyze({ files: prepared.files, agent: "claude-code", sample: false });
    const everything = real.svg + reportJson(real.report) + real.alt;
    expect(everything).not.toContain(j("sk", "_live_"));
    expect(everything).not.toContain(home);
  });
});

describe("file validation, per the spec's error table", () => {
  it("never reads .env files, and says why", async () => {
    const ws = new Workspace();
    let reads = 0;
    const env: Candidate = { path: ".env.local", size: 12, direct: true, read: async () => { reads++; return enc.encode("not read"); } };
    await ws.add([env, { ...env, path: ".env" }, { ...env, path: "apps/web/.env.production" }]);
    expect(reads).toBe(0);
    expect(ws.rows.map((r) => r.skip)).toEqual([".env is never read", ".env is never read", ".env is never read"]);
    expect(ws.usable).toBe(0);
    ws.addText(".env", "not read");
    expect(ws.rows.find((r) => r.path === ".env")?.skip).toBe(".env is never read");
  });

  it("skips unsupported types for picked files, but filters folder contents silently", async () => {
    const ws = new Workspace();
    await ws.add([candidate("logo.png", "x"), candidate("notes.pdf", "x"), candidate("random.txt", "x")]);
    expect(ws.rows.map((r) => r.skip)).toEqual(["not an instruction file", "not an instruction file", "not an instruction file"]);
    const dir = new Workspace();
    await dir.add([candidate("src/index.ts", "x", false), candidate("CLAUDE.md", "- a\n", false)]);
    expect(dir.rows.map((r) => r.path)).toEqual(["CLAUDE.md"]);
  });

  it("skips files over 256 KiB without reading them", async () => {
    const ws = new Workspace();
    let reads = 0;
    await ws.add([{ path: "CLAUDE.md", size: MAX_FILE_BYTES + 1, direct: true, read: async () => { reads++; return new Uint8Array(); } }]);
    expect(reads).toBe(0);
    expect(ws.rows[0]?.skip).toBe("over 256 KiB");
    expect((await ws.prepare()).warnings).toEqual([`CLAUDE.md: over ${MAX_FILE_BYTES} bytes, skipped`]);
    ws.addText("AGENTS.md", "a".repeat(MAX_FILE_BYTES + 1));
    expect(ws.rows.find((r) => r.path === "AGENTS.md")?.skip).toBe("over 256 KiB");
  });

  it("refuses a run over 5 MiB, keeps what was added, and does not add the file that would pass it", async () => {
    const ws = new Workspace();
    const big = "a".repeat(MAX_FILE_BYTES);
    const many = Array.from({ length: 22 }, (_, i) => candidate(`.cursor/rules/r${String(i).padStart(2, "0")}.mdc`, big));
    const result = await ws.add(many);
    expect(result.overLimit).toBe(true);
    expect(ws.usableBytes).toBeLessThanOrEqual(MAX_RUN_BYTES);
    expect(ws.usable).toBe(20);
    expect(ws.addText("CLAUDE.md", big)).toEqual({ replaced: false, overLimit: true });
    expect(ws.rows.some((r) => r.path === "CLAUDE.md")).toBe(false);
    expect(ALERTS.tooBig).toEqual({ title: "That would pass 5 MiB in all.", body: "Remove some files first." });
  });

  it("rejects binary, NUL and invalid UTF-8 as 'not UTF-8 text'", async () => {
    const ws = new Workspace();
    await ws.add([
      candidate("CLAUDE.md", new Uint8Array([0x23, 0, 0x41])),
      candidate("AGENTS.md", new Uint8Array([0xff, 0xfe, 0x41])),
      candidate(".cursorrules", new Uint8Array([0xc3, 0x28])),
    ]);
    expect(ws.rows.map((r) => r.skip)).toEqual(["not UTF-8 text", "not UTF-8 text", "not UTF-8 text"]);
    expect(ws.usable).toBe(0);
  });

  it("reports a file the browser could not read", async () => {
    const ws = new Workspace();
    await ws.add([{ path: "CLAUDE.md", size: 10, direct: true, read: async () => { throw new Error("denied"); } }]);
    expect(ws.rows[0]?.skip).toBe("couldn’t be read");
  });

  it("names the line of invalid JSON in settings and .mcp.json", async () => {
    const ws = new Workspace();
    await ws.add([candidate(".claude/settings.json", '{\n  "model": "opus",\n  "env": {\n    "a": 1,\n  }\n}'), candidate(".mcp.json", '{"mcpServers": {}')]);
    expect(ws.rows.find((r) => r.path === ".claude/settings.json")?.skip).toBe("invalid JSON, line 5");
    expect(ws.rows.find((r) => r.path === ".mcp.json")?.skip).toBe("invalid JSON, line 1");
    expect(jsonErrorLine('{"a": 1}')).toBeNull();
    expect(jsonErrorLine('{\n"a": 1,\n"b": tru\n}')).toBe(3);
  });

  it("skips a SKILL.md whose frontmatter can't be read", async () => {
    const ws = new Workspace();
    await ws.add([candidate(".claude/skills/x/SKILL.md", "---\nname: x\nno closing rule\n"), candidate(".claude/skills/y/SKILL.md", "---\nname: y\ndescription: ok\n---\nbody\n")]);
    expect(ws.rows.find((r) => r.path.includes("/x/"))?.skip).toBe("frontmatter unreadable");
    expect(ws.rows.find((r) => r.path.includes("/y/"))?.skip).toBeUndefined();
    expect(ws.usable).toBe(1);
  });

  it("checks pasted path and contents as field errors", () => {
    const ws = new Workspace();
    expect(ws.addText("  ", "text")).toEqual({ error: "path" });
    expect(ws.addText("CLAUDE.md", "  \n ")).toEqual({ error: "text" });
    for (const bad of ["/etc/passwd", "../CLAUDE.md", "~/CLAUDE.md", "C:\\x\\CLAUDE.md", "a/../b"]) expect(ws.addText(bad, "x")).toEqual({ error: "path" });
    expect(ws.rows).toHaveLength(0);
  });

  it("replaces a file added twice under the same path", () => {
    const ws = new Workspace();
    expect(ws.addText("CLAUDE.md", "- one\n")).toEqual({ replaced: false, overLimit: false });
    expect(ws.addText("./CLAUDE.md", "- two\n")).toEqual({ replaced: true, overLimit: false });
    expect(ws.rows).toHaveLength(1);
  });

  it("summarises skips: partial, all, and none", () => {
    expect(skipSummary(5, 3)).toEqual({ title: "2 of 5 files skipped.", body: "The reason is next to each one. The poster will use the other 3." });
    expect(skipSummary(5, 1)).toEqual({ title: "4 of 5 files skipped.", body: "The reason is next to each one. The poster will use the other." });
    expect(ALERTS.nothing).toEqual({ title: "Nothing to render yet.", body: "Drop your repo folder, or try the sample setup." });
    expect(skipSummary(5, 0)).toEqual({
      title: "None of these 5 files can be used.",
      body: "The reason is next to each one. Remove them, then add CLAUDE.md, AGENTS.md, a rule, a skill or a settings file.",
    });
    expect(skipSummary(3, 3)).toBeNull();
  });

  it("keeps the copy of statuses and counts to the spec", () => {
    expect(STATUS.ready(3)).toBe("3 files ready.");
    expect(STATUS.done(13, 13)).toBe("Rendered 13 files.");
    expect(STATUS.done(3, 5)).toBe("Rendered 3 of 5 files. 2 skipped.");
    expect(STATUS.saved("everyturn.png")).toBe("Saved everyturn.png.");
    expect(formatSize(780)).toBe("780 B");
    expect(formatSize(Math.round(402.3 * 1024))).toBe("402.3 KiB");
    const ws = new Workspace();
    ws.addText("CLAUDE.md", "- a\n");
    expect(countLabel(ws)).toBe("1 file · 4 bytes");
  });

  it("normalizes logical paths: relative only, forward slashes", () => {
    expect(normalizePath("docs\\rules\\a.md")).toBe("docs/rules/a.md");
    expect(normalizePath("//x")).toBeNull();
  });
});

describe("imports and sources", () => {
  it("reads a non-instruction file from a folder drop only when CLAUDE.md @imports it", async () => {
    const ws = new Workspace();
    await ws.add([candidate("CLAUDE.md", "See @docs/style.md\n", false), candidate("docs/style.md", "- Always use tabs.\n", false), candidate("docs/other.md", "- never read\n", false)]);
    const prepared = await ws.prepare();
    expect(prepared.imported.map((f) => f.path)).toEqual(["docs/style.md"]);
  });

  it("emits JSON that is exactly the report", async () => {
    const web = await sampleAnalysis();
    expect(JSON.parse(reportJson(web.report))).toEqual(JSON.parse(JSON.stringify(web.report)));
    expect(reportJson(web.report).endsWith("}\n")).toBe(true);
  });
});

describe("repository limits stay equal to the CLI's", () => {
  it("has the same file and run caps as discovery", () => {
    expect(MAX_FILE_BYTES).toBe(CLI_FILE);
    expect(MAX_RUN_BYTES).toBe(CLI_RUN);
  });
  it("ships no test fixtures from the corpus in the sample", async () => {
    expect((await readdir("fixtures")).sort()).toContain("corpus");
  });
});
