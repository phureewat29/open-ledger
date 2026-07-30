import type Database from "libsql";
import { accountExists } from "./accounts.js";
import { upsertMerchant, type MerchantUpsertInput } from "./merchants.js";
import { buildPatch, type PatchField } from "../../lib/patch.js";
import { newGroupId, newTransactionId } from "../../lib/ids.js";
import { clampLimit, clampOffset } from "../../lib/limit.js";
import { ISO_DATE_RE } from "../../lib/date.js";

/**
 * TigerBeetle-style single-row transaction: one debit account, one credit
 * account, one positive minor-unit `amount` (INTEGER). Decimal <-> minor
 * conversion happens at the CLI/pipeline boundary, never here.
 */
export interface TransactionInput {
  /** Pre-assigned id (`tx:`+hash) so mid-ingest questions can reference the transaction before commit. */
  id?: string;
  /** Links sibling legs (e.g. a salary split into net/tax/social-security, an FX pair). */
  group_id?: string | null;
  date: string;
  description: string;
  /** Pre-resolved merchant id. Overrides any `merchant` upsert when set. */
  merchant_id?: string | null;
  merchant?: MerchantUpsertInput | null;
  raw_descriptor?: string | null;
  source_file_id?: string | null;
  source_page?: number | null;
  debit_account_id: string;
  credit_account_id: string;
  /** Integer minor units. Positive (enforced by validateTransaction + CHECK). */
  amount: number;
  currency: string;
  code?: string | null;
  user_ref?: string | null;
}

export interface TransactionRow {
  id: string;
  group_id: string | null;
  date: string;
  description: string;
  merchant_id: string | null;
  raw_descriptor: string | null;
  source_file_id: string | null;
  source_page: number | null;
  debit_account_id: string;
  credit_account_id: string;
  amount: number;
  currency: string;
  code: string | null;
  user_ref: string | null;
  /** Set to the surviving twin's id when `transactions merge` voided this row
   *  into it; NULL means live. See `voidTransactionAsMirror`. */
  void_of: string | null;
  has_question: number;
  created_at: string;
  debit_account_name: string | null;
  credit_account_name: string | null;
  merchant_name: string | null;
}

/** A queried transaction plus every member of its group (self included). */
interface TransactionDetail extends TransactionRow {
  group?: TransactionRow[];
}

export type ValidateTransactionResult = { ok: true } | { ok: false; reason: string };

/** Amount must already be an integer in minor units: this layer never sees decimals. */
export function validateTransaction(input: TransactionInput): ValidateTransactionResult {
  if (!ISO_DATE_RE.test(input.date ?? "")) {
    return { ok: false, reason: "Transaction date must be an ISO date (YYYY-MM-DD)." };
  }
  if (!input.description || !input.description.trim()) {
    return { ok: false, reason: "Transaction description must not be empty." };
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return { ok: false, reason: "Transaction amount must be a positive integer in minor units." };
  }
  if (!input.debit_account_id || !input.debit_account_id.trim()) {
    return { ok: false, reason: "Transaction debit_account_id must not be empty." };
  }
  if (!input.credit_account_id || !input.credit_account_id.trim()) {
    return { ok: false, reason: "Transaction credit_account_id must not be empty." };
  }
  if (input.debit_account_id === input.credit_account_id) {
    return { ok: false, reason: "Transaction debit and credit accounts must differ." };
  }
  return { ok: true };
}

const INSERT_COLUMNS =
  "id, group_id, date, description, merchant_id, raw_descriptor, source_file_id, source_page, debit_account_id, credit_account_id, amount, currency, code, user_ref";

function insertParams(id: string, merchantId: string | null, input: TransactionInput): any[] {
  return [
    id,
    input.group_id ?? null,
    input.date,
    input.description,
    merchantId,
    input.raw_descriptor ?? null,
    input.source_file_id ?? null,
    input.source_page ?? null,
    input.debit_account_id,
    input.credit_account_id,
    input.amount,
    input.currency,
    input.code ?? null,
    input.user_ref ?? null,
  ];
}

/**
 * Validates, then `INSERT ... ON CONFLICT(id) DO NOTHING`: re-inserting the
 * same derived id is a no-op. `duplicate` is true when the row already existed.
 */
export function insertTransaction(
  db: Database.Database,
  input: TransactionInput,
): { id: string; duplicate: boolean } {
  const check = validateTransaction(input);
  if (!check.ok) throw new Error(check.reason);

  const id = input.id ?? newTransactionId();
  let merchantId = input.merchant_id ?? null;
  if (!merchantId && input.merchant) {
    merchantId = upsertMerchant(db, input.merchant).id;
  }

  const result = db
    .prepare(
      `INSERT INTO transactions (${INSERT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(...insertParams(id, merchantId, input));
  return { id, duplicate: result.changes === 0 };
}

interface InsertLinkedTransactionsResult {
  results: { id: string; duplicate: boolean }[];
  group_id: string;
}

/**
 * Insert several transactions sharing one group_id, atomically (any leg's
 * failure rolls back all). group_id: `opts.group_id`, else the first input's, else a fresh `tg:`.
 */
export function insertLinkedTransactions(
  db: Database.Database,
  inputs: TransactionInput[],
  opts: { group_id?: string } = {},
): InsertLinkedTransactionsResult {
  if (inputs.length === 0) {
    throw new Error("insertLinkedTransactions requires at least one transaction.");
  }
  const groupId =
    opts.group_id ?? inputs.find((i) => i.group_id)?.group_id ?? newGroupId();

  let results: { id: string; duplicate: boolean }[] = [];
  const tx = db.transaction((): void => {
    results = inputs.map((input) => insertTransaction(db, { ...input, group_id: groupId }));
  });
  tx();
  return { results, group_id: groupId };
}

// Shared by listing and counts so a `--query` filter (reads joined names) matches in both.
const LIST_FROM = `FROM transactions t
   LEFT JOIN accounts da ON da.id = t.debit_account_id
   LEFT JOIN accounts ca ON ca.id = t.credit_account_id
   LEFT JOIN merchants m ON m.id = t.merchant_id`;

const ROW_SELECT = `SELECT t.id, t.group_id, t.date, t.description, t.merchant_id,
        t.raw_descriptor, t.source_file_id, t.source_page,
        t.debit_account_id, t.credit_account_id, t.amount, t.currency,
        t.code, t.user_ref, t.void_of, t.has_question, t.created_at,
        da.name AS debit_account_name,
        ca.name AS credit_account_name,
        m.canonical_name AS merchant_name
   ${LIST_FROM}`;

/**
 * Loads one transaction; when grouped, `group` carries every member (self
 * included) ordered by id. Null if the id doesn't exist.
 */
export function findTransactionById(db: Database.Database, id: string): TransactionDetail | null {
  const row = db.prepare(`${ROW_SELECT} WHERE t.id = ?`).get(id) as TransactionRow | undefined;
  if (!row) return null;
  if (!row.group_id) return row;
  const group = db
    .prepare(`${ROW_SELECT} WHERE t.group_id = ? ORDER BY t.id`)
    .all(row.group_id) as TransactionRow[];
  return { ...row, group };
}

export interface ListTransactionsOptions {
  /** Match either side (debit OR credit) of the transaction. */
  account?: string;
  from?: string;
  to?: string;
  /** LIKE over description, raw_descriptor, merchant name, either account name. */
  query?: string;
  /** Exact match on the stored minor-unit amount. */
  amount?: number;
  limit?: number;
  /** Rows to skip; page with `offset += returned` while the summary says has_more. */
  offset?: number;
  /** When true, fold rows into per-group_id clusters (NULLs stay standalone). */
  group?: boolean;
}

export interface TransactionCluster {
  group_id: string | null;
  transactions: TransactionRow[];
}

type ListFilters = Pick<ListTransactionsOptions, "account" | "from" | "to" | "query" | "amount">;

// Shared by listTransactions/countTransactions so a filtered count matches the list.
// `params` align positionally with the `?` placeholders in `whereSql`.
function buildListWhere(opts: ListFilters): { whereSql: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.account) {
    conditions.push("(t.debit_account_id = ? OR t.credit_account_id = ?)");
    params.push(opts.account, opts.account);
  }
  if (opts.from) {
    conditions.push("t.date >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    conditions.push("t.date <= ?");
    params.push(opts.to);
  }
  if (opts.query) {
    conditions.push(
      "(t.description LIKE ? OR t.raw_descriptor LIKE ? OR m.canonical_name LIKE ? OR da.name LIKE ? OR ca.name LIKE ?)",
    );
    const like = `%${opts.query}%`;
    params.push(like, like, like, like, like);
  }
  if (opts.amount !== undefined) {
    conditions.push("t.amount = ?");
    params.push(opts.amount);
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return { whereSql, params };
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

export function clampListLimit(limit?: number): number {
  return clampLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
}

export function listTransactions(
  db: Database.Database,
  opts: ListTransactionsOptions & { group: true },
): TransactionCluster[];
export function listTransactions(
  db: Database.Database,
  opts?: ListTransactionsOptions & { group?: false },
): TransactionRow[];
export function listTransactions(
  db: Database.Database,
  opts: ListTransactionsOptions = {},
): TransactionRow[] | TransactionCluster[] {
  const { whereSql, params } = buildListWhere(opts);
  const limit = clampListLimit(opts.limit);
  const offset = clampOffset(opts.offset);

  const rows = db
    .prepare(`${ROW_SELECT} ${whereSql} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as TransactionRow[];

  return opts.group ? clusterByGroup(rows) : rows;
}

/**
 * Fold rows into per-group clusters, preserving the incoming (date DESC, id
 * DESC) order for cluster first-appearance. Rows with a null group_id each
 * become their own standalone cluster.
 */
function clusterByGroup(rows: TransactionRow[]): TransactionCluster[] {
  const clusters: TransactionCluster[] = [];
  const byGroup = new Map<string, TransactionCluster>();
  for (const row of rows) {
    if (row.group_id == null) {
      clusters.push({ group_id: null, transactions: [row] });
      continue;
    }
    let cluster = byGroup.get(row.group_id);
    if (!cluster) {
      cluster = { group_id: row.group_id, transactions: [] };
      byGroup.set(row.group_id, cluster);
      clusters.push(cluster);
    }
    cluster.transactions.push(row);
  }
  return clusters;
}

export function deleteTransaction(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM transactions WHERE id = ?`).run(id).changes > 0;
}

export interface BulkRecategorizeFilter {
  /** Recategorize transactions touching this account (either side). */
  accountId: string;
}

interface BulkRecategorizeSet {
  accountId: string;
}

interface BulkRecategorizeResult {
  affected: number;
  /** Rows skipped because moving them would make debit == credit. */
  skipped_self_transaction: number;
  sample_transaction_ids: string[];
}

/**
 * Re-points every matching transaction's `:from` side (debit OR credit) to
 * `:to`. Rows whose other side already equals `:to` are skipped (would
 * violate the debit<>credit CHECK) and counted in `skipped_self_transaction`.
 */
export function bulkRecategorize(
  db: Database.Database,
  filter: BulkRecategorizeFilter,
  set: BulkRecategorizeSet,
): BulkRecategorizeResult {
  const from = filter.accountId;
  const to = set.accountId;
  if (!from) throw new Error("bulkRecategorize: filter.accountId is required.");
  if (!to) throw new Error("bulkRecategorize: set.accountId is required.");
  if (from === to) {
    throw new Error("bulkRecategorize: set.accountId equals filter.accountId (no-op).");
  }
  if (!accountExists(db, to)) {
    throw new Error(`bulkRecategorize: target account "${to}" does not exist.`);
  }

  const whereSql = "(t.debit_account_id = ? OR t.credit_account_id = ?)";
  const params: any[] = [from, from];

  let affected = 0;
  let skipped = 0;
  let sample: string[] = [];
  const tx = db.transaction((): void => {
    const rows = db
      .prepare(
        `SELECT t.id, t.debit_account_id, t.credit_account_id FROM transactions t WHERE ${whereSql}`,
      )
      .all(...params) as { id: string; debit_account_id: string; credit_account_id: string }[];

    const toUpdate: string[] = [];
    for (const r of rows) {
      const other = r.debit_account_id === from ? r.credit_account_id : r.debit_account_id;
      if (other === to) {
        skipped++;
        continue;
      }
      toUpdate.push(r.id);
    }
    if (toUpdate.length === 0) return;

    sample = toUpdate.slice(0, 10);
    const placeholders = toUpdate.map(() => "?").join(",");
    affected = db
      .prepare(
        `UPDATE transactions
           SET debit_account_id  = CASE WHEN debit_account_id  = ? THEN ? ELSE debit_account_id  END,
               credit_account_id = CASE WHEN credit_account_id = ? THEN ? ELSE credit_account_id END
         WHERE id IN (${placeholders})`,
      )
      .run(from, to, from, to, ...toUpdate).changes;
  });
  tx();
  return { affected, skipped_self_transaction: skipped, sample_transaction_ids: sample };
}

/**
 * The re-point step of `mergeAccounts` (src/accounts/accounts.ts). Rows that
 * would become a degenerate self-transaction (one side `fromId`, the other
 * already `toId`) are deleted FIRST, since the debit<>credit CHECK forbids that
 * state even transiently; then the remainder is re-pointed. Does not touch the
 * accounts table.
 */
export function repointTransactions(
  db: Database.Database,
  fromId: string,
  toId: string,
): { moved: number; deletedSelfTransactions: number } {
  if (fromId === toId) throw new Error("Cannot re-point transactions to the same account.");

  let moved = 0;
  let deletedSelfTransactions = 0;
  const tx = db.transaction((): void => {
    deletedSelfTransactions = db
      .prepare(
        `DELETE FROM transactions
          WHERE (debit_account_id = ? AND credit_account_id = ?)
             OR (credit_account_id = ? AND debit_account_id = ?)`,
      )
      .run(fromId, toId, fromId, toId).changes;

    const d = db
      .prepare(`UPDATE transactions SET debit_account_id = ? WHERE debit_account_id = ?`)
      .run(toId, fromId).changes;
    const c = db
      .prepare(`UPDATE transactions SET credit_account_id = ? WHERE credit_account_id = ?`)
      .run(toId, fromId).changes;
    moved = d + c;
  });
  tx();
  return { moved, deletedSelfTransactions };
}

/** Same filters as listTransactions, no limit; no opts counts every row (the case `status` uses). */
export function countTransactions(db: Database.Database, opts: ListFilters = {}): number {
  const { whereSql, params } = buildListWhere(opts);
  return (
    db.prepare(`SELECT COUNT(*) AS n ${LIST_FROM} ${whereSql}`).get(...params) as { n: number }
  ).n;
}

export function countTransactionsBySourceFile(db: Database.Database, fileId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE source_file_id = ?`).get(fileId) as {
      n: number;
    }
  ).n;
}

/** The "account still in use" guard before deleting an account. */
export function accountHasTransactions(db: Database.Database, accountId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM transactions WHERE debit_account_id = ? OR credit_account_id = ? LIMIT 1`,
    )
    .get(accountId, accountId);
}

export interface UpdateTransactionMetaFields {
  date?: string;
  description?: string;
  merchant_id?: string | null;
  source_page?: number | null;
}

const TRANSACTION_META_PATCH: Record<string, PatchField> = {
  date: {},
  description: {},
  merchant_id: {},
  source_page: {},
};

/**
 * Amount, currency, and the account columns are intentionally not accepted
 * here: moving accounts is `bulkRecategorize`'s job, and amount/currency edits
 * must go through delete + re-record to keep minor-unit invariants intact.
 */
export function updateTransactionMeta(
  db: Database.Database,
  id: string,
  fields: UpdateTransactionMetaFields,
): number {
  const { sets, params } = buildPatch(TRANSACTION_META_PATCH, {}, fields);
  if (sets.length === 0) return 0;
  params.push(id);
  return db.prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`).run(...params).changes;
}

interface VoidCandidate {
  amount: number;
  currency: string;
  debit_account_id: string;
  credit_account_id: string;
  void_of: string | null;
}

/**
 * Voids `fromId` into surviving `toId` (sets `void_of=toId`); never deletes,
 * so re-ingesting the mirror's source file can't resurrect it. Requires
 * matching amount/currency/both accounts but not date (statement vs. posting
 * dates legitimately differ). Re-voiding an already-void row is a no-op.
 */
export function voidTransactionAsMirror(
  db: Database.Database,
  fromId: string,
  toId: string,
): { alreadyVoid: boolean } {
  if (fromId === toId) throw new Error("Cannot merge a transaction into itself.");

  const select = db.prepare(
    `SELECT amount, currency, debit_account_id, credit_account_id, void_of FROM transactions WHERE id = ?`,
  );
  const from = select.get(fromId) as VoidCandidate | undefined;
  if (!from) throw new Error(`transaction "${fromId}" not found`);
  const to = select.get(toId) as VoidCandidate | undefined;
  if (!to) throw new Error(`transaction "${toId}" not found`);

  if (from.void_of !== null) return { alreadyVoid: true };
  if (to.void_of !== null) throw new Error(`cannot merge into voided transaction "${toId}"`);

  if (
    from.amount !== to.amount ||
    from.currency !== to.currency ||
    from.debit_account_id !== to.debit_account_id ||
    from.credit_account_id !== to.credit_account_id
  ) {
    throw new Error(
      `transactions "${fromId}" and "${toId}" are not mirrors (amount, currency, and both accounts must match)`,
    );
  }

  db.prepare(`UPDATE transactions SET void_of = ? WHERE id = ?`).run(toId, fromId);
  return { alreadyVoid: false };
}
