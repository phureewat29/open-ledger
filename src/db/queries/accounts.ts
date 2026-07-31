import type Database from "libsql";
import { parseJsonOrNull } from "../../lib/json.js";
import { normalizeMaskedAccountNumber } from "../../lib/masked.js";
import { buildPatch, type PatchField } from "../../lib/patch.js";
import { errorMessage } from "../../lib/result.js";

/** At rest: bank_name is uppercased, account_number_masked is check-digit-normalized, metadata is JSON. */
export type AccountType = "asset" | "liability" | "income" | "expense" | "equity";

export const ACCOUNT_TYPES: ReadonlyArray<AccountType> = [
  "asset", "liability", "income", "expense", "equity",
];

/**
 * Currency is derived from the id's currency head, never stored — the same
 * rule as `currencyOf` (src/lib/ids.ts) and the cross-ledger trigger's
 * `substr(id,1,4)` compare (0001_baseline.ts). Change all three together.
 */
export function accountCurrencySQL(alias: string): string {
  return `upper(substr(${alias}.id,1,3))`;
}

/** Currency is derived from the id's currency head, never stored; see `accountCurrencySQL`. */
export const ACCOUNT_CURRENCY_SQL = accountCurrencySQL("a");

/** The projection every account read goes through, so `AccountRow.currency` can
 *  never come back undefined. */
export const ACCOUNT_COLUMNS_SQL = `a.*, ${ACCOUNT_CURRENCY_SQL} AS currency`;

export interface AccountRow {
  id: string;
  name: string;
  type: AccountType;
  parent_id: string | null;
  subtype: string | null;
  bank_name: string | null;
  account_number_masked: string | null;
  currency: string;
  due_day: number | null;
  statement_day: number | null;
  metadata_json: string | null;
  created_at: string;
}

export interface CreateAccountInput {
  id: string;
  name: string;
  type: AccountType;
  parent_id?: string | null;
  subtype?: string | null;
  bank_name?: string | null;
  account_number_masked?: string | null;
  due_day?: number | null;
  statement_day?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateAccountMetadataPatch {
  due_day?: number | null;
  statement_day?: number | null;
  account_number_masked?: string | null;
  bank_name?: string | null;
  metadata?: Record<string, unknown>;
}

export function findAccountById(db: Database.Database, id: string): AccountRow | null {
  return (
    (db
      .prepare(`SELECT ${ACCOUNT_COLUMNS_SQL} FROM accounts a WHERE a.id = ?`)
      .get(id) as AccountRow | undefined) ?? null
  );
}

export function accountExists(db: Database.Database, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM accounts WHERE id = ? LIMIT 1`).get(id);
}

export function countAccounts(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM accounts`).get() as { n: number };
  return row.n;
}

export function listAccounts(db: Database.Database): AccountRow[] {
  return db
    .prepare(`SELECT ${ACCOUNT_COLUMNS_SQL} FROM accounts a ORDER BY a.name`)
    .all() as AccountRow[];
}

export function countChildAccounts(db: Database.Database, parentId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?`)
    .get(parentId) as { n: number };
  return row.n;
}

export function getAccountSubtree(db: Database.Database, rootId: string): AccountRow[] {
  return db.prepare(
    `WITH RECURSIVE subtree AS (
       SELECT * FROM accounts WHERE id = ?
       UNION ALL
       SELECT a.* FROM accounts a JOIN subtree s ON a.parent_id = s.id
     )
     SELECT ${ACCOUNT_COLUMNS_SQL} FROM subtree a ORDER BY a.id`,
  ).all(rootId) as AccountRow[];
}

/** Currency heads that actually hold accounts, lowercase; never derived from config. */
export function listLedgerCurrencies(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT substr(id,1,3) AS currency FROM accounts ORDER BY currency`)
    .all() as { currency: string }[];
  return rows.map((r) => r.currency);
}

/** Half-open range seek on the primary key (';' is the byte after ':'), not a full scan. */
export function ledgerExists(db: Database.Database, currency: string): boolean {
  const lower = currency.toLowerCase();
  return !!db
    .prepare(`SELECT 1 FROM accounts WHERE id >= ? AND id < ? LIMIT 1`)
    .get(`${lower}:`, `${lower};`);
}

/** `inserted: false` means the id was already taken; user-facing wording and hierarchy invariants are the caller's (`createAccount`). */
export function insertAccount(
  db: Database.Database,
  input: CreateAccountInput,
): { inserted: boolean } {
  try {
    db.prepare(
      `INSERT INTO accounts (id, name, type, parent_id, subtype, bank_name, account_number_masked, due_day, statement_day, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.name,
      input.type,
      input.parent_id ?? null,
      input.subtype ?? null,
      input.bank_name ? String(input.bank_name).toUpperCase() : null,
      normalizeMaskedAccountNumber(input.account_number_masked),
      input.due_day ?? null,
      input.statement_day ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
    return { inserted: true };
  } catch (err) {
    // Only the taken-id case is data; a CHECK/FK abort is a broken invariant, not a duplicate.
    if (errorMessage(err).includes("UNIQUE")) return { inserted: false };
    throw err;
  }
}

/** Idempotent via `ON CONFLICT(id) DO NOTHING`: a concurrent writer claiming the id between check and insert is a lost race, not a broken invariant. */
export function insertStructuralAccount(
  db: Database.Database,
  row: { id: string; name: string; type: AccountType; parent_id: string | null },
): void {
  db.prepare(
    `INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(row.id, row.name, row.type, row.parent_id);
}

export function renameAccount(db: Database.Database, id: string, name: string): number {
  return db.prepare(`UPDATE accounts SET name = ? WHERE id = ?`).run(name, id).changes;
}

interface UpdateAccountMetadataResult {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

const ACCOUNT_PATCH: Record<string, PatchField> = {
  due_day: {},
  statement_day: {},
  account_number_masked: {
    transform: (v) => normalizeMaskedAccountNumber(v as string | null),
  },
  bank_name: {
    transform: (v) => (v == null ? null : String(v).toUpperCase()),
  },
};

/** Returns before/after snapshots of touched fields; `metadata` is
 *  shallow-merged into the existing metadata_json blob. */
export function updateAccountMetadata(
  db: Database.Database,
  id: string,
  patch: UpdateAccountMetadataPatch,
): UpdateAccountMetadataResult {
  const current = findAccountById(db, id);
  if (!current) throw new Error(`Account "${id}" not found.`);

  const { sets, params, before, after } = buildPatch(ACCOUNT_PATCH, current, patch);

  if (patch.metadata !== undefined) {
    // A corrupt blob must error, not be silently overwritten with {}.
    let existing: Record<string, unknown> = {};
    if (current.metadata_json != null) {
      const parsed = parseJsonOrNull(current.metadata_json);
      if (parsed == null || typeof parsed !== "object") {
        throw new Error(`Account "${id}" has unreadable metadata_json; refusing to overwrite it.`);
      }
      existing = parsed as Record<string, unknown>;
    }
    const merged = { ...existing, ...patch.metadata };
    sets.push("metadata_json = ?");
    params.push(JSON.stringify(merged));
    before.metadata = existing;
    after.metadata = merged;
  }

  if (sets.length === 0) return { before, after };
  params.push(id);
  db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return { before, after };
}

/** Deletes the row alone; transaction/child guards are the caller's (src/accounts/accounts.ts). */
export function deleteAccount(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id).changes > 0;
}
