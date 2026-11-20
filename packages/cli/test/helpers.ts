import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// All test I/O stays in the repo. Only these newly-created temporary trees are removed.
export async function sandbox() {
  const root = await mkdtemp(resolve(".test-work-"));
  const repo = join(root, "repo"), home = join(root, "home"), temp = join(root, "temp");
  for (const path of [repo, home, temp]) await mkdir(path);
  // `xdgRuntimeDir: undefined` keeps runs hermetic: the real XDG_RUNTIME_DIR is never consulted.
  return { root, repo, home, temp, xdgRuntimeDir: undefined as string | undefined, cleanup: () => rm(root, { recursive: true, force: true }) };
}
export async function put(root: string, path: string, text: string | Uint8Array = "rule") {
  const abs = join(root, path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text);
  return abs;
}
export const j = (...parts: string[]) => parts.join("");
