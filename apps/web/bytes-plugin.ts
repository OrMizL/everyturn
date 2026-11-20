import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const SUFFIX = "?bytes";
const PREFIX = "\0virtual:bytes/";

const DEMO_ID = "virtual:demo-repo";
const DEMO_DIR = fileURLToPath(new URL("../../fixtures/demo-repo/", import.meta.url));
const walk = (dir: string, rel = ""): string[] => readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((e) => {
  const path = rel ? `${rel}/${e.name}` : e.name;
  if (e.isDirectory()) return e.name === ".git" || e.name === "node_modules" ? [] : walk(dir, path);
  return e.isFile() && !/^\.env/i.test(e.name) ? [path] : [];
});

/**
 * `import files from "virtual:demo-repo"`: the bundled synthetic sample (fixtures/demo-repo and nothing else) as `{ "CLAUDE.md": text, ".claude/settings.json": text }`
 * with keys relative to the sample root, dot files included, `.env*` never. Written here rather than with import.meta.glob so that no path
 * outside the sample root (`../../../fixtures/...`) is written into the bundle.
 */
export function demoRepoModule(): Plugin {
  return {
    name: "everyturn-demo-repo",
    resolveId: (source) => (source === DEMO_ID ? `\0${DEMO_ID}` : null),
    load(id) {
      if (id !== `\0${DEMO_ID}`) return null;
      const files: Record<string, string> = {};
      for (const path of walk(DEMO_DIR)) { this.addWatchFile(join(DEMO_DIR, path)); files[path] = readFileSync(join(DEMO_DIR, path), "utf8"); }
      return `export default ${JSON.stringify(files)};`;
    },
  };
}

/** True for the virtual modules this plugin emits (the build puts them in their own `binary` chunk). */
export const isBytesModule = (id: string): boolean => id.startsWith(PREFIX);

/**
 * `import data from "./file.bin?bytes"` is the file's content as a base64 string, decoded in the page with atob. The renderer's wasm and
 * fonts are bundled this way ("load WASM from preloaded bytes") so the page never has to fetch them and the CSP can say
 * `connect-src 'none'`. No fetch, no data: URL fetch: the bytes are a string literal in a script the page already loaded.
 */
export function bytesImports(): Plugin {
  return {
    name: "everyturn-bytes",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!source.endsWith(SUFFIX)) return null;
      const resolved = await this.resolve(source.slice(0, -SUFFIX.length), importer, { ...options, skipSelf: true });
      return resolved ? PREFIX + resolved.id : null;
    },
    load(id) {
      if (!isBytesModule(id)) return null;
      const file = id.slice(PREFIX.length);
      this.addWatchFile(file);
      return `export default ${JSON.stringify(readFileSync(file).toString("base64"))};`;
    },
  };
}
