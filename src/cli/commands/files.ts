import type { Command } from "commander";
import {
  type Column,
  emitList,
  emitObject,
  emitSummary,
  fail,
  requireYes,
  runAction,
} from "../output.js";
import { openDb } from "../db.js";
import {
  FILE_STATUSES,
  deleteFile,
  findFileById,
  listFiles as queryFiles,
  type FileRow,
  type FileStatus,
} from "../../db/queries/files.js";
import { countTransactionsBySourceFile } from "../../db/queries/transactions.js";
import { countQuestions } from "../../db/queries/questions.js";

const FILE_COLUMNS: Column<FileRow>[] = [
  { header: "Status", value: (r) => r.status },
  { header: "ID", value: (r) => r.id },
  { header: "Source", value: (r) => r.source ?? "-" },
  { header: "Ingested At", value: (r) => r.ingested_at ?? "-" },
  { header: "Path", value: (r) => r.path },
];

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
  const rows = queryFiles(db);
  const shown = status ? rows.filter((r) => r.status === status) : rows;
  emitList(shown, FILE_COLUMNS);
  emitSummary({ total: rows.length, returned: shown.length });
}

async function showFile(id: string): Promise<void> {
  const db = await openDb();
  const row = findFileById(db, id);
  if (!row) fail("NOT_FOUND", `no file: ${id}`);

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
  const res = deleteFile(db, id);
  if (!res.removed) fail("NOT_FOUND", `no file: ${id}`);

  // Same cache purge `ingest done`/`fail` do: nothing can reach the extracted text once the row is gone.
  const { cleanCache } = await import("../../ingest/prepare.js");
  const { removed } = cleanCache(id);
  emitObject({
    file_id: id,
    removed_transactions: res.removedTransactions,
    removed_questions: res.removedQuestions,
    unvoided: res.unvoided,
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
