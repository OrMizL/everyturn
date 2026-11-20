// Entry point of the npm package (`npx everyturn`). The repo runs src/index.ts directly instead.
import { run } from "./index";

run(process.argv.slice(2)).then((code) => process.exit(code));
