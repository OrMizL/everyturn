import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { dark, light } from "../../packages/core/src/theme";
import { bytesImports, demoRepoModule, isBytesModule } from "./bytes-plugin";

const root = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("../..", import.meta.url));

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const vars = (theme: Record<string, string>) => Object.entries(theme)
  .filter(([key]) => key !== "font" && key !== "mono")
  .map(([key, value]) => `--${kebab(key)}:${value}`).join(";");

/**
 * One theme token file: packages/core/src/theme.ts owns every colour and font. This plugin writes them into
 * the page CSS as variables at the `@theme-tokens` marker (light by default, dark for the page only).
 */
function themeTokens(): Plugin {
  return {
    name: "everyturn-theme-tokens",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0]!.endsWith("styles.css")) return null;
      const css = `:root{--font:${light.font};--mono:${light.mono};${vars(light)}}\n`
        + `@media (prefers-color-scheme:dark){:root{${vars(dark)}}}`;
      return code.replace("/* @theme-tokens */", css);
    },
  };
}

export default defineConfig({
  root,
  base: "./",
  plugins: [themeTokens(), bytesImports(), demoRepoModule()],
  resolve: { alias: { "@everyturn/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)) } },
  server: { fs: { allow: [repo] } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // The CSP allows only same-origin files (the page's own @font-face fonts): no data: URLs, no inline module-preload polyfill. The resvg
    // wasm and its fonts are not files the page fetches: they are base64 bytes in the `binary` chunk (bytes-plugin.ts), decoded with atob.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    rollupOptions: {
      output: {
        // Same split as the privacy scan's exclusions for sources: the redactor's own pattern code (it contains the very
        // shapes it masks) and third-party code get their own named chunks; the app chunk, HTML and CSS are scanned in full.
        // The bundled wasm/font bytes are base64 literals in `binary`: the privacy scan blanks those literals and scans the rest of the chunk.
        manualChunks(id) {
          if (isBytesModule(id)) return "binary";
          const path = id.split("?")[0]!.replaceAll("\\", "/");
          if (path.endsWith("/packages/core/src/patterns.mjs") || path.endsWith("/packages/core/src/redact.ts")) return "redactor";
          if (path.includes("/node_modules/")) return "vendor";
          return undefined;
        },
      },
    },
  },
});
