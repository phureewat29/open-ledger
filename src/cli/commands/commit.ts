import type Database from "libsql";
import {
  commitLinkedTransactions,
  commitTransaction,
  type TransactionCommitContext,
  type RawTransactionInput,
  type LinkedTransactionHeader,
  type LinkedTransactionLeg,
} from "../../ingest/commit.js";
import { EXIT, asRecord, currentMode, emit, emitObject, emitSummary, fail, readStdinBatch } from "../output.js";
import { openDb } from "../db.js";
import { newBatchId } from "../../lib/ids.js";
import { errorMessage } from "../../lib/result.js";
import { findFileById } from "../../db/queries/files.js";
import * as z from "zod";
import { safeParse, str, num, json } from "../../lib/validate.js";
import type { MerchantUpsertInput } from "../../db/queries/merchants.js";

interface CommitIngestOpts {
  file?: string;
  input?: string;
}

// validateRawTransaction is the validity authority: missing fields default to "" and surface as dirty_input.
// amount is excluded so its raw type reaches the validator's typeof check, unconverted by num().
const LINKED_HEADER_SPEC = z.object({
  date: str().default(""),
  description: str().default(""),
  raw_descriptor: str().nullable().default(null),
  source_page: num().nullable().default(null),
  merchant: json<MerchantUpsertInput>().nullable().default(null),
  merchant_id: str().nullable().default(null),
  group_id: str().nullable().default(null),
  row_index: num().nullable().default(null),
});

const LINKED_LEG_SPEC = z.object({
  debit_account_id: str().default(""),
  credit_account_id: str().default(""),
  currency: str().nullable().default(null),
  description: str().optional(),
});

const STANDALONE_SPEC = z.object({
  id: str().optional(),
  date: str().default(""),
  description: str().default(""),
  raw_descriptor: str().nullable().default(null),
  source_page: num().nullable().default(null),
  row_index: num().nullable().default(null),
  merchant: json<MerchantUpsertInput>().nullable().default(null),
  merchant_id: str().nullable().default(null),
  debit_account_id: str().default(""),
  credit_account_id: str().default(""),
  currency: str().nullable().default(null),
});

// debit/credit accept a snake_case synonym that isn't the camelCase auto-bridge.
const LEG_ALIASES = {
  debit_account_id: ["debit_account"],
  credit_account_id: ["credit_account"],
};

interface Counters {
  posted: number;
  duplicates: number;
  failed: number;
  raisedTotal: number;
}

interface RowContext {
  record: Record<string, unknown>;
  index: number;
  fileId: string | null;
  ctx: TransactionCommitContext;
}

// A pre-pipeline reject (bad JSON shape) never throws: it reuses the per-row failure shape.
function failRow(counters: Counters, index: number, message: string): Record<string, unknown> {
  return failOutcome(counters, index, { reason: "dirty_input", message, raisedQuestions: 0 });
}

function failOutcome(
  counters: Counters,
  index: number,
  outcome: { reason: string; message: string; raisedQuestions: number; unopenedLedger?: string },
): Record<string, unknown> {
  counters.failed++;
  return {
    type: "result",
    index,
    ok: false,
    reason: outcome.reason,
    message: outcome.message,
    raised_questions: outcome.raisedQuestions,
    // Typed marker for the currency_mismatch repair (open the named ledger), so agents branch on it, not prose.
    ...(outcome.unopenedLedger ? { unopened_ledger: outcome.unopenedLedger } : {}),
  };
}

// Legs commit atomically under one group id.
function commitCompoundRow(
  db: Database.Database,
  counters: Counters,
  row: RowContext,
  linked: unknown[],
): Record<string, unknown> {
  const parsedHeader = safeParse(LINKED_HEADER_SPEC, row.record);
  if (!parsedHeader.ok) return failRow(counters, row.index, parsedHeader.error);
  const header: LinkedTransactionHeader = { ...parsedHeader.value, source_file_id: row.fileId };

  const legs: LinkedTransactionLeg[] = [];
  let legError: string | undefined;
  for (const rawLeg of linked) {
    const legRecord = asRecord(rawLeg);
    if (!legRecord) {
      legError = "each linked leg must be a JSON object.";
      break;
    }
    const parsedLeg = safeParse(LINKED_LEG_SPEC, legRecord, { aliases: LEG_ALIASES });
    if (!parsedLeg.ok) {
      legError = parsedLeg.error;
      break;
    }
    // Cast is a lie for malformed rows: validateRawTransaction rejects those.
    legs.push({ ...parsedLeg.value, amount: legRecord.amount as number });
  }
  if (legError !== undefined) return failRow(counters, row.index, legError);

  const outcome = commitLinkedTransactions(db, row.ctx, header, legs);
  counters.raisedTotal += outcome.raisedQuestions;
  if (!outcome.ok) return failOutcome(counters, row.index, outcome);

  const allDuplicate = outcome.results.every((r) => r.duplicate);
  if (allDuplicate) counters.duplicates++;
  else counters.posted++;

  return {
    type: "result",
    index: row.index,
    ok: true,
    group_id: outcome.group_id,
    legs: outcome.results.map((r) => ({ transaction_id: r.id, duplicate: r.duplicate })),
    duplicate: allDuplicate,
    currency_overridden: outcome.currencyOverridden,
    raised_questions: outcome.raisedQuestions,
    merchant: outcome.merchant,
  };
}

function commitStandaloneRow(
  db: Database.Database,
  counters: Counters,
  row: RowContext,
): Record<string, unknown> {
  const parsed = safeParse(STANDALONE_SPEC, row.record, { aliases: LEG_ALIASES });
  if (!parsed.ok) return failRow(counters, row.index, parsed.error);
  // Cast is a lie for malformed rows: validateRawTransaction rejects those.
  const raw: RawTransactionInput = {
    ...parsed.value,
    source_file_id: row.fileId,
    amount: row.record.amount as number,
  };

  const outcome = commitTransaction(db, row.ctx, raw);
  counters.raisedTotal += outcome.raisedQuestions;
  if (!outcome.ok) return failOutcome(counters, row.index, outcome);

  if (outcome.duplicate) counters.duplicates++;
  else counters.posted++;

  return {
    type: "result",
    index: row.index,
    ok: true,
    transaction_id: outcome.transactionId,
    duplicate: outcome.duplicate,
    currency_overridden: outcome.currencyOverridden,
    raised_questions: outcome.raisedQuestions,
    merchant: outcome.merchant,
    sides: outcome.sides,
  };
}

interface BatchContext {
  batchId: string;
  /** The `--file` id every row inherits unless it names its own. */
  file?: string;
  fileHashes: Map<string, string | null>;
}

// file_hash is what makes transaction ids deterministic, and dedup relies on that.
// Caching is sound because a commit writes transactions, never `files`.
function fileHashOf(db: Database.Database, batch: BatchContext, fileId: string): string | null {
  const seen = batch.fileHashes.get(fileId);
  // A missing file caches as null, which `get` cannot tell from an absent key.
  if (seen !== undefined) return seen;
  const hash = findFileById(db, fileId)?.file_hash ?? null;
  batch.fileHashes.set(fileId, hash);
  return hash;
}

function commitRow(
  db: Database.Database,
  counters: Counters,
  batch: BatchContext,
  item: unknown,
  index: number,
): Record<string, unknown> {
  const record = asRecord(item);
  if (!record) return failRow(counters, index, "each transaction must be a JSON object.");

  const fileId = ((record.source_file_id as string | null | undefined) ?? batch.file) ?? null;
  const fileHash = fileId ? fileHashOf(db, batch, fileId) : null;
  const row: RowContext = {
    record,
    index,
    fileId,
    ctx: { batchId: batch.batchId, fileId, fileHash },
  };

  const linked = record.linked;
  if (Array.isArray(linked) && linked.length > 0) {
    return commitCompoundRow(db, counters, row, linked);
  }
  return commitStandaloneRow(db, counters, row);
}

export async function commitIngest(opts: CommitIngestOpts): Promise<void> {
  const items = await readStdinBatch(opts.input);
  if (items.length === 0) fail("USAGE", "no transaction data provided");

  const db = await openDb();

  // An unknown --file id must fail before insert, else a null file hash breaks id determinism.
  if (opts.file && !findFileById(db, opts.file)) {
    fail("NOT_FOUND", `no ingest entry: ${opts.file}`, {
      hint: "run `oled ingest list --json` for the file ids, or drop --file to commit rows with no source file",
    });
  }

  // Must be non-null: raise() no-ops when batchId is null, silently dropping every question.
  const batchId = newBatchId();
  const counters: Counters = { posted: 0, duplicates: 0, failed: 0, raisedTotal: 0 };
  const results: Record<string, unknown>[] = [];

  const batch: BatchContext = { batchId, file: opts.file, fileHashes: new Map() };

  for (let index = 0; index < items.length; index++) {
    try {
      results.push(commitRow(db, counters, batch, items[index], index));
    } catch (err) {
      // A throw belongs to its own row, not the batch. Reason stays `unexpected_error`
      // (not `dirty_input`): unknown whether the row or the database was at fault.
      results.push(
        failOutcome(counters, index, {
          reason: "unexpected_error",
          message: errorMessage(err),
          raisedQuestions: 0,
        }),
      );
    }
  }

  const mode = currentMode();
  if (mode.json) {
    for (const r of results) emit(r);
    emitSummary({
      batch_id: batchId,
      posted: counters.posted,
      duplicates: counters.duplicates,
      failed: counters.failed,
      raised_questions: counters.raisedTotal,
    });
  } else {
    for (const r of results) emitObject(r);
    process.stdout.write(
      `\nbatch ${batchId}: ${counters.posted} posted, ${counters.duplicates} duplicate(s), ${counters.failed} failed, ${counters.raisedTotal} question(s) raised\n`,
    );
  }

  // Exit 7 only for genuine failures: duplicates are a successful no-op.
  if (counters.failed > 0) process.exitCode = EXIT.PARTIAL;
}
