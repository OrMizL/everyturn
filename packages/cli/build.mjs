// Builds the npm package (run by `npm pack`/`npm publish` through prepack): dist/everyturn.js (the CLI with @everyturn/core bundled in), assets/fonts (the six TTFs and their licences),
// and copies of the repo's README.md and LICENSE. Only @resvg/resvg-js (a native module) stays an npm dependency.
import { chmod, cp, mkdir, readFile, rm } from "node:fs/promises";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pkg = JSON.parse(await readFile(here("package.json"), "utf8"));
// `--clean` (postpack) removes the build again: dist/ bundles the redactor's own patterns, which the repo's privacy scan excludes only as source.
for (const p of ["dist", "assets", "README.md", "LICENSE"]) await rm(here(p), { recursive: true, force: true });
if (process.argv.includes("--clean")) process.exit(0);
await build({
  entryPoints: [here("src/bin.ts")],
  outfile: here("dist/everyturn.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  external: ["@resvg/resvg-js"],
  define: { __EVERYTURN_BUNDLE__: "true", __EVERYTURN_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  logLevel: "warning",
});
await chmod(here("dist/everyturn.js"), 0o755); // the bin is executable in the tarball too
await mkdir(here("assets"), { recursive: true });
await cp(here("../core/assets/fonts"), here("assets/fonts"), { recursive: true });
await cp(here("../../README.md"), here("README.md"));
await cp(here("../../LICENSE"), here("LICENSE"));
