import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Read from disk (unlike pdf.ts's code-built fixtures) so image-input paths are exercised against a real file. 16x16 RGB, 112 bytes. */
export function samplePng(): Buffer {
  return readFileSync(fileURLToPath(new URL("sample.png", import.meta.url)));
}
