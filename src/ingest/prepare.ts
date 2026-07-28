import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type Database from "libsql";
import { config, getCacheDir, getDataDir } from "../config.js";
import {
  findFileByHash,
  findFileById,
  insertPendingFile,
  replaceFile,
  type PendingFileInput,
} from "../db/queries/files.js";
import { extractFile, type Extraction, type TextPage } from "../extract/extract.js";
import { resolveOcr } from "../extract/ocr.js";
import { isEncryptedPdf } from "../extract/pdf.js";
import type { TextLayer } from "../extract/route.js";
import { SOURCES, loadSource, type LoadedSource } from "../extract/source.js";
import { tryExecute, type Result } from "../lib/result.js";
import { findCandidates, unlockNonInteractive } from "./vault.js";

type IngestStatus = "new" | "pending" | "ingested" | "failed" | "unreadable";

export interface IngestEntry {
  path: string;
  /** Forward-slashed relative path from the data dir. */
  relPath: string;
  /** null when the bytes could not be read, so there is nothing to hash. */
  hash: string | null;
  fileId: string | null;
  status: IngestStatus;
  encrypted: boolean;
  vaultCandidates: number;
  note?: string;
}

interface WalkedFile {
  path: string;
  relPath: string;
}

function walk(dir: string, root: string, out: WalkedFile[]): void {
  const entries = tryExecute(() => readdirSync(dir));
  if (!entries.ok) return;

  for (const entry of entries.value) {
    if (entry.startsWith(".")) continue;
    const full = resolve(dir, entry);

    const stat = tryExecute(() => statSync(full));
    if (!stat.ok) continue;

    if (stat.value.isDirectory()) {
      walk(full, root, out);
      continue;
    }
    if (!stat.value.isFile()) continue;
    if (!SOURCES[extname(entry).toLowerCase()]) continue;

    out.push({ path: full, relPath: relative(root, full).split(sep).join("/") });
  }
}

interface Encryption {
  encrypted: boolean;
  vaultCandidates: number;
}

const UNLOCKED: Encryption = { encrypted: false, vaultCandidates: 0 };

/** Only a PDF can be locked, and only a PDF can be unopenable — an image needs neither probe. */
async function encryptionOf(db: Database.Database, source: LoadedSource): Promise<Result<Encryption>> {
  if (source.kind !== "pdf") return { ok: true, value: UNLOCKED };

  const probe = await tryExecute(() => isEncryptedPdf(source.bytes));
  if (!probe.ok) return probe;
  if (!probe.value) return { ok: true, value: UNLOCKED };
  return {
    ok: true,
    value: {
      encrypted: true,
      vaultCandidates: findCandidates(db, source.path, config.dbEncryptionKey).length,
    },
  };
}

function unreadableEntry(file: WalkedFile, note: string): IngestEntry {
  return { ...file, hash: null, fileId: null, status: "unreadable", ...UNLOCKED, note };
}

/**
 * A file this harness can't read becomes an `unreadable` row, rather than
 * sinking the whole listing.
 */
export async function discoverFiles(
  db: Database.Database,
  opts: { regex?: RegExp } = {},
): Promise<IngestEntry[]> {
  const root = getDataDir();
  const walked: WalkedFile[] = [];
  walk(root, root, walked);

  const entries: IngestEntry[] = [];
  for (const file of walked) {
    if (opts.regex && !opts.regex.test(file.relPath)) continue;

    const loaded = loadSource(file.path);
    if (!loaded.ok) {
      entries.push(unreadableEntry(file, loaded.message));
      continue;
    }
    const encryption = await encryptionOf(db, loaded.value);
    if (!encryption.ok) {
      entries.push(unreadableEntry(file, encryption.error));
      continue;
    }

    const known = findFileByHash(db, loaded.value.hash);
    entries.push({
      ...file,
      hash: loaded.value.hash,
      fileId: known?.id ?? null,
      status: known ? known.status : "new",
      ...encryption.value,
    });
  }
  return entries;
}

function newFileId(): string {
  return `sf:${randomUUID()}`;
}

function pendingRow(source: LoadedSource, fileId: string): PendingFileInput {
  return { id: fileId, path: source.path, file_hash: source.hash, mime: source.mime };
}

/** Pending row keyed by content hash, so re-registering the same bytes is a
 *  no-op that returns the existing id. */
export function registerPendingFile(
  db: Database.Database,
  source: LoadedSource,
): { fileId: string; alreadyKnown: boolean } {
  const known = findFileByHash(db, source.hash);
  if (known) return { fileId: known.id, alreadyKnown: true };

  const fileId = newFileId();
  insertPendingFile(db, pendingRow(source, fileId));
  return { fileId, alreadyKnown: false };
}

/** Resolution order: absolute, data-dir-relative, cwd-relative, then `sf:` file id; null if none match. */
export function resolveEntryPath(db: Database.Database, entryOrId: string): string | null {
  if (isAbsolute(entryOrId) && existsSync(entryOrId)) return entryOrId;

  const viaDataDir = resolve(getDataDir(), entryOrId);
  if (existsSync(viaDataDir)) return viaDataDir;

  const viaCwd = resolve(entryOrId);
  if (existsSync(viaCwd)) return viaCwd;

  const byId = findFileById(db, entryOrId);
  if (byId) return byId.path;

  return null;
}

interface PrepareOptions {
  password?: string;
  /** Re-read the bytes and, once that succeeds, replace the prior row — dropping
   *  its transactions, questions, and artifacts. */
  force?: boolean;
  /** Ignore the text layer, for garbled or junk layers. */
  rescan?: boolean;
  /** Ignore the OCR endpoint, and read the page images yourself. */
  noOcr?: boolean;
}

/** Everything that can stop a prepare. The CLI maps each to an exit code and a hint. */
export type PrepareFailure =
  | "not_found"
  | "unsupported_extension"
  | "kind_mismatch"
  | "too_large"
  | "unreadable"
  | "pdf_unreadable"
  | "password_required"
  | "wrong_password"
  | "ocr_unreachable"
  | "ocr_rejected";

interface TextPageChars {
  page: number;
  chars: number;
}

interface ImagePagePath {
  page: number;
  path: string;
}

export type PrepareOutcome =
  | {
      ok: true;
      fileId: string;
      kind: "text";
      source: "text-layer" | "ocr";
      textLayer: TextLayer;
      /** The model that read the pages, on the ocr route only. */
      model?: string;
      pageCount: number;
      /** One file to read, pages separated by `--- page N ---` markers. */
      document: string;
      pages: TextPageChars[];
      /** Pages whose text is a placeholder because the endpoint failed on them. */
      failedPages: number[];
    }
  | {
      ok: true;
      fileId: string;
      kind: "images";
      source: "raster" | "original";
      textLayer: TextLayer;
      pageCount: number;
      /** Present when the pages were rasterized from a PDF. */
      dpi?: number;
      pages: ImagePagePath[];
    }
  | { ok: false; reason: PrepareFailure; message: string };

type PrepareSuccess = Extract<PrepareOutcome, { ok: true }>;

function replaceFileRow(
  db: Database.Database,
  priorId: string,
  source: LoadedSource,
  fileId: string,
): void {
  replaceFile(db, priorId, pendingRow(source, fileId));
  cleanCache(priorId);
}

type UnlockedBytes =
  | { ok: true; bytes: Buffer }
  | {
      ok: false;
      reason: Extract<PrepareFailure, "pdf_unreadable" | "password_required" | "wrong_password">;
      message: string;
    };

const UNLOCK_FAILED: Record<"password_required" | "wrong_password", string> = {
  password_required: "the PDF is locked and no stored password opened it",
  wrong_password: "the supplied password did not open the PDF",
};

/** Images are never locked; decrypted PDF bytes stay in memory — only extracted text is written to disk. */
async function readableBytes(
  db: Database.Database,
  source: LoadedSource,
  password?: string,
): Promise<UnlockedBytes> {
  if (source.kind !== "pdf") return { ok: true, bytes: source.bytes };

  // Passes an already-unlocked source through untouched; throws on bytes mupdf can't open at all.
  const attempt = await tryExecute(() =>
    unlockNonInteractive(db, source.bytes, source.path, { password }),
  );
  if (!attempt.ok) return { ok: false, reason: "pdf_unreadable", message: attempt.error };

  const unlocked = attempt.value;
  if (!unlocked.ok) {
    return { ok: false, reason: unlocked.reason, message: UNLOCK_FAILED[unlocked.reason] };
  }
  return { ok: true, bytes: unlocked.decrypted };
}

const DOCUMENT_FILE = "document.txt";

/** Markers give every row a 1-based page to cite as `source_page`. */
function documentText(pages: TextPage[]): string {
  return `${pages.map((page) => `--- page ${page.page} ---\n${page.text}`).join("\n\n")}\n`;
}

interface WriteTarget {
  fileId: string;
  dir: string;
  /** The input file's own path — what an untouched image page cites. */
  sourcePath: string;
}

/** Rebuilt per prepare, so a prior run's artifacts can never be mistaken for this one's. */
function freshDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeDocument(
  extraction: Extract<Extraction, { kind: "text" }>,
  target: WriteTarget,
): PrepareSuccess {
  freshDir(target.dir);
  const document = resolve(target.dir, DOCUMENT_FILE);
  writeFileSync(document, documentText(extraction.pages), { mode: 0o600 });
  return {
    ok: true,
    fileId: target.fileId,
    kind: "text",
    source: extraction.source,
    textLayer: extraction.textLayer,
    model: extraction.model,
    pageCount: extraction.pages.length,
    document,
    pages: extraction.pages.map((page) => ({ page: page.page, chars: page.text.length })),
    failedPages: extraction.failedPages,
  };
}

function writePages(
  extraction: Extract<Extraction, { kind: "images" }>,
  target: WriteTarget,
): PrepareSuccess {
  const head = {
    ok: true as const,
    fileId: target.fileId,
    kind: "images" as const,
    source: extraction.source,
    textLayer: extraction.textLayer,
    pageCount: extraction.pages.length,
    dpi: extraction.dpi,
  };

  // An untouched image is read where it lies; only a prior run's artifacts could be there to mislead.
  if (extraction.source === "original") {
    rmSync(target.dir, { recursive: true, force: true });
    const pages = extraction.pages.map((page) => ({ page: page.page, path: target.sourcePath }));
    return { ...head, pages };
  }

  freshDir(target.dir);
  const pages: ImagePagePath[] = [];
  for (const page of extraction.pages) {
    const path = resolve(target.dir, `p${page.page}.png`);
    writeFileSync(path, page.bytes, { mode: 0o600 });
    pages.push({ page: page.page, path });
  }
  return { ...head, pages };
}

const WRITE_ARTIFACTS: {
  [K in Extraction["kind"]]: (
    extraction: Extract<Extraction, { kind: K }>,
    target: WriteTarget,
  ) => PrepareSuccess;
} = {
  text: writeDocument,
  images: writePages,
};

/** A failure leaves the ledger exactly as it found it. */
export async function prepareFile(
  db: Database.Database,
  entryOrId: string,
  opts: PrepareOptions = {},
): Promise<PrepareOutcome> {
  const absPath = resolveEntryPath(db, entryOrId);
  if (absPath === null) {
    return { ok: false, reason: "not_found", message: `no ingest entry or file at "${entryOrId}"` };
  }

  const loaded = loadSource(absPath);
  if (!loaded.ok) return { ok: false, reason: loaded.reason, message: loaded.message };
  const source = loaded.value;

  // Every case but --force's swap (see replaceFileRow) registers now: a file
  // that never opens still needs an id for `ingest fail`.
  const prior = opts.force ? findFileByHash(db, source.hash) : null;
  const fileId = prior ? newFileId() : registerPendingFile(db, source).fileId;

  const readable = await readableBytes(db, source, opts.password);
  if (!readable.ok) return readable;

  const extracted = await extractFile(
    { kind: source.kind, mime: source.mime, bytes: readable.bytes, path: source.path },
    { ocr: resolveOcr(), overrides: { rescan: opts.rescan, noOcr: opts.noOcr } },
  );
  if (!extracted.ok) return { ok: false, reason: extracted.reason, message: extracted.message };

  const target: WriteTarget = {
    fileId,
    dir: resolve(getCacheDir(), fileId),
    sourcePath: source.path,
  };
  const written = WRITE_ARTIFACTS[extracted.value.kind](extracted.value as never, target);
  if (prior) replaceFileRow(db, prior.id, source, fileId);
  return written;
}

export function cleanCache(fileId?: string): { removed: string[] } {
  const base = getCacheDir();

  if (fileId) {
    const dir = resolve(base, fileId);
    if (!existsSync(dir)) return { removed: [] };
    rmSync(dir, { recursive: true, force: true });
    return { removed: [dir] };
  }

  if (!existsSync(base)) return { removed: [] };
  const removed = readdirSync(base).map((name) => resolve(base, name));
  rmSync(base, { recursive: true, force: true });
  return { removed };
}
