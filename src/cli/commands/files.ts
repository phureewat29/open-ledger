import type { Command } from "commander";
import {
  type Column,
  emitList,
  emitObject,
  fail,
  requireYes,
  runAction,
} from "../output.js";
import { openDb } from "../db.js";

/**
 * Erased type query: derives the file row shape from the lazily-imported
 * query, without pulling the db module onto the startup path.
 */
type FileRow = ReturnType<typeof import("../../db/queries/files.js").listFiles>[number];

const FILE_COLUMNS: Column<FileRow>[] = [
  { header: "Status", value: (r) => r.status },
  { header: "ID", value: (r) => r.id },
  { header: "Source", value: (r) => r.source ?? "-" },
  { header: "Ingested At", value: (r) => r.ingested_at ?? "-" },
  { header: "Path", value: (r) => r.path },
];

/** files.status enum; `new` belongs to `ingest list`, not here: filtering by it here would silently match nothing. */
const FILE_STATUSES = ["pending", "ingested", "failed"] as const;
type FileStatus = (typeof FILE_STATUSES)[number];

interface ListFilesOpts {
  status?: string;
}

async function listFiles(opts: ListFilesOpts): Promise<void> {
  // Checked up front: an unrecognized status would otherwise silently return zero rows.
  const { status } = opts;
  if (status !== undefined && !FILE_STATUSES.includes(status as FileStatus)) {
    fail("USAGE", `--status must be one of ${FILE_STATUSES.join("|")}, got "${status}"`);
  }

  const db = await openDb();
  const { listFiles: queryFiles } = await import("../../db/queries/files.js");
  const rows = queryFiles(db);
  emitList(status ? rows.filter((r) => r.status === status) : rows, FILE_COLUMNS);
}

async function showFile(id: string): Promise<void> {
  const db = await openDb();
  const { findFileById } = await import("../../db/queries/files.js");
  const row = findFileById(db, id);
  if (!row) fail("NOT_FOUND", `no file: ${id}`);

  const { countTransactionsBySourceFile } = await import("../../db/queries/transactions.js");
  const { countQuestions } = await import("../../db/queries/questions.js");
  emitObject({
    type: "file_detail",
    ...row,
    transaction_count: countTransactionsBySourceFile(db, id),
    open_question_count: countQuestions(db, { file_id: id }),
  });
}

interface DropFileOpts {
  yes?: boolean;
}

async function dropFile(id: string, opts: DropFileOpts): Promise<void> {
  requireYes(opts, `dropping file ${id}`);
  const db = await openDb();
  const { deleteFile } = await import("../../db/queries/files.js");
  const res = deleteFile(db, id);
  if (!res.removed) fail("NOT_FOUND", `no file: ${id}`);

  // The extracted text describes a row that no longer exists, and nothing can
  // reach it once the row is gone: same purge `ingest done`/`fail` do.
  const { cleanCache } = await import("../../ingest/prepare.js");
  const { removed } = cleanCache(id);
  emitObject({
    file_id: id,
    removed_transactions: res.removedTransactions,
    removed_questions: res.removedQuestions,
    cache_removed: removed,
  });
}

export function registerFiles(program: Command): void {
  const files = program.command("files").description("Browse ingested files (list / show / drop)");

  files
    .command("list")
    .description("List ingested files")
    .option("--status <status>", `filter by status (${FILE_STATUSES.join("|")})`)
    .action(runAction(listFiles));

  files
    .command("show <id>")
    .description("Show a file with its transaction and open-question counts")
    .action(runAction(showFile));

  files
    .command("drop <id>")
    .description("Drop a file and cascade-remove its transactions/questions")
    .option("--yes", "skip confirmation")
    .action(runAction(dropFile));
}
