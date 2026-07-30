import type Database from "libsql";

interface FileTotals {
  ingested: number;
  pending: number;
  failed: number;
}

interface FileRow {
  id: string;
  path: string;
  file_hash: string;
  mime: string;
  status: "pending" | "ingested" | "failed";
  ingested_at: string | null;
  source: string | null;
  error: string | null;
  created_at: string;
}

/** Missing status buckets are filled with 0 so callers get a stable shape without null checks. */
export function countFiles(db: Database.Database): FileTotals {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM files GROUP BY status`)
    .all() as { status: string; n: number }[];

  const totals: FileTotals = { ingested: 0, pending: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === "ingested" || row.status === "pending" || row.status === "failed") {
      totals[row.status] = row.n;
    }
  }
  return totals;
}

const FILE_SELECT = `SELECT id, path, file_hash, mime, status, ingested_at, source, error, created_at
   FROM files`;

export function listFiles(db: Database.Database): FileRow[] {
  return db
    .prepare(`${FILE_SELECT} ORDER BY ingested_at DESC, created_at DESC`)
    .all() as FileRow[];
}

export function findFileById(db: Database.Database, id: string): FileRow | null {
  const row = db.prepare(`${FILE_SELECT} WHERE id = ?`).get(id) as FileRow | undefined;
  return row ?? null;
}

/** The row a file's bytes already registered as; `file_hash` is UNIQUE, so a content match is exactly one row. */
export function findFileByHash(db: Database.Database, hash: string): FileRow | null {
  const row = db.prepare(`${FILE_SELECT} WHERE file_hash = ?`).get(hash) as FileRow | undefined;
  return row ?? null;
}

/** The columns a newly discovered file supplies; the rest are the schema's. */
export interface PendingFileInput {
  id: string;
  path: string;
  file_hash: string;
  mime: string;
}

export function insertPendingFile(db: Database.Database, file: PendingFileInput): void {
  db.prepare(
    `INSERT INTO files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'pending')`,
  ).run(file.id, file.path, file.file_hash, file.mime);
}

/**
 * Delete leads (file_hash is UNIQUE) then re-insert, atomically; the delete cascades away
 * the prior row's transactions and questions (ON DELETE CASCADE).
 */
export function replaceFile(
  db: Database.Database,
  priorId: string,
  file: PendingFileInput,
): void {
  const tx = db.transaction((): void => {
    deleteFile(db, priorId);
    insertPendingFile(db, file);
  });
  tx();
}

interface DeleteFileResult {
  removed: FileRow | null;
  removedTransactions: number;
  removedQuestions: number;
}

/**
 * Cascaded transaction/question counts are gathered before the DELETE runs:
 * CASCADE would make them unrecoverable after.
 */
export function deleteFile(db: Database.Database, id: string): DeleteFileResult {
  const removed = findFileById(db, id);
  if (!removed) {
    return { removed: null, removedTransactions: 0, removedQuestions: 0 };
  }
  const removedTransactions = (db
    .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE source_file_id = ?`)
    .get(id) as { n: number }).n;
  const removedQuestions = (db
    .prepare(`SELECT COUNT(*) AS n FROM questions WHERE file_id = ?`)
    .get(id) as { n: number }).n;
  db.prepare(`DELETE FROM files WHERE id = ?`).run(id);
  return { removed, removedTransactions, removedQuestions };
}

interface MarkFileIngestedOpts {
  /** Who ingested the file (e.g. the external agent name). */
  source?: string | null;
}

interface MarkFileFailedOpts {
  /** Who attempted the ingest (e.g. the external agent name). */
  source?: string | null;
  error: string;
}

export function markFileIngested(
  db: Database.Database,
  fileId: string,
  opts: MarkFileIngestedOpts,
): number {
  return db
    .prepare(
      `UPDATE files SET status = 'ingested', ingested_at = datetime('now'), source = ? WHERE id = ?`,
    )
    .run(opts.source ?? null, fileId).changes;
}

/** ingested_at is left untouched: a failed file was never successfully ingested. */
export function markFileFailed(
  db: Database.Database,
  fileId: string,
  opts: MarkFileFailedOpts,
): number {
  return db
    .prepare(`UPDATE files SET status = 'failed', source = ?, error = ? WHERE id = ?`)
    .run(opts.source ?? null, opts.error, fileId).changes;
}
