#!/usr/bin/env node
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { AGENTS, buildPosterModel, buildReport, compileDenylist, poster, posterFindings, redact, renderPosterHtml, renderPosterSvg, renderSourcesTableHtml } from "@everyturn/core";
import type { Agent, Denylist, PosterDataset } from "@everyturn/core";
import { readDenylistFile } from "./denylist";
import { discover, inside } from "./discover";

export const CLI_NAME = "everyturn";

/** Set to true by the npm build (packages/cli/build.mjs); undefined when run from the repo sources. */
declare const __EVERYTURN_BUNDLE__: boolean | undefined;
const BUNDLED = typeof __EVERYTURN_BUNDLE__ !== "undefined" && __EVERYTURN_BUNDLE__;
/** The package version, written in by the npm build from package.json; undefined when run from the repo sources. */
declare const __EVERYTURN_VERSION__: string | undefined;
/** The CLI version: the build-time value in the npm build, packages/cli/package.json when run from the repo sources. */
export async function cliVersion(): Promise<string> {
  if (typeof __EVERYTURN_VERSION__ !== "undefined" && __EVERYTURN_VERSION__) return __EVERYTURN_VERSION__;
  return (JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}
export const HELP = `Usage: everyturn [repo] [options]

Makes a poster of the instructions an AI coding agent loads on every turn. Reads the repo (default: the current
directory) and writes the poster and report to a new private directory under your temp folder. Nothing leaves this machine.

Options:
  --agent <name>        claude-code (default), codex, cursor, copilot or windsurf
  --out <dir>           write to <dir>; inside the scanned repo this also needs --allow-out-in-repo
  --allow-out-in-repo   allow --out inside the scanned repo
  --overwrite           replace existing output files
  --include-user        also read your user-level files (such as ~/.claude/CLAUDE.md)
  --deny <term>         black out a private name (repeatable); only the count is printed
  --denylist <file>     black out the names in <file>, one per line
  --findings <on|off>   conflict and duplicate detection (default on)
  --dataset <mode>      auto (default), real, or sample (bundled fixtures only)
  --show-names          show MCP server names and unknown settings keys
  --print-paths         print the output directory (hidden by default)
  -h, --help            show this help
  -v, --version         show the version

Review everyturn.json before sharing; it keeps the redacted text of every source.
`;
/** Fonts: the package's own `assets/fonts` in the npm build (next to `dist/`), the core package's in the repo. */
const fontDir = (family: string) => fileURLToPath(new URL(BUNDLED ? `../assets/fonts/${family}/` : `../../core/assets/fonts/${family}/`, import.meta.url));
/** The six bundled TTFs. */
export const fontFiles = poster.fonts.map((name) => join(fontDir(name.startsWith("Inter") ? "inter" : "jetbrains-mono"), `${name}.ttf`));
const DATASETS = ["auto", "sample", "real"];
/** The bundled fixture roots (inside this repo's fixtures directory). Only these are a "sample setup". The npm package ships no fixtures, so it has none. */
const FIXTURE_ROOTS = BUNDLED ? [] : ["demo-repo", "negative-repo"].map((name) => fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)));
const VALUE_FLAGS = ["--out", "--repo", "--agent", "--dataset", "--denylist", "--deny", "--findings"];
const REPEATABLE_FLAGS = ["--deny"];

/** Resolve existing ancestors as well, so an output symlink cannot bypass containment. */
async function canonicalDestination(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalDestination(parent), basename(path));
  }
}

const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);
const ownedByUs = (info: Stats) => currentUid() === undefined || info.uid === currentUid();
const missing = (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
};

export interface RunEnv {
  home?: string;
  temp?: string;
  /** Stands in for EVERYTURN_DENYLIST (a file path) in tests. Its value is never printed. */
  denylistEnv?: string;
  /** Stands in for XDG_RUNTIME_DIR in tests; when the key is present, the real environment is not consulted. */
  xdgRuntimeDir?: string | undefined;
}

/** Per-uid default parent: $XDG_RUNTIME_DIR/everyturn when that is ours, else <tmp>/everyturn-<uid>. Not created here. */
async function defaultParent(env: RunEnv): Promise<string> {
  const xdg = "xdgRuntimeDir" in env ? env.xdgRuntimeDir : process.env.XDG_RUNTIME_DIR;
  if (xdg && isAbsolute(xdg)) {
    const info = await lstat(xdg).catch(() => null);
    if (info?.isDirectory() && ownedByUs(info)) return join(xdg, "everyturn");
  }
  return join(env.temp ?? tmpdir(), `everyturn-${currentUid() ?? "user"}`);
}

/** Create the parent 0700, then verify it: a real directory (not a symlink) that we own and nobody else can enter. */
async function ensurePrivateParent(parent: string): Promise<void> {
  await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(parent);
  if (!info.isDirectory() || !ownedByUs(info) || (info.mode & 0o077) !== 0) {
    throw new Error("Output parent directory is not private (it must be a real directory owned by you with mode 0700); refusing to write");
  }
}

/** Create the file exclusively without following links; then check the opened file before writing a byte. */
async function writePrivateFile(file: string, content: string | Uint8Array, overwrite: boolean): Promise<void> {
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (overwrite ? 0 : constants.O_EXCL), 0o600);
  } catch {
    throw new Error("Cannot create an output file (it exists, is a link, or is not writable)");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1 || !ownedByUs(info)) throw new Error("Output file is not a private regular file with a single link; refusing to write");
    // Truncate only after the checks: a hard-linked inode must never be emptied.
    if (overwrite) await handle.truncate(0);
    await handle.chmod(0o600);
    await handle.writeFile(content);
  } finally { await handle.close(); }
}

export async function run(argv: string[], env: RunEnv = {}): Promise<number> {
  let denylist: Denylist | undefined;
  try {
    const args = argv.slice();
    if (args.includes("--help") || args.includes("-h")) { console.log(HELP); return 0; }
    if (args.includes("--version") || args.includes("-v")) { console.log(await cliVersion()); return 0; }
    const outIdx = args.indexOf("--out");
    const repoIdx = args.indexOf("--repo");
    for (const flag of VALUE_FLAGS) {
      const index = args.indexOf(flag);
      if (index >= 0 && (!args[index + 1] || args[index + 1]!.startsWith("--"))) throw new Error(`${flag} needs a ${flag.startsWith("--deny") ? "value" : "directory"}`);
      if (index >= 0 && !REPEATABLE_FLAGS.includes(flag) && args.lastIndexOf(flag) !== index) throw new Error(`Supply ${flag} only once`);
    }
    const known = new Set(["--include-user", "--out", "--repo", "--allow-out-in-repo", "--overwrite", "--agent", "--dataset", "--deny", "--denylist", "--show-names", "--print-paths", "--findings"]);
    if (args.some((a) => a.startsWith("--") && !known.has(a))) throw new Error("Unknown option");
    const repos = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1] ?? ""));
    const agentArg = args.includes("--agent") ? args[args.indexOf("--agent") + 1]! : "claude-code";
    if (!(AGENTS as readonly string[]).includes(agentArg)) throw new Error(`--agent must be one of ${AGENTS.join(", ")}`);
    const agent = agentArg as Agent;
    const datasetArg = args.includes("--dataset") ? args[args.indexOf("--dataset") + 1]! : "auto";
    if (!DATASETS.includes(datasetArg)) throw new Error("--dataset must be auto, sample or real");
    const findingsArg = args.includes("--findings") ? args[args.indexOf("--findings") + 1]! : "on";
    if (findingsArg !== "on" && findingsArg !== "off") throw new Error("--findings must be on or off");
    if (repoIdx >= 0) repos.push(args[repoIdx + 1]!);
    if (repos.length > 1) throw new Error("Supply one repo root");
    // Private names: --deny terms, --denylist file, EVERYTURN_DENYLIST file. Only the count is ever printed.
    const terms = args.flatMap((a, i) => (a === "--deny" ? [args[i + 1]!] : []));
    const denyFiles = [args.includes("--denylist") ? args[args.indexOf("--denylist") + 1]! : undefined, env.denylistEnv ?? process.env.EVERYTURN_DENYLIST]
      .filter((p): p is string => !!p);
    for (const file of denyFiles) terms.push(...await readDenylistFile(file));
    denylist = compileDenylist(terms);
    if (denylist.count) console.log(`denylist: ${denylist.count} term${denylist.count === 1 ? "" : "s"}`);
    const { sources, warnings, canonicalRepo } = await discover({ repo: resolve(repos[0] ?? "."), includeUser: args.includes("--include-user"), home: env.home ?? homedir(), denylist });
    // Badge: the bundled fixtures are a sample setup; anything else is a real set, reviewed only if a denylist was loaded.
    const fixtureRoots = await Promise.all(FIXTURE_ROOTS.map((root) => realpath(root).catch(() => null)));
    // A fixture mixed with user-level files (--include-user) is no longer a synthetic set: those files are real.
    const isFixture = fixtureRoots.includes(canonicalRepo) && !sources.some((s) => s.scope === "user");
    if (datasetArg === "sample" && !isFixture) throw new Error("--dataset sample is only for the bundled sample fixtures, without user-level files; this run is not one");
    const dataset: PosterDataset = datasetArg === "sample" || (datasetArg === "auto" && isFixture) ? "SAMPLE SETUP"
      : denylist.count ? "REDACTED REAL SET" : "UNREVIEWED REAL SET";
    if (dataset === "UNREVIEWED REAL SET") console.error("warning: real dataset without a denylist; private names may appear");
    const overwrite = args.includes("--overwrite");
    const printPaths = args.includes("--print-paths");
    const explicitOut = outIdx >= 0 ? await canonicalDestination(resolve(args[outIdx + 1]!)) : undefined;
    // Default: a fresh mkdtemp directory under a per-user private parent. Only the parent's location is checked here.
    const parent = explicitOut ? undefined : await defaultParent(env);
    if (inside(canonicalRepo, explicitOut ?? await canonicalDestination(parent!)) && !(explicitOut && args.includes("--allow-out-in-repo"))) {
      throw new Error("Output inside scanned repo requires explicit --out and --allow-out-in-repo");
    }
    const existingOut = explicitOut ? await stat(explicitOut).catch(missing) : undefined;
    if (existingOut && (!existingOut.isDirectory() || !ownedByUs(existingOut))) throw new Error("Output directory is not a directory owned by you; refusing to write");
    const report = buildReport(sources, {
      denylist, warnings, showNames: args.includes("--show-names"), includeUser: args.includes("--include-user"),
      findings: findingsArg === "on", dataset: dataset === "SAMPLE SETUP" ? "sample" : "real",
    });
    for (const font of fontFiles) if (!(await stat(font).catch(() => null))?.isFile()) throw new Error("Bundled font missing");
    const version = await cliVersion();
    const source = renderPosterSvg(buildPosterModel(report, { agent, dataset, version, denylist, findings: posterFindings(report, agent) }));
    const resvg = new Resvg(source, { font: { loadSystemFonts: false, fontFiles, defaultFontFamily: "Inter" }, fitTo: { mode: "width", value: 1600 } });
    const png = resvg.render().asPng();
    const outlined = resvg.toString();
    const contents: [string, string | Uint8Array][] = [
      ["everyturn.json", JSON.stringify(report, null, 2) + "\n"],
      ["everyturn-sources.html", renderSourcesTableHtml(report)],
      ["everyturn.svg", outlined],
      ["everyturn.source.svg", source],
      ["everyturn.png", png],
      ["everyturn.html", renderPosterHtml(outlined)],
    ];
    // Check every file before writing any. Never follow output-file symlinks or hard links.
    if (explicitOut) {
      for (const [name] of contents) {
        const existing = await lstat(join(explicitOut, name)).catch(missing);
        if (existing && (!overwrite || !existing.isFile() || existing.nlink > 1 || !ownedByUs(existing))) {
          throw new Error("Output already exists; use --overwrite for regular, single-link output files");
        }
      }
    }
    // Secure every directory we create.
    async function secureMkdir(dir: string): Promise<void> {
      if (await lstat(dir).catch(missing)) return;
      await secureMkdir(dirname(dir));
      await mkdir(dir, { mode: 0o700 });
      await chmod(dir, 0o700);
    }
    let output: string;
    if (explicitOut) {
      await secureMkdir(explicitOut);
      if (!(await stat(explicitOut)).isDirectory()) throw new Error("Output directory is not a directory owned by you; refusing to write");
      await chmod(explicitOut, 0o700);
      output = explicitOut;
    } else {
      await ensurePrivateParent(parent!);
      output = await mkdtemp(join(parent!, "run-"));
    }
    for (const [name, content] of contents) await writePrivateFile(join(output, name), content, overwrite);
    console.log(`Inventory across all agents: ${report.totals.sources} sources, ${report.totals.bytes} bytes, ~${report.totals.estTokens} tokens (estimated). Not one live turn.`);
    for (const s of report.sources) console.log(`  ${String(s.estTokens).padStart(6)}  ${s.agent}  ${s.label}${s.represents === "config-summary" ? " (config summary)" : ""}  ${s.logicalPath}`);
    for (const w of report.warnings) console.log(`  warning: ${w}`);
    // The output location is not printed by default: terminal screenshots must not carry paths.
    // --print-paths is the user's explicit request to see the directory on their own terminal: the home directory is shown as `~`
    // (no user name), the denylist and secret rules still apply, and the path rules of exported text do not (it is not exported).
    const home = env.home ?? homedir();
    const shortened = output === home || output.startsWith(`${home}/`) ? `~${output.slice(home.length)}` : output;
    const shownDir = printPaths ? redact(shortened, { denylist, keepPaths: true }) : "<out>";
    for (const [name] of contents) console.log(`wrote ${shownDir}/${name}`);
    console.log("Review everyturn.json before sharing; it keeps the redacted text of every source.");
    if (!printPaths) console.log("output directory not shown; pass --print-paths to print it");
    return 0;
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : "Every Turn failed", { denylist }));
    return 2;
  }
}

const isMain = process.argv[1] && /packages[/\\]cli[/\\]src[/\\]index\.ts$/.test(process.argv[1]);
if (isMain) run(process.argv.slice(2)).then((c) => process.exit(c));
