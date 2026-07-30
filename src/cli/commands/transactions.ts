import type { Command } from "commander";
import type Database from "libsql";
import {
  currentMode,
  emit,
  emitList,
  emitObject,
  emitSummary,
  fail,
  mapNotFoundError,
  requireYes,
  runAction,
  type Column,
} from "../output.js";
import { openDb } from "../db.js";
import {
  insertTransaction,
  deleteTransaction as deleteTransactionRow,
  updateTransactionMeta,
  bulkRecategorize,
  listTransactions as queryTransactions,
  countTransactions,
  clampListLimit,
  findTransactionById,
  voidTransactionAsMirror,
  type BulkRecategorizeFilter,
  type UpdateTransactionMetaFields,
  type ListTransactionsOptions,
  type TransactionRow,
  type TransactionCluster,
} from "../../db/queries/transactions.js";
import {
  findDuplicateTransactions,
  type DuplicateTransactionRow,
} from "../../db/queries/transactions-dedup.js";
import { findAccountById } from "../../db/queries/accounts.js";
import {
  commitTransaction,
  defaultTransactionCommitHooks,
  CURRENCY_MISMATCH_HINT,
  type TransactionCommitContext,
  type RawTransactionInput,
} from "../../ingest/commit.js";
import { autoMergeStrictDuplicateTransactions } from "../../ingest/dedup.js";
import { fromMinorUnits, toMinorUnits } from "../../lib/money.js";
import { getDisplayCurrency } from "../currency.js";
import { newBatchId } from "../../lib/ids.js";
import { applyRedaction } from "../../privacy/redactor.js";
import { todayIso } from "../../lib/date.js";
import * as z from "zod";
import { parseInput, str, num } from "../../lib/validate.js";

// Amounts are minor units in the DB; this module converts to/from decimals at the CLI boundary.

// Free-text fields on a transaction that may carry PII. Ids, amount, currency, and
// dates are structured data the agent needs verbatim and are left intact.
const TRANSACTION_REDACT_FIELDS = [
  "description",
  "raw_descriptor",
  "merchant_name",
  "debit_account_name",
  "credit_account_name",
] as const;

type TransactionView = Omit<TransactionRow, "amount"> & { amount: number };

function presentTransaction(row: TransactionRow): TransactionView {
  return { ...row, amount: fromMinorUnits(row.amount, row.currency) };
}

const LIST_COLUMNS: Column<TransactionView>[] = [
  { header: "ID", value: (t) => t.id },
  { header: "Date", value: (t) => t.date },
  { header: "Description", value: (t) => t.description },
  { header: "Debit", value: (t) => t.debit_account_name ?? t.debit_account_id },
  { header: "Credit", value: (t) => t.credit_account_name ?? t.credit_account_id },
  { header: "Amount", value: (t) => t.amount.toFixed(2), align: "right" },
  { header: "Currency", value: (t) => t.currency },
];

interface ListTransactionsOpts {
  group?: boolean;
  redact?: boolean;
}

const LIST_TRANSACTIONS_SPEC = z.object({
  account: str().optional(),
  from: str().optional(),
  to: str().optional(),
  query: str().optional(),
  amount: num().optional(),
  currency: str().optional(),
  limit: num().optional(),
});

async function listTransactions(opts: ListTransactionsOpts): Promise<void> {
  const db = await openDb();
  const parsed = parseInput(LIST_TRANSACTIONS_SPEC, opts as Record<string, unknown>);
  const listOpts: Omit<ListTransactionsOptions, "group"> = {};
  if (parsed.account) listOpts.account = parsed.account;
  if (parsed.from) listOpts.from = parsed.from;
  if (parsed.to) listOpts.to = parsed.to;
  if (parsed.query) listOpts.query = parsed.query;
  // Amount crosses the decimal -> minor-unit boundary here; currency defaults
  // to the configured display currency when the caller doesn't pin one.
  if (parsed.amount !== undefined) {
    listOpts.amount = toMinorUnits(parsed.amount, parsed.currency ?? getDisplayCurrency());
  }
  if (parsed.limit !== undefined) listOpts.limit = parsed.limit;

  const total = countTransactions(db, listOpts);
  const limit = clampListLimit(listOpts.limit);

  if (opts.group) {
    const clusters = queryTransactions(db, { ...listOpts, group: true });
    emitClusters(clusters, !!opts.redact);
    const returned = clusters.reduce((n, c) => n + c.transactions.length, 0);
    emitSummary({ total, returned, has_more: total > returned, limit });
    return;
  }

  const rows = applyRedaction(
    queryTransactions(db, listOpts).map(presentTransaction),
    !!opts.redact,
    TRANSACTION_REDACT_FIELDS,
  );
  emitList(rows, LIST_COLUMNS);
  emitSummary({ total, returned: rows.length, has_more: total > rows.length, limit });
}

function emitClusters(clusters: TransactionCluster[], redact: boolean): void {
  const view = clusters.map((c) => ({
    group_id: c.group_id,
    transactions: applyRedaction(c.transactions.map(presentTransaction), redact, TRANSACTION_REDACT_FIELDS),
  }));
  const mode = currentMode();
  if (mode.json) {
    for (const c of view) emit(c);
    return;
  }
  for (const c of view) {
    process.stdout.write(`${c.group_id ?? "(ungrouped)"}\n`);
    for (const t of c.transactions) {
      process.stdout.write(
        `  ${t.id}  ${t.date}  ${t.description}  ${t.debit_account_name ?? t.debit_account_id} -> ${t.credit_account_name ?? t.credit_account_id}  ${t.amount.toFixed(2)} ${t.currency}\n`,
      );
    }
  }
}

async function showTransaction(id: string, opts: { redact?: boolean }): Promise<void> {
  const db = await openDb();
  const detail = findTransactionById(db, id);
  if (!detail) fail("NOT_FOUND", `transaction "${id}" not found`);

  const view: Record<string, unknown> = presentTransaction(detail);
  if (detail.group) view.group = detail.group.map(presentTransaction);
  emitObject(applyRedaction(view, !!opts.redact, TRANSACTION_REDACT_FIELDS));
}

type DuplicateRow = Omit<DuplicateTransactionRow, "amount"> & {
  amount: number;
  group: number;
};

const DUPLICATE_COLUMNS: Column<DuplicateRow>[] = [
  { header: "Group", value: (r) => String(r.group), align: "right" },
  { header: "ID", value: (r) => r.id },
  { header: "Date", value: (r) => r.date },
  { header: "Amount", value: (r) => r.amount.toFixed(2), align: "right" },
  { header: "Currency", value: (r) => r.currency },
  { header: "Description", value: (r) => r.description },
  {
    header: "Accounts",
    value: (r) =>
      `${r.debit_account_name ?? r.debit_account_id} -> ${r.credit_account_name ?? r.credit_account_id}`,
  },
  { header: "Source File ID", value: (r) => r.source_file_id ?? "" },
  { header: "Merchant ID", value: (r) => r.merchant_id ?? "" },
];

async function dedupeTransactions(opts: { autoMerge?: boolean; redact?: boolean }): Promise<void> {
  const db = await openDb();

  let autoMerged: number | undefined;
  if (opts.autoMerge) {
    autoMerged = autoMergeStrictDuplicateTransactions(db).merged;
  }

  const groups = findDuplicateTransactions(db);
  const rows: DuplicateRow[] = applyRedaction(
    groups.flatMap((group, i) =>
      group.map((t) => ({ ...t, amount: fromMinorUnits(t.amount, t.currency), group: i })),
    ),
    !!opts.redact,
    TRANSACTION_REDACT_FIELDS,
  );

  emitList(rows, DUPLICATE_COLUMNS);
  emitSummary({
    groups: groups.length,
    ...(autoMerged !== undefined ? { auto_merged: autoMerged } : {}),
  });
}

const MERGE_TRANSACTIONS_SPEC = z.object({
  from: str(),
  to: str(),
});

interface MergeTransactionsOpts {
  from?: string;
  to?: string;
  yes?: boolean;
}

async function mergeTransactions(opts: MergeTransactionsOpts): Promise<void> {
  const parsed = parseInput(MERGE_TRANSACTIONS_SPEC, opts as Record<string, unknown>);
  requireYes(opts, "merging transactions");
  const db = await openDb();

  let result;
  try {
    result = voidTransactionAsMirror(db, parsed.from, parsed.to);
  } catch (err) {
    mapNotFoundError(err);
  }

  if (result.alreadyVoid) {
    emitObject({ from: parsed.from, to: parsed.to, voided: false, already_void: true });
    return;
  }
  emitObject({ from: parsed.from, to: parsed.to, voided: true });
}

interface AddTransactionOpts {
  resolve?: boolean;
  debitAccount?: string;
  creditAccount?: string;
  amount?: string;
  date?: string;
  description?: string;
  merchantName?: string;
}

const ADD_TRANSACTION_FLAGS_SPEC = z.object({
  debit_account_id: str(),
  credit_account_id: str(),
  amount: num(),
  date: str().optional(),
  description: str().optional(),
});

const ADD_TRANSACTION_FLAGS_OPTS = {
  labels: { debit_account_id: "--debit-account", credit_account_id: "--credit-account" },
  aliases: { debit_account_id: ["debitAccount"], credit_account_id: ["creditAccount"] },
};

// Decimal amount, no account validation: that's the caller's job.
function buildRawTransaction(opts: AddTransactionOpts): RawTransactionInput {
  const parsed = parseInput(
    ADD_TRANSACTION_FLAGS_SPEC,
    opts as Record<string, unknown>,
    ADD_TRANSACTION_FLAGS_OPTS,
  );
  // str() accepts "": an empty account id must fail USAGE here, not NOT_FOUND downstream.
  if (!parsed.debit_account_id || !parsed.credit_account_id) {
    fail("USAGE", "--debit-account and --credit-account cannot be empty");
  }

  const raw: RawTransactionInput = {
    date: parsed.date ?? todayIso(),
    description: parsed.description ?? opts.merchantName ?? "Manual entry",
    debit_account_id: parsed.debit_account_id,
    credit_account_id: parsed.credit_account_id,
    amount: parsed.amount,
    currency: null,
  };
  if (opts.merchantName) raw.merchant = { canonical_name: opts.merchantName };
  return raw;
}

function addViaResolve(db: Database.Database, raw: RawTransactionInput): void {
  const batchId = newBatchId();
  const ctx: TransactionCommitContext = {
    batchId,
    fileId: null,
    fileHash: null,
  };
  const outcome = commitTransaction(db, ctx, raw, defaultTransactionCommitHooks(db, ctx));
  if (!outcome.ok) {
    if (outcome.reason === "currency_mismatch") {
      fail("INVALID", outcome.message, { hint: CURRENCY_MISMATCH_HINT });
    }
    fail("INVALID", outcome.message);
  }
  emitObject({
    transaction_id: outcome.transactionId,
    duplicate: outcome.duplicate,
    raised_questions: outcome.raisedQuestions,
    currency_overridden: outcome.currencyOverridden,
  });
}

function addStrict(db: Database.Database, raw: RawTransactionInput): void {
  const accountHint =
    "create it with `oled accounts create`, or find a close match with `oled accounts match --query <name>`, or re-run with --resolve";
  const debit = findAccountById(db, raw.debit_account_id);
  if (!debit) fail("NOT_FOUND", `account "${raw.debit_account_id}" not found`, { hint: accountHint });
  const credit = findAccountById(db, raw.credit_account_id);
  if (!credit) fail("NOT_FOUND", `account "${raw.credit_account_id}" not found`, { hint: accountHint });

  /**
   * The same both-legs-one-currency rule commitTransaction enforces, applied
   * inline: this strict path requires both accounts to pre-exist and raises no
   * questions, so it can't delegate to commitTransaction's currency_mismatch
   * path; only CURRENCY_MISMATCH_HINT is shared.
   */
  const currency = debit.currency || getDisplayCurrency();
  const creditCurrency = credit.currency || getDisplayCurrency();
  if (creditCurrency !== currency) {
    fail(
      "INVALID",
      `debit ${debit.id} is ${currency}, credit ${credit.id} is ${creditCurrency}; a single transaction can't cross currencies`,
      { hint: CURRENCY_MISMATCH_HINT },
    );
  }

  let result: { id: string; duplicate: boolean };
  try {
    result = insertTransaction(db, {
      date: raw.date,
      description: raw.description,
      debit_account_id: raw.debit_account_id,
      credit_account_id: raw.credit_account_id,
      amount: toMinorUnits(raw.amount, currency),
      currency,
      merchant: raw.merchant ?? null,
      merchant_id: raw.merchant_id ?? null,
      raw_descriptor: raw.raw_descriptor ?? null,
      source_page: raw.source_page ?? null,
      code: raw.code ?? null,
    });
  } catch (err) {
    fail("INVALID", (err as Error).message);
  }
  emitObject({ transaction_id: result.id, duplicate: result.duplicate });
}

async function addTransaction(opts: AddTransactionOpts): Promise<void> {
  const db = await openDb();
  const raw = buildRawTransaction(opts);

  if (opts.resolve) return addViaResolve(db, raw);
  return addStrict(db, raw);
}

const UPDATE_TRANSACTION_SPEC = z.object({
  date: str().optional(),
  description: str().optional(),
  merchant_id: str().optional(),
});

const UPDATE_TRANSACTION_ALIASES = { merchant_id: ["merchant"] };

async function updateTransaction(id: string, opts: Record<string, unknown>): Promise<void> {
  const fields: UpdateTransactionMetaFields = parseInput(UPDATE_TRANSACTION_SPEC, opts, {
    aliases: UPDATE_TRANSACTION_ALIASES,
    atLeastOne: "at least one of --date, --description, --merchant is required",
  });
  const db = await openDb();
  const changes = updateTransactionMeta(db, id, fields);
  if (changes === 0) fail("NOT_FOUND", `transaction "${id}" not found`);
  emitObject({ transaction_id: id, updated: true });
}

async function deleteTransaction(id: string, opts: { yes?: boolean }): Promise<void> {
  requireYes(opts, "deleting this transaction");
  const db = await openDb();
  if (!deleteTransactionRow(db, id)) fail("NOT_FOUND", `transaction "${id}" not found`);
  emitObject({ transaction_id: id, deleted: true });
}

const RECATEGORIZE_SPEC = z.object({
  set_account: str(),
  filter_account: str(),
});

// The `--filter-account` clarification is folded into the label so a missing
// flag still explains what that account controls.
const RECATEGORIZE_LABELS = {
  filter_account: "--filter-account (recategorize moves that account's transactions)",
};

async function recategorizeTransactions(opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(RECATEGORIZE_SPEC, opts, { labels: RECATEGORIZE_LABELS });
  const db = await openDb();
  const filter: BulkRecategorizeFilter = { accountId: parsed.filter_account };

  let result;
  try {
    result = bulkRecategorize(db, filter, { accountId: parsed.set_account });
  } catch (err) {
    fail("INVALID", (err as Error).message);
  }
  emitObject({
    affected: result.affected,
    skipped_self_transaction: result.skipped_self_transaction,
    sample_transaction_ids: result.sample_transaction_ids,
  });
}

export function registerTransactions(program: Command): void {
  const transactions = program
    .command("transactions")
    .description("Transactions: list / show / add / update / delete / recategorize / dedupe / merge")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: reads the ledger (list, show) and edits it (add, update, delete, recategorize, dedupe, merge).",
        "Typical flow: list to find a tx:id, then show, recategorize, or delete it. Statement rows go through ingest commit, not add.",
        "Direction, not sign: debit the account that grows, amount always positive. Card purchase: debit expense:<cat>, credit liability:credit_card:<x>. Bank spend: debit expense:<cat>, credit asset:bank:<x>. Salary: debit asset:bank:<x>, credit income:salary. A refund reverses the purchase's accounts; a card payment debits the liability and credits the bank; opening balances post against equity:opening-balance.",
        "Example: oled transactions list --account expense:food --json",
      ].join("\n"),
    );

  transactions
    .command("list")
    .description("List transactions with optional filters")
    .option("--account <id>", "filter by account id (matches either side)")
    .option("--from <date>", "filter from date")
    .option("--to <date>", "filter to date")
    .option("--query <text>", "filter by search text")
    .option("--amount <decimal>", "filter by exact amount (decimal)")
    .option("--currency <code>", "currency for --amount (defaults to the configured display currency)")
    .option("--limit <n>", "max rows (default 50, max 500)")
    .option("--group", "fold linked transactions into their group clusters")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(listTransactions));

  transactions
    .command("show <id>")
    .description("Show a transaction's details (with its linked group when present)")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(showTransaction));

  transactions
    .command("add")
    .description("Add a manual transaction; statement rows belong in `ingest commit`")
    .option("--resolve", "create missing account paths and raise questions instead of failing")
    .option("--debit-account <id>", "debit account id")
    .option("--credit-account <id>", "credit account id")
    .option("--amount <n>", "transaction amount (decimal)")
    .option("--date <date>", "transaction date (defaults to today)")
    .option("--description <text>", "transaction description")
    .option("--merchant-name <name>", "merchant name to upsert and link")
    .action(runAction(addTransaction));

  transactions
    .command("update <id>")
    .description("Update a transaction's metadata")
    .option("--date <date>", "transaction date")
    .option("--description <text>", "transaction description")
    .option("--merchant <id>", "merchant id to set")
    .action(runAction(updateTransaction));

  transactions
    .command("delete <id>")
    .description("Delete a transaction")
    .option("--yes", "skip confirmation")
    .action(runAction(deleteTransaction));

  transactions
    .command("recategorize")
    .description("Bulk re-point one account's transactions onto another")
    .option("--set-account <id>", "account id to move matching transactions to")
    .option("--filter-account <id>", "account whose transactions are moved (required)")
    .action(runAction(recategorizeTransactions));

  transactions
    .command("dedupe")
    .description("Find likely duplicate transactions (optionally auto-merge them)")
    .option("--auto-merge", "automatically merge detected duplicates")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(dedupeTransactions));

  transactions
    .command("merge")
    .description("Merge a mirror transaction into its surviving twin (voids --from)")
    .option("--from <id>", "mirror transaction id to void")
    .option("--to <id>", "surviving transaction id")
    .option("--yes", "skip confirmation")
    .action(runAction(mergeTransactions));
}
