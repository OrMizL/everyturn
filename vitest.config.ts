import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { bytesImports, demoRepoModule } from "./apps/web/bytes-plugin";
export default defineConfig({
  // The web page's two build-time virtual modules (the bundled sample, `?bytes` files) work in tests exactly as in the build.
  // (cast: apps/web builds with vite 6 and vitest brings vite 7; the plugin API used here is the same in both)
  plugins: [bytesImports(), demoRepoModule()] as never,
  resolve: { alias: { "@everyturn/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) } },
  test: { include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"] },
});
