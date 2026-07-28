import type Database from "libsql";
import type {
  TransactionCommitContext,
  TransactionCommitHooks,
  TransactionSide,
  RawTransactionInput,
  LinkedTransactionHeader,
  LinkedTransactionLeg,
} from "../../ingest/commit.js";
import { EXIT, asRecord, currentMode, emit, emitObject, emitSummary, fail, readStdinBatch } from "../output.js";
import { openDb } from "../db.js";
import { newBatchId } from "../../lib/ids.js";
import * as z from "zod";
import { safeParse, str, num, json } from "../../lib/validate.js";
import type { MerchantUpsertInput } from "../../db/queries/merchants.js";

interface CommitIngestOpts {
  file?: string;
  input?: string;
}

type SideHow =
  | "exact"
  | "fuzzy_matched"
  | "placeholder_created"
  | "uncategorized_fallback"
  | "as_committed";

type CommitEvent =
  | { kind: "placeholder"; side: TransactionSide; accountId: string }
  | { kind: "fuzzy"; side: TransactionSide; originalId: string; matchedId: string }
  | { kind: "uncategorized"; side: TransactionSide; accountId: string }
  | { kind: "unknown_merchant"; attemptedId: string }
  | { kind: "dirty"; reason: string }
  | { kind: "currency_mismatch" };

// Resolution raises at most one event per side.
type SideEvent = Extract<CommitEvent, { side: TransactionSide }>;

// Delegates to the base hooks (so raise() still fires) while recording a typed event per side.
function makeRecordingHooks(base: TransactionCommitHooks, events: CommitEvent[]): TransactionCommitHooks {
  return {
    onCommitted: (id) => base.onCommitted(id),
    onDirtyInput: (input, reason) => {
      base.onDirtyInput(input, reason);
      events.push({ kind: "dirty", reason });
    },
    onUnknownMerchant: (input, id, attemptedId) => {
      base.onUnknownMerchant(input, id, attemptedId);
      events.push({ kind: "unknown_merchant", attemptedId });
    },
    onPlaceholderAccount: (side, accountId, id) => {
      base.onPlaceholderAccount(side, accountId, id);
      events.push({ kind: "placeholder", side, accountId });
    },
    onUncategorizedFallback: (side, accountId, id) => {
      base.onUncategorizedFallback(side, accountId, id);
      events.push({ kind: "uncategorized", side, accountId });
    },
    onSimilarAccount: (side, originalId, matchedId, id) => {
      base.onSimilarAccount(side, originalId, matchedId, id);
      events.push({ kind: "fuzzy", side, originalId, matchedId });
    },
    onCurrencyMismatch: (input, debit, credit) => {
      base.onCurrencyMismatch(input, debit, credit);
      events.push({ kind: "currency_mismatch" });
    },
  };
}

interface SideResolution {
  resolved: string;
  how: SideHow;
}

// Maps the resolver's own vocabulary (via the hooks) to the reported one.
const SIDE_RESOLUTIONS: {
  [K in SideEvent["kind"]]: (event: Extract<SideEvent, { kind: K }>) => SideResolution;
} = {
  fuzzy: (event) => ({ resolved: event.matchedId, how: "fuzzy_matched" }),
  placeholder: (event) => ({ resolved: event.accountId, how: "placeholder_created" }),
  uncategorized: (event) => ({ resolved: event.accountId, how: "uncategorized_fallback" }),
};

// No event means the side resolved by exact match — every other route raises one.
function classifySide(requested: string, side: TransactionSide, events: CommitEvent[]): SideResolution {
  const event = events.find((e): e is SideEvent => "side" in e && e.side === side);
  if (!event) return { resolved: requested, how: "exact" };
  return SIDE_RESOLUTIONS[event.kind](event as never);
}

interface SideReport extends SideResolution {
  side: TransactionSide;
  requested: string;
}

// A duplicate re-commit fires no hooks and the stored row may have been recategorized
// since, so report its stored accounts instead of re-deriving them.
function reportSides(
  deps: RowCommitDeps,
  outcome: { transactionId: string; duplicate: boolean },
  raw: RawTransactionInput,
  events: CommitEvent[],
): SideReport[] {
  const stored = outcome.duplicate
    ? deps.findTransactionById(deps.db, outcome.transactionId)
    : null;
  if (stored) {
    return [
      { side: "debit", requested: raw.debit_account_id, resolved: stored.debit_account_id, how: "as_committed" },
      { side: "credit", requested: raw.credit_account_id, resolved: stored.credit_account_id, how: "as_committed" },
    ];
  }
  return [
    { side: "debit", requested: raw.debit_account_id, ...classifySide(raw.debit_account_id, "debit", events) },
    { side: "credit", requested: raw.credit_account_id, ...classifySide(raw.credit_account_id, "credit", events) },
  ];
}

function classifyMerchant(
  item: { merchant?: unknown; merchant_id?: unknown },
  events: CommitEvent[],
  resolvedMerchantId: () => string | null | undefined,
): { how: string; merchant_id?: string } {
  const hadMerchant = !!(item.merchant || item.merchant_id);
  if (!hadMerchant) return { how: "none" };
  if (events.some((e) => e.kind === "unknown_merchant")) return { how: "unknown" };
  const mid = resolvedMerchantId();
  return { how: "linked", merchant_id: mid ?? undefined };
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
  code: str().nullable().default(null),
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
  code: str().nullable().default(null),
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

// Passed explicitly (not closed over) so row committers capture no loop-scoped state.
interface RowCommitDeps {
  db: Database.Database;
  commitTransaction: (typeof import("../../ingest/commit.js"))["commitTransaction"];
  commitLinkedTransactions: (typeof import("../../ingest/commit.js"))["commitLinkedTransactions"];
  findTransactionById: (typeof import("../../db/queries/transactions.js"))["findTransactionById"];
  counters: Counters;
}

interface RowContext {
  record: Record<string, unknown>;
  index: number;
  fileId: string | null;
  ctx: TransactionCommitContext;
  events: CommitEvent[];
  hooks: TransactionCommitHooks;
}

// file_hash feeds deterministic transaction-id derivation elsewhere; memoized per file id.
function makeFileHashCache(
  db: Database.Database,
  findFileById: (typeof import("../../db/queries/files.js"))["findFileById"],
): (fileId: string | null) => string | null {
  const cache = new Map<string, string | null>();
  return (fileId) => {
    if (!fileId) return null;
    if (!cache.has(fileId)) cache.set(fileId, findFileById(db, fileId)?.file_hash ?? null);
    return cache.get(fileId) ?? null;
  };
}

// A pre-pipeline reject (bad JSON shape) never throws — it reuses the per-row failure shape.
function failRow(counters: Counters, index: number, message: string): Record<string, unknown> {
  return failOutcome(counters, index, { reason: "dirty_input", message, raisedQuestions: 0 });
}

function failOutcome(
  counters: Counters,
  index: number,
  outcome: { reason: string; message: string; raisedQuestions: number },
): Record<string, unknown> {
  counters.failed++;
  return {
    type: "result",
    index,
    ok: false,
    reason: outcome.reason,
    message: outcome.message,
    raised_questions: outcome.raisedQuestions,
  };
}

// Header + >=1 linked legs, committed atomically as one group.
function commitCompoundRow(
  deps: RowCommitDeps,
  row: RowContext,
  linked: unknown[],
): Record<string, unknown> {
  const { counters } = deps;
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
    // Cast is a lie for malformed rows — validateRawTransaction rejects those.
    legs.push({ ...parsedLeg.value, amount: legRecord.amount as number });
  }
  if (legError !== undefined) return failRow(counters, row.index, legError);

  const outcome = deps.commitLinkedTransactions(deps.db, row.ctx, header, legs, row.hooks);
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
    raised_questions: outcome.raisedQuestions,
    merchant: classifyMerchant(parsedHeader.value, row.events, () =>
      deps.findTransactionById(deps.db, outcome.results[0]?.id)?.merchant_id,
    ),
  };
}

function commitStandaloneRow(deps: RowCommitDeps, row: RowContext): Record<string, unknown> {
  const { counters } = deps;
  const parsed = safeParse(STANDALONE_SPEC, row.record, { aliases: LEG_ALIASES });
  if (!parsed.ok) return failRow(counters, row.index, parsed.error);
  // Cast is a lie for malformed rows — validateRawTransaction rejects those.
  const raw: RawTransactionInput = {
    ...parsed.value,
    source_file_id: row.fileId,
    amount: row.record.amount as number,
  };

  const outcome = deps.commitTransaction(deps.db, row.ctx, raw, row.hooks);
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
    raised_questions: outcome.raisedQuestions,
    merchant: classifyMerchant(parsed.value, row.events, () =>
      deps.findTransactionById(deps.db, outcome.transactionId)?.merchant_id,
    ),
    sides: reportSides(deps, outcome, raw, row.events),
  };
}

export async function commitIngest(opts: CommitIngestOpts): Promise<void> {
  const items = await readStdinBatch(opts.input);
  if (items.length === 0) fail("USAGE", "no transaction data provided");

  const db = await openDb();
  const { commitTransaction, commitLinkedTransactions, defaultTransactionCommitHooks } = await import(
    "../../ingest/commit.js"
  );
  const { findTransactionById } = await import("../../db/queries/transactions.js");
  const { findFileById } = await import("../../db/queries/files.js");

  // An unknown --file id must fail before insert: a nulled file hash would break the
  // deterministic transaction ids that dedup relies on.
  if (opts.file && !findFileById(db, opts.file)) {
    fail("NOT_FOUND", `no ingest entry: ${opts.file}`, {
      hint: "run `oled ingest list --json` for the file ids, or drop --file to commit rows with no source file",
    });
  }

  // Must be non-null: raise() no-ops when batchId is null, silently dropping every question.
  const batchId = newBatchId();
  const fileHashFor = makeFileHashCache(db, findFileById);

  const counters: Counters = { posted: 0, duplicates: 0, failed: 0, raisedTotal: 0 };
  const deps: RowCommitDeps = {
    db,
    commitTransaction,
    commitLinkedTransactions,
    findTransactionById,
    counters,
  };

  const results: Record<string, unknown>[] = [];

  for (let index = 0; index < items.length; index++) {
    const record = asRecord(items[index]);
    if (!record) {
      results.push(failRow(counters, index, "each transaction must be a JSON object."));
      continue;
    }

    const fileId = ((record.source_file_id as string | null | undefined) ?? opts.file) ?? null;
    const ctx: TransactionCommitContext = { batchId, fileId, fileHash: fileHashFor(fileId) };
    const events: CommitEvent[] = [];
    const hooks = makeRecordingHooks(defaultTransactionCommitHooks(db, ctx), events);
    const row: RowContext = { record, index, fileId, ctx, events, hooks };

    const linked = record.linked;
    if (Array.isArray(linked) && linked.length > 0) {
      results.push(commitCompoundRow(deps, row, linked));
      continue;
    }
    results.push(commitStandaloneRow(deps, row));
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

  // Exit 7 only for genuine failures — duplicates are a successful no-op.
  if (counters.failed > 0) process.exitCode = EXIT.PARTIAL;
}
