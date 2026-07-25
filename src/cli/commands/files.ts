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
 * `files`: browse ingested files, inspect one with its transaction/question
 * counts, and drop one (cascade-removing its rows).
 */

// Erased type query: derives the file row shape from the (lazily imported)
// query without pulling the db module onto the startup path.
type FileRow = ReturnType<typeof import("../../db/queries/files.js").listFiles>[number];

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
  const db = await openDb();
  const { listFiles: queryFiles } = await import("../../db/queries/files.js");
  let rows = queryFiles(db);
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  emitList(rows, FILE_COLUMNS);
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
  emitObject({
    file_id: id,
    removed_transactions: res.removedTransactions,
    removed_questions: res.removedQuestions,
  });
}

export function registerFiles(program: Command): void {
  const files = program.command("files").description("Browse ingested files (list / show / drop)");

  files
    .command("list")
    .description("List ingested files")
    .option("--status <status>", "filter by status (new|pending|ingested|failed)")
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
