import type Database from "libsql";
import { randomUUID } from "crypto";
import { clampLimit, clampOffset } from "../../lib/limit.js";

export interface MerchantUpsertInput {
  canonical_name: string;
  alias?: string;
  default_account_id?: string | null;
}

export interface MerchantRow {
  id: string;
  canonical_name: string;
  default_account_id: string | null;
  created_at: string;
}

interface MerchantAliasConflict {
  pattern: string;
  held_by: string;
}

interface MerchantUpsertResult extends MerchantRow {
  /** Present when `input.alias` normalizes to a pattern already claimed by a
   *  different merchant; the alias is left on its current owner. */
  alias_conflict?: MerchantAliasConflict;
}

/**
 * Strips store ids, terminal codes, city tags, and transaction-type words so
 * "STARBUCKS #1234 BKK CHARGE" and "Starbucks #5678 BANGKOK" both normalize
 * to "starbucks": the form `merchant_aliases.normalized_pattern` indexes.
 */
const NOISE_TOKENS = new Set([
  "bkk", "bangkok", "thailand", "th", "tha",
  "charge", "purchase", "payment", "pmt", "ref", "txn", "trx", "tx",
  "pos", "atm", "online", "web", "mobile", "app",
  "co", "ltd", "company", "inc", "llc", "plc", "intl",
]);

export function normalizeDescriptor(raw: string): string {
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  const stripped = lowered
    .replace(/[#*][a-z0-9]+/gi, " ")
    .replace(/\b\d{2,}\b/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  const tokens = stripped.split(" ").filter(t => t.length > 1 && !NOISE_TOKENS.has(t));
  if (tokens.length === 0) return stripped;
  return tokens.join(" ");
}

/**
 * Meant to run inside the same DB transaction as the write it serves, so a
 * transaction never lands without its merchant.
 */
export function upsertMerchant(
  db: Database.Database,
  input: MerchantUpsertInput,
): MerchantUpsertResult {
  const canonical = input.canonical_name.trim();
  if (!canonical) {
    throw new Error("merchant canonical_name is required");
  }

  const existing = db
    .prepare(`SELECT id, canonical_name, default_account_id, created_at FROM merchants WHERE canonical_name = ?`)
    .get(canonical) as MerchantRow | undefined;

  let merchant: MerchantRow;
  if (existing) {
    merchant = existing;
    if (input.default_account_id && input.default_account_id !== existing.default_account_id) {
      db.prepare(`UPDATE merchants SET default_account_id = ? WHERE id = ?`)
        .run(input.default_account_id, existing.id);
      merchant = { ...existing, default_account_id: input.default_account_id };
    }
  } else {
    const id = `m:${randomUUID()}`;
    db.prepare(
      `INSERT INTO merchants (id, canonical_name, default_account_id) VALUES (?, ?, ?)`,
    ).run(id, canonical, input.default_account_id ?? null);
    merchant = {
      id,
      canonical_name: canonical,
      default_account_id: input.default_account_id ?? null,
      created_at: new Date().toISOString(),
    };
  }

  const aliasConflict = input.alias ? claimAlias(db, merchant.id, input.alias) : undefined;
  return aliasConflict ? { ...merchant, alias_conflict: aliasConflict } : merchant;
}

/**
 * Claims `rawText`'s normalized pattern for a merchant. A pattern already held
 * by another merchant stays with its owner and is reported as a conflict; one
 * the merchant already holds is a no-op.
 */
export function claimAlias(
  db: Database.Database,
  merchantId: string,
  rawText: string,
): MerchantAliasConflict | undefined {
  const normalized = normalizeDescriptor(rawText);
  if (!normalized) return undefined;
  const holder = db
    .prepare(`SELECT merchant_id FROM merchant_aliases WHERE normalized_pattern = ?`)
    .get(normalized) as { merchant_id: string } | undefined;
  if (!holder) {
    db.prepare(
      `INSERT INTO merchant_aliases (id, merchant_id, normalized_pattern) VALUES (?, ?, ?)`,
    ).run(`ma:${randomUUID()}`, merchantId, normalized);
    return undefined;
  }
  return holder.merchant_id !== merchantId
    ? { pattern: normalized, held_by: holder.merchant_id }
    : undefined;
}

export function findMerchantByName(db: Database.Database, name: string): MerchantRow | null {
  const row = db
    .prepare(`SELECT id, canonical_name, default_account_id, created_at FROM merchants WHERE canonical_name = ?`)
    .get(name.trim()) as MerchantRow | undefined;
  return row ?? null;
}

interface RenameMerchantResult {
  before: string;
  after: string;
  /** The old name's pattern was already claimed by another merchant. */
  alias_conflict?: MerchantAliasConflict;
}

/**
 * Renames a merchant and keeps the old name as an alias, so raw descriptors
 * that produced the old name still resolve to the same merchant. Display names
 * are a live join, so no transaction rows need touching. Callers own the
 * not-found and name-collision checks; this asserts them as invariants.
 */
export function renameMerchant(
  db: Database.Database,
  id: string,
  name: string,
): RenameMerchantResult {
  const canonical = name.trim();
  if (!canonical) throw new Error("merchant canonical_name is required");
  const current = findMerchantById(db, id);
  if (!current) throw new Error(`merchant "${id}" not found`);
  if (current.canonical_name === canonical) {
    return { before: current.canonical_name, after: canonical };
  }

  const result = db.transaction(() => {
    db.prepare(`UPDATE merchants SET canonical_name = ? WHERE id = ?`).run(canonical, id);
    const conflict = claimAlias(db, id, current.canonical_name);
    return conflict
      ? { before: current.canonical_name, after: canonical, alias_conflict: conflict }
      : { before: current.canonical_name, after: canonical };
  })();
  return result;
}

interface MerchantWithDefault {
  merchant: MerchantRow;
  default_account_id: string | null;
}

export function findMerchantByAlias(
  db: Database.Database,
  rawDescriptor: string,
): MerchantWithDefault | null {
  const normalized = normalizeDescriptor(rawDescriptor);
  if (!normalized) return null;

  const row = db.prepare(
    `SELECT m.id, m.canonical_name, m.default_account_id, m.created_at
     FROM merchant_aliases ma
     JOIN merchants m ON m.id = ma.merchant_id
     WHERE ma.normalized_pattern = ?`,
  ).get(normalized) as MerchantRow | undefined;

  if (!row) return null;
  return { merchant: row, default_account_id: row.default_account_id };
}

interface ListMerchantsOptions {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

export function clampMerchantsLimit(limit?: number): number {
  return clampLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
}

export function listMerchants(
  db: Database.Database,
  opts: ListMerchantsOptions = {},
): (MerchantRow & { alias_count: number })[] {
  const limit = clampMerchantsLimit(opts.limit);
  return db.prepare(
    `SELECT m.id, m.canonical_name, m.default_account_id, m.created_at,
            (SELECT COUNT(*) FROM merchant_aliases ma WHERE ma.merchant_id = m.id) AS alias_count
     FROM merchants m
     ORDER BY m.canonical_name
     LIMIT ? OFFSET ?`,
  ).all(limit, clampOffset(opts.offset)) as (MerchantRow & { alias_count: number })[];
}

export function countMerchants(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM merchants`).get() as { n: number };
  return row.n;
}

export function merchantExists(db: Database.Database, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM merchants WHERE id = ?`).get(id);
}

export function findMerchantById(
  db: Database.Database,
  id: string,
): MerchantRow | null {
  const row = db
    .prepare(`SELECT id, canonical_name, default_account_id, created_at FROM merchants WHERE id = ?`)
    .get(id) as MerchantRow | undefined;
  return row ?? null;
}

export function setMerchantDefaultAccount(
  db: Database.Database,
  merchantId: string,
  accountId: string,
): { before: string | null; after: string } {
  const before = db
    .prepare(`SELECT default_account_id FROM merchants WHERE id = ?`)
    .get(merchantId) as { default_account_id: string | null } | undefined;
  if (!before) throw new Error(`merchant not found: ${merchantId}`);
  db.prepare(`UPDATE merchants SET default_account_id = ? WHERE id = ?`)
    .run(accountId, merchantId);
  return { before: before.default_account_id, after: accountId };
}

export function clearMerchantDefaultAccount(
  db: Database.Database,
  merchantId: string,
): { before: string | null } | null {
  const row = db
    .prepare(`SELECT default_account_id FROM merchants WHERE id = ?`)
    .get(merchantId) as { default_account_id: string | null } | undefined;
  if (!row) return null;
  db.prepare(`UPDATE merchants SET default_account_id = NULL WHERE id = ?`).run(merchantId);
  return { before: row.default_account_id };
}

interface MergeMerchantsResult {
  moved_transactions: number;
  moved_aliases: number;
  /** Present only when the destination had no default_account_id and the
   *  source's was adopted in its place. */
  adopted_default_account?: string;
}

/** One transaction, so a partial merge never persists. */
export function mergeMerchants(
  db: Database.Database,
  fromId: string,
  toId: string,
): MergeMerchantsResult {
  if (fromId === toId) throw new Error("Cannot merge a merchant into itself.");
  const from = findMerchantById(db, fromId);
  if (!from) throw new Error(`Source merchant ${fromId} not found.`);
  const to = findMerchantById(db, toId);
  if (!to) throw new Error(`Destination merchant ${toId} not found.`);

  let movedTransactions = 0;
  let movedAliases = 0;
  let adoptedDefaultAccount: string | undefined;
  const tx = db.transaction((): void => {
    movedTransactions = db
      .prepare(`UPDATE transactions SET merchant_id = ? WHERE merchant_id = ?`)
      .run(toId, fromId).changes;
    movedAliases = db
      .prepare(`UPDATE merchant_aliases SET merchant_id = ? WHERE merchant_id = ?`)
      .run(toId, fromId).changes;
    if (!to.default_account_id && from.default_account_id) {
      db.prepare(`UPDATE merchants SET default_account_id = ? WHERE id = ?`)
        .run(from.default_account_id, toId);
      adoptedDefaultAccount = from.default_account_id;
    }
    db.prepare(`DELETE FROM merchants WHERE id = ?`).run(fromId);
  });
  tx();

  return {
    moved_transactions: movedTransactions,
    moved_aliases: movedAliases,
    ...(adoptedDefaultAccount ? { adopted_default_account: adoptedDefaultAccount } : {}),
  };
}
