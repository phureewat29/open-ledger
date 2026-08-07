import type { Command } from "commander";
import type Database from "libsql";
import {
  currentMode,
  emit,
  emitCappedSummary,
  emitList,
  emitObject,
  emitSummary,
  fail,
  mapNotFoundError,
  redactionEnabled,
  requireYes,
  runAction,
  type Column,
} from "../output.js";
import { openDb } from "../db.js";
import { requireConfig } from "./config.js";
import type { ResolvedConfig } from "../../config.js";
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
  type DuplicateTransactionRow,
} from "../../db/queries/transactions.js";
import {
  commitTransaction,
  CURRENCY_MISMATCH_HINT,
  type TransactionCommitContext,
  type RawTransactionInput,
} from "../../ingest/commit.js";
import { autoMergeStrictDuplicateTransactions, findDuplicateTransactions } from "../../ingest/dedup.js";
import { requireAccount } from "../accounts.js";
import { fromMinorUnits, toMinorUnits } from "../../lib/money.js";
import { clampOffset } from "../../lib/limit.js";
import { formatFixed } from "../currency.js";
import { currencyOf, newBatchId } from "../../lib/ids.js";
import { applyRedaction, type RedactionSource } from "../../privacy/redactor.js";
import { todayIso } from "../../lib/date.js";
import { noiseTokens } from "../../datasets/noise.js";
import * as z from "zod";
import { parseInput, str, num } from "../../lib/validate.js";

// Amounts are minor units in the DB; this module converts to/from decimals at the CLI boundary.

// Free-text fields that may carry PII; ids, amount, currency, and dates are structured and left intact.
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
  { header: "Amount", value: (t) => formatFixed(t.amount, t.currency), align: "right" },
  { header: "Currency", value: (t) => t.currency },
];

interface ListTransactionsOpts {
  group?: boolean;
  redact?: boolean;
  includeVoid?: boolean;
}

const LIST_TRANSACTIONS_SPEC = z.object({
  account: str().optional(),
  from: str().optional(),
  to: str().optional(),
  query: str().optional(),
  amount: num().optional(),
  currency: str().optional(),
  limit: num().optional(),
  offset: num().optional(),
});

// `--amount` is decimal but stored amounts are minor units, so the filter needs a currency:
// from `--account`'s ledger, else an explicit `--currency` (no display-currency fallback).
function amountFilterCurrency(account?: string, currency?: string): string {
  if (account) return currencyOf(account);
  if (currency) return currency;
  fail("USAGE", "--amount needs a unit: pass --account <id> or --currency <code>");
}

async function listTransactions(opts: ListTransactionsOpts, command: Command): Promise<void> {
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  const parsed = parseInput(LIST_TRANSACTIONS_SPEC, opts as Record<string, unknown>);
  const listOpts: Omit<ListTransactionsOptions, "group"> = { includeVoid: !!opts.includeVoid };
  if (parsed.account) listOpts.account = parsed.account;
  if (parsed.currency) listOpts.ledger = parsed.currency;
  if (parsed.from) listOpts.from = parsed.from;
  if (parsed.to) listOpts.to = parsed.to;
  if (parsed.query) listOpts.query = parsed.query;
  if (parsed.amount !== undefined) {
    listOpts.amount = toMinorUnits(
      parsed.amount,
      amountFilterCurrency(parsed.account, parsed.currency),
    );
  }
  if (parsed.limit !== undefined) listOpts.limit = parsed.limit;
  if (parsed.offset !== undefined) listOpts.offset = parsed.offset;

  const total = countTransactions(db, listOpts);
  const limit = clampListLimit(listOpts.limit);
  const offset = clampOffset(listOpts.offset);

  if (opts.group) {
    // Offset pages rows before clustering, so a group can straddle a page, same as the limit.
    const clusters = queryTransactions(db, { ...listOpts, group: true });
    emitClusters(clusters, redactionEnabled(opts), {
      userName: config.userName,
      contextPath: config.contextPath,
    });
    const returned = clusters.reduce((n, c) => n + c.transactions.length, 0);
    emitCappedSummary(total, returned, limit, offset);
    return;
  }

  const rows = applyRedaction(
    queryTransactions(db, listOpts).map(presentTransaction),
    redactionEnabled(opts),
    TRANSACTION_REDACT_FIELDS,
    { userName: config.userName, contextPath: config.contextPath },
  );
  emitList(rows, LIST_COLUMNS);
  emitCappedSummary(total, rows.length, limit, offset);
}

function emitClusters(clusters: TransactionCluster[], redact: boolean, source: RedactionSource): void {
  const raw = clusters.map((c) => ({
    group_id: c.group_id,
    transactions: c.transactions.map(presentTransaction),
  }));
  // One redactor build (and one context.md read) for the whole view, not one per cluster.
  const view = applyRedaction(raw, redact, TRANSACTION_REDACT_FIELDS, source);
  const mode = currentMode();
  if (mode.json) {
    for (const c of view) emit(c);
    return;
  }
  for (const c of view) {
    process.stdout.write(`${c.group_id ?? "(ungrouped)"}\n`);
    for (const t of c.transactions) {
      process.stdout.write(
        `  ${t.id}  ${t.date}  ${t.description}  ${t.debit_account_name ?? t.debit_account_id} -> ${t.credit_account_name ?? t.credit_account_id}  ${formatFixed(t.amount, t.currency)} ${t.currency}\n`,
      );
    }
  }
}

async function showTransaction(
  id: string,
  opts: { redact?: boolean },
  command: Command,
): Promise<void> {
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  const detail = findTransactionById(db, id);
  if (!detail) fail("NOT_FOUND", `transaction "${id}" not found`);

  const view: Record<string, unknown> = presentTransaction(detail);
  if (detail.group) view.group = detail.group.map(presentTransaction);
  emitObject(
    applyRedaction(view, redactionEnabled(opts), TRANSACTION_REDACT_FIELDS, {
      userName: config.userName,
      contextPath: config.contextPath,
    }),
  );
}

type DuplicateRow = Omit<DuplicateTransactionRow, "amount"> & {
  amount: number;
  group: number;
};

const DUPLICATE_COLUMNS: Column<DuplicateRow>[] = [
  { header: "Group", value: (r) => String(r.group), align: "right" },
  { header: "ID", value: (r) => r.id },
  { header: "Date", value: (r) => r.date },
  { header: "Amount", value: (r) => formatFixed(r.amount, r.currency), align: "right" },
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

async function dedupeTransactions(
  opts: { autoMerge?: boolean; redact?: boolean },
  command: Command,
): Promise<void> {
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);

  let autoMerged: number | undefined;
  if (opts.autoMerge) {
    autoMerged = autoMergeStrictDuplicateTransactions(db).merged;
  }

  const groups = findDuplicateTransactions(db);
  const rows: DuplicateRow[] = applyRedaction(
    groups.flatMap((group, i) =>
      group.map((t) => ({ ...t, amount: fromMinorUnits(t.amount, t.currency), group: i })),
    ),
    redactionEnabled(opts),
    TRANSACTION_REDACT_FIELDS,
    { userName: config.userName, contextPath: config.contextPath },
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

async function mergeTransactions(opts: MergeTransactionsOpts, command: Command): Promise<void> {
  const parsed = parseInput(MERGE_TRANSACTIONS_SPEC, opts as Record<string, unknown>);
  requireYes(opts, "merging transactions");
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);

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
  // str() accepts "" and whitespace alike (the flag not being passed); must fail USAGE
  // here, not NOT_FOUND downstream.
  if (!parsed.debit_account_id.trim() || !parsed.credit_account_id.trim()) {
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

function addViaResolve(db: Database.Database, config: ResolvedConfig, raw: RawTransactionInput): void {
  const batchId = newBatchId();
  const ctx: TransactionCommitContext = {
    batchId,
    fileId: null,
    fileHash: null,
    country: config.country,
  };
  const outcome = commitTransaction(db, ctx, raw);
  if (!outcome.ok) {
    // The conversion-pair hint only fits a mismatch between two ledgers that both exist.
    if (outcome.reason === "currency_mismatch" && !outcome.unopenedLedger) {
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

function addStrict(db: Database.Database, config: ResolvedConfig, raw: RawTransactionInput): void {
  const accountHint =
    "create it with `oled accounts create`, or find a close match with `oled accounts match --query <name>`, or re-run with --resolve";
  const debit = requireAccount(db, raw.debit_account_id, accountHint);
  const credit = requireAccount(db, raw.credit_account_id, accountHint);

  // Same both-legs-one-ledger rule commitTransaction enforces, applied inline: this path
  // raises no questions, so it can't delegate to commitTransaction's currency_mismatch path.
  const currency = currencyOf(debit.id);
  const creditCurrency = currencyOf(credit.id);
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
      merchant: raw.merchant
        ? { ...raw.merchant, noise_tokens: noiseTokens(config.country) }
        : null,
      merchant_id: raw.merchant_id ?? null,
      raw_descriptor: raw.raw_descriptor ?? null,
      source_page: raw.source_page ?? null,
    });
  } catch (err) {
    fail("INVALID", (err as Error).message);
  }
  emitObject({ transaction_id: result.id, duplicate: result.duplicate });
}

async function addTransaction(opts: AddTransactionOpts, command: Command): Promise<void> {
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  const raw = buildRawTransaction(opts);

  if (opts.resolve) return addViaResolve(db, config, raw);
  return addStrict(db, config, raw);
}

const UPDATE_TRANSACTION_SPEC = z.object({
  date: str().optional(),
  description: str().optional(),
  merchant_id: str().optional(),
});

const UPDATE_TRANSACTION_ALIASES = { merchant_id: ["merchant"] };

async function updateTransaction(
  id: string,
  opts: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const fields: UpdateTransactionMetaFields = parseInput(UPDATE_TRANSACTION_SPEC, opts, {
    aliases: UPDATE_TRANSACTION_ALIASES,
    atLeastOne: "at least one of --date, --description, --merchant is required",
  });
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  const changes = updateTransactionMeta(db, id, fields);
  if (changes === 0) fail("NOT_FOUND", `transaction "${id}" not found`);
  emitObject({ transaction_id: id, updated: true });
}

async function deleteTransaction(
  id: string,
  opts: { yes?: boolean },
  command: Command,
): Promise<void> {
  requireYes(opts, "deleting this transaction");
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  const { deleted, unvoided } = deleteTransactionRow(db, id);
  if (!deleted) fail("NOT_FOUND", `transaction "${id}" not found`);
  // Deleting a survivor puts its mirrors back into balance derivation.
  emitObject({ transaction_id: id, deleted: true, unvoided });
}

const RECATEGORIZE_SPEC = z.object({
  set_account: str(),
  filter_account: str(),
});

// The `--filter-account` clarification is folded into the label so a missing flag still explains it.
const RECATEGORIZE_LABELS = {
  filter_account: "--filter-account (recategorize moves that account's transactions)",
};

async function recategorizeTransactions(
  opts: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const parsed = parseInput(RECATEGORIZE_SPEC, opts, { labels: RECATEGORIZE_LABELS });
  // An empty id reads the same as the flag not being passed.
  if (!parsed.filter_account.trim()) fail("USAGE", `${RECATEGORIZE_LABELS.filter_account} required`);
  if (!parsed.set_account.trim()) fail("USAGE", "--set-account required");

  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  const filter: BulkRecategorizeFilter = { accountId: parsed.filter_account };

  let result;
  try {
    result = bulkRecategorize(db, filter, { accountId: parsed.set_account });
  } catch (err) {
    // bulkRecategorize pre-filters cross-ledger targets, so a missing --set-account
    // target is the one not-found case reachable here.
    mapNotFoundError(err);
  }
  emitObject({
    affected: result.affected,
    skipped_self_transaction: result.skipped_self_transaction,
    skipped_currency_mismatch: result.skipped_currency_mismatch,
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
        "Typical flow: list to find a tx:id, then show, recategorize, or delete it. Statement rows go through ingest commit, not add. Account ids are currency-prefixed (<currency>:<type>:<path>) everywhere, and both accounts on a transaction must share that prefix.",
        "Direction, not sign: debit the account that grows, amount always positive. Card purchase: debit thb:expense:<cat>, credit thb:liability:credit_card:<x>. Bank spend: debit thb:expense:<cat>, credit thb:asset:bank:<x>. Salary: debit thb:asset:bank:<x>, credit thb:income:salary. A refund reverses the purchase's accounts; a card payment debits the liability and credits the bank; opening balances post against thb:equity:opening. Money crossing currencies is two linked legs through <currency>:equity:conversion, never one row.",
        "Example: oled transactions list --account thb:expense:food --json",
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
    .option("--currency <code>", "scope rows to that currency's ledger, and the unit --amount is given in; --account names a ledger of its own and wins")
    .option("--limit <n>", "max rows (default 50, max 500)")
    .option("--offset <n>", "rows to skip; repeat with offset += returned while the summary says has_more")
    .option("--group", "fold linked transactions into their group clusters")
    .option("--include-void", "include mirrors voided by `transactions merge` (hidden by default)")
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
    .option("--debit-account <id>", "debit account id, currency-prefixed (e.g. thb:expense:food)")
    .option("--credit-account <id>", "credit account id, currency-prefixed (e.g. thb:asset:bank:kbank)")
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
