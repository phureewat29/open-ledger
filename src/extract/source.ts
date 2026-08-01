import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { tryExecute } from "../lib/result.js";

export type SourceKind = "pdf" | "image";

/** `mime` is what `files.mime` records. */
export const SOURCES: Record<string, { kind: SourceKind; mime: string }> = {
  ".pdf": { kind: "pdf", mime: "application/pdf" },
  ".png": { kind: "image", mime: "image/png" },
  ".jpg": { kind: "image", mime: "image/jpeg" },
  ".jpeg": { kind: "image", mime: "image/jpeg" },
  ".webp": { kind: "image", mime: "image/webp" },
};

export const SUPPORTED_EXTS = Object.keys(SOURCES);

export const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

// Some producers emit a preamble before the header, so the marker is searched, not at offset 0.
const PDF_SNIFF_BYTES = 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const SIGNATURES: { kind: SourceKind; mime: string; matches: (bytes: Buffer) => boolean }[] = [
  {
    kind: "pdf",
    mime: "application/pdf",
    matches: (bytes) => bytes.subarray(0, PDF_SNIFF_BYTES).toString("latin1").includes("%PDF-"),
  },
  { kind: "image", mime: "image/png", matches: (bytes) => bytes.subarray(0, 8).equals(PNG_MAGIC) },
  { kind: "image", mime: "image/jpeg", matches: (bytes) => bytes.subarray(0, 3).equals(JPEG_MAGIC) },
  {
    kind: "image",
    mime: "image/webp",
    matches: (bytes) =>
      bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      bytes.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

export function sniffSource(bytes: Buffer): { kind: SourceKind; mime: string } | null {
  const hit = SIGNATURES.find((signature) => signature.matches(bytes));
  return hit ? { kind: hit.kind, mime: hit.mime } : null;
}

export interface LoadedSource {
  path: string;
  kind: SourceKind;
  mime: string;
  bytes: Buffer;
  /** sha256 of the on-disk bytes, still encrypted for a password-protected PDF, so a re-ingest dedups before unlock. */
  hash: string;
}

type LoadOutcome =
  | { ok: true; value: LoadedSource }
  | {
      ok: false;
      reason: "unsupported_extension" | "kind_mismatch" | "too_large" | "unreadable";
      message: string;
    };

/** Extension and magic bytes must agree; a mismatch fails here, not deep in mupdf or the OCR endpoint. */
export function loadSource(path: string): LoadOutcome {
  const ext = extname(path).toLowerCase();
  const declared = SOURCES[ext];
  if (!declared) {
    return {
      ok: false,
      reason: "unsupported_extension",
      message: `unsupported extension ${ext || basename(path)} (accepted: ${SUPPORTED_EXTS.join(" ")})`,
    };
  }

  // Size is checked before the read so an oversized file is never pulled into memory.
  const stat = tryExecute(() => statSync(path));
  if (!stat.ok) return { ok: false, reason: "unreadable", message: stat.error };
  if (stat.value.size > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      message: `${stat.value.size} bytes exceeds the ${MAX_SOURCE_BYTES}-byte limit`,
    };
  }

  const read = tryExecute(() => readFileSync(path));
  if (!read.ok) return { ok: false, reason: "unreadable", message: read.error };
  const bytes = read.value;

  const sniffed = sniffSource(bytes);
  if (!sniffed || sniffed.mime !== declared.mime) {
    return {
      ok: false,
      reason: "kind_mismatch",
      message: `${ext} file holds ${sniffed?.mime ?? "unrecognized"} bytes`,
    };
  }

  return {
    ok: true,
    value: {
      path,
      kind: declared.kind,
      mime: declared.mime,
      bytes,
      hash: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
