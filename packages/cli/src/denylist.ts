import { readFile } from "node:fs/promises";

const MAX_DENYLIST_BYTES = 1024 * 1024;

/** One term per line; `#` comment lines and blank lines are ignored. */
export function parseDenylist(text: string): string[] {
  return text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

/** Read a UTF-8 denylist file. Errors never include the path or contents. */
export async function readDenylistFile(path: string): Promise<string[]> {
  try {
    const buf = await readFile(path);
    if (buf.length > MAX_DENYLIST_BYTES) throw new Error();
    return parseDenylist(new TextDecoder("utf-8", { fatal: true }).decode(buf));
  } catch {
    throw new Error("Cannot read denylist file (missing, unreadable, too large, or not UTF-8)");
  }
}
