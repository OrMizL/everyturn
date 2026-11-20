/// <reference types="vite/client" />
/** Bundled file bytes as base64 (see bytes-plugin.ts). */
declare module "*?bytes" {
  const base64: string;
  export default base64;
}
/** The synthetic sample repo: relative path to text (see bytes-plugin.ts). */
declare module "virtual:demo-repo" {
  const files: Record<string, string>;
  export default files;
}
