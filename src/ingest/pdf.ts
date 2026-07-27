import { readFileSync, statSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { basename, extname } from "path";
import type Database from "libsql";
import { config } from "../config.js";
import { encryptSecret, decryptSecret } from "../db/encryption.js";

type Mupdf = typeof import("mupdf");
let mupdfPromise: Promise<Mupdf> | null = null;

// Lazy: WASM module isn't loaded until first call.
function getMupdf(): Promise<Mupdf> {
  if (!mupdfPromise) mupdfPromise = import("mupdf");
  return mupdfPromise;
}

// mupdf's authenticatePassword returns 0 on a wrong password, non-zero on success.
const MUPDF_AUTH_FAILED = 0;

type UnlockResult =
  | { ok: true; decrypted: Buffer }
  | { ok: false; reason: "unsupported_document" | "wrong_password" };

export async function isEncrypted(bytes: Buffer): Promise<boolean> {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    return doc.needsPassword();
  } finally {
    doc.destroy();
  }
}

async function unlock(
  bytes: Buffer,
  password: string,
): Promise<UnlockResult> {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    if (!(doc instanceof mupdf.PDFDocument)) {
      return { ok: false, reason: "unsupported_document" };
    }
    if (!doc.needsPassword()) {
      return { ok: true, decrypted: bytes };
    }
    const result = doc.authenticatePassword(password);
    if (result === MUPDF_AUTH_FAILED) {
      return { ok: false, reason: "wrong_password" };
    }
    const out = doc.saveToBuffer("decrypt");
    return { ok: true, decrypted: Buffer.from(out.asUint8Array()) };
  } finally {
    doc.destroy();
  }
}

// Password store: filename-pattern keyed, encrypted-at-rest.

interface StoredPassword {
  id: string;
  pattern: string;
  password: string; // decrypted in-memory
  useCount: number;
  lastUsedAt: string | null;
}

interface PasswordRow {
  id: string;
  pattern: string;
  password_encrypted: string;
  use_count: number;
  last_used_at: string | null;
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const SEPARATORS = /[_\-\s.]/;
const MIN_PREFIX_LEN = 3;

// Short or non-alpha prefixes fall back to escaped+digit-collapse to avoid `^a.*`-style false positives.
function suggestPattern(filename: string): string {
  const name = basename(filename).toLowerCase();
  const prefix = name.split(SEPARATORS)[0];

  if (prefix.length >= MIN_PREFIX_LEN && /^[a-z]/.test(prefix)) {
    return `^${prefix.replace(REGEX_META, "\\$&")}.*`;
  }

  const escaped = name.replace(REGEX_META, "\\$&");
  const collapsed = escaped.replace(/\d+/g, "\\d+");
  return `^${collapsed}$`;
}

export function findCandidates(
  db: Database.Database,
  filePath: string,
  dbKey: string,
): StoredPassword[] {
  const target = basename(filePath);
  const rows = db
    .prepare(
      `SELECT id, pattern, password_encrypted, use_count, last_used_at
       FROM file_passwords
       ORDER BY use_count DESC, last_used_at DESC NULLS LAST, created_at ASC`,
    )
    .all() as PasswordRow[];
  return rows
    .filter((r) => safeTest(r.pattern, target))
    .map((r) => ({
      id: r.id,
      pattern: r.pattern,
      password: decryptSecret(r.password_encrypted, dbKey),
      useCount: r.use_count,
      lastUsedAt: r.last_used_at,
    }));
}

function safeTest(pattern: string, target: string): boolean {
  try {
    return new RegExp(pattern, "i").test(target);
  } catch {
    return false;
  }
}

/** Replaces on conflict, so a bank's rotated password overwrites the stale one. */
export function savePassword(
  db: Database.Database,
  pattern: string,
  password: string,
  dbKey: string,
): string {
  const encrypted = encryptSecret(password, dbKey);
  const existing = db
    .prepare(`SELECT id FROM file_passwords WHERE pattern = ?`)
    .get(pattern) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE file_passwords
       SET password_encrypted = ?, use_count = 0, last_used_at = NULL
       WHERE id = ?`,
    ).run(encrypted, existing.id);
    return existing.id;
  }
  const id = `fp:${randomUUID()}`;
  db.prepare(
    `INSERT INTO file_passwords (id, pattern, password_encrypted) VALUES (?, ?, ?)`,
  ).run(id, pattern, encrypted);
  return id;
}

function recordUse(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE file_passwords
     SET use_count = use_count + 1, last_used_at = datetime('now')
     WHERE id = ?`,
  ).run(id);
}

/**
 * Non-interactive unlock for the agent-CLI harness: no prompts, no spinners.
 * Probe → vault candidates → caller-supplied password → typed failure.
 */
type UnlockNonInteractiveResult =
  | { ok: true; decrypted: Buffer }
  | { ok: false; reason: "password_required" | "wrong_password" };

export async function unlockNonInteractive(
  db: Database.Database,
  bytes: Buffer,
  filename: string,
  opts: { password?: string },
): Promise<UnlockNonInteractiveResult> {
  if (!(await isEncrypted(bytes))) {
    return { ok: true, decrypted: bytes };
  }

  for (const cand of findCandidates(db, filename, config.dbEncryptionKey)) {
    const result = await unlock(bytes, cand.password);
    if (result.ok) {
      recordUse(db, cand.id);
      return { ok: true, decrypted: result.decrypted };
    }
  }

  const password = opts.password ?? "";
  if (!password) return { ok: false, reason: "password_required" };

  const result = await unlock(bytes, password);
  if (!result.ok) {
    return { ok: false, reason: "wrong_password" };
  }
  savePassword(db, suggestPattern(filename), password, config.dbEncryptionKey);
  return { ok: true, decrypted: result.decrypted };
}

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
};

const MAX_BYTES = 30 * 1024 * 1024;

interface LoadedFile {
  bytes: Buffer;
  hash: string;
  mime: string;
  fileName: string;
}

/** Hash is sha256 of the on-disk (still-encrypted, if pw-protected) bytes, so re-ingests dedup before unlock. */
export function readPdf(path: string): LoadedFile {
  const ext = extname(path).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(
      `Unsupported file extension: ${ext}. OpenLedger v1 only ingests PDFs.`,
    );
  }
  const stat = statSync(path);
  if (stat.size > MAX_BYTES) {
    throw new Error(
      `File too large (${stat.size} bytes). Limit is ${MAX_BYTES} bytes.`,
    );
  }
  const bytes = readFileSync(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { bytes, hash, mime, fileName: basename(path) };
}

// Page rasterize: PDF → PNG for VL providers that don't accept documents.

// Readable to a VL model without blowing up the token bill on a dense statement.
const DEFAULT_DPI = 150;

export async function rasterizePageN(
  bytes: Buffer,
  pageIndex: number,
  dpi: number = DEFAULT_DPI,
): Promise<Buffer> {
  const mupdf = await getMupdf();
  const scale = dpi / 72;

  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const page = doc.loadPage(pageIndex);
    try {
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
      );
      try {
        return Buffer.from(pixmap.asPNG());
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

export async function countPdfPages(bytes: Buffer): Promise<number> {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    return doc.countPages();
  } finally {
    doc.destroy();
  }
}
