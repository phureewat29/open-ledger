import type Database from "libsql";
import { config } from "../../config.js";
import { parseJsonOrNull } from "../../lib/json.js";
import { normalizeMaskedAccountNumber } from "../../lib/masked.js";
import { buildPatch, type PatchField } from "../../lib/patch.js";
import { errorMessage } from "../../lib/result.js";

/**
 * At-rest form: uppercased bank_name, check-digit-normalized masked number, JSON
 * metadata. Parenting policy lives in src/accounts/accounts.ts, not here.
 */
export type AccountType = "asset" | "liability" | "income" | "expense" | "equity";

export const TOP_LEVEL_TYPES: ReadonlyArray<AccountType> = [
  "asset", "liability", "income", "expense", "equity",
];

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
  points_balance: number | null;
  metadata_json: string | null;
  pii_flag: number;
  has_question: number;
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
  currency?: string;
  due_day?: number | null;
  statement_day?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateAccountMetadataPatch {
  due_day?: number | null;
  statement_day?: number | null;
  points_balance?: number | null;
  account_number_masked?: string | null;
  bank_name?: string | null;
  metadata?: Record<string, unknown>;
}

export function findAccountById(db: Database.Database, id: string): AccountRow | null {
  return (db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined) ?? null;
}

export function accountExists(db: Database.Database, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM accounts WHERE id = ? LIMIT 1`).get(id);
}

export function countAccounts(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM accounts`).get() as { n: number };
  return row.n;
}

export function listAccounts(db: Database.Database): AccountRow[] {
  return db.prepare(`SELECT * FROM accounts ORDER BY name`).all() as AccountRow[];
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
     SELECT * FROM subtree ORDER BY id`,
  ).all(rootId) as AccountRow[];
}

/** The currency a transaction leg inherits from its account. */
export function findAccountCurrency(db: Database.Database, id: string): string | null {
  const row = db.prepare(`SELECT currency FROM accounts WHERE id = ?`).get(id) as
    | { currency: string }
    | undefined;
  return row?.currency ?? null;
}

/** A duplicate id surfaces as an Error coded 'ACCOUNT_EXISTS'. Hierarchy
 *  invariants are the caller's (`createAccount`). */
export function insertAccount(db: Database.Database, input: CreateAccountInput): void {
  try {
    db.prepare(
      `INSERT INTO accounts (id, name, type, parent_id, subtype, bank_name, account_number_masked, currency, due_day, statement_day, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.name,
      input.type,
      input.parent_id ?? null,
      input.subtype ?? null,
      input.bank_name ? String(input.bank_name).toUpperCase() : null,
      normalizeMaskedAccountNumber(input.account_number_masked),
      input.currency ?? config.displayCurrency,
      input.due_day ?? null,
      input.statement_day ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
  } catch (err) {
    const message = errorMessage(err);
    if (message.includes("UNIQUE")) {
      const dup = new Error(`Account "${input.id}" already exists.`) as Error & { code?: string };
      dup.code = "ACCOUNT_EXISTS";
      throw dup;
    }
    throw err;
  }
}

/** Currency and the rest deliberately take the schema defaults. */
export function insertStructuralAccount(
  db: Database.Database,
  row: { id: string; name: string; type: AccountType; parent_id: string | null },
): void {
  db.prepare(
    `INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`,
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
  points_balance: {},
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
