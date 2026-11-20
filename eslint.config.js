import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/out/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Text sanitising code matches BOMs, zero-width and control characters on purpose.
  { rules: { "no-irregular-whitespace": ["error", { skipRegExps: true, skipStrings: true, skipComments: true, skipTemplates: true }], "no-control-regex": "off" } },
  { files: ["apps/web/**/*.ts"], languageOptions: { globals: globals.browser } },
  { files: ["packages/cli/**/*.ts", "scripts/**/*.mjs", "*.js", "apps/web/vite.config.ts", "vitest.config.ts", "**/test/**/*.ts"], languageOptions: { globals: globals.node } },
);
