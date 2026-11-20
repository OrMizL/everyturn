// The bundled synthetic sample: fixtures/demo-repo, imported as text at build time (virtual:demo-repo, see bytes-plugin.ts).
// Only demo-repo goes in (never fixtures/corpus or negative-repo). The scan filters it like a dropped folder.
import files from "virtual:demo-repo";
import type { Candidate } from "./app";

const encoder = new TextEncoder();

/** The sample files as candidates, relative to the sample repo root. Marked `sample`: the workspace is a sample only while every file in it is one. */
export function sampleCandidates(): Candidate[] {
  return Object.keys(files).map((path) => {
    const bytes = encoder.encode(files[path]!);
    return { path, size: bytes.length, read: async () => bytes, direct: false, sample: true };
  });
}
