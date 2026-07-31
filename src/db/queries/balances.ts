import type Database from "libsql";
import {
  ACCOUNT_COLUMNS_SQL,
  ACCOUNT_CURRENCY_SQL,
  type AccountRow,
  type AccountType,
} from "./accounts.js";

// Leg expansion only: the normal-balance rule and decimal conversion are the caller's (src/accounts/balances.ts).

/** Debit + credit legs of every non-void transaction, one row per leg (`void_of`
 *  rows excluded so a merged mirror never double-counts). */
const TRANSACTION_LEGS = `SELECT debit_account_id  AS acct, amount, date, 'D' AS side FROM transactions WHERE void_of IS NULL
       UNION ALL
       SELECT credit_account_id AS acct, amount, date, 'C' AS side FROM transactions WHERE void_of IS NULL`;

interface AccountLegSums extends AccountRow {
  /** Minor units. */
  sum_debit: number;
  /** Minor units. */
  sum_credit: number;
}

export interface AccountLegSumsOptions {
  type?: AccountType;
  /** The account itself, or any account whose parent it is. */
  idOrParent?: string;
}

/** Per-account leg sums, including accounts with no legs at all (LEFT JOIN). */
export function getAccountLegSums(
  db: Database.Database,
  opts: AccountLegSumsOptions = {},
): AccountLegSums[] {
  const params: any[] = [];
  const where: string[] = [];
  if (opts.type) {
    where.push("a.type = ?");
    params.push(opts.type);
  }
  if (opts.idOrParent) {
    where.push("(a.id = ? OR a.parent_id = ?)");
    params.push(opts.idOrParent, opts.idOrParent);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  return db
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS_SQL},
              COALESCE(SUM(CASE WHEN t.side = 'D' THEN t.amount ELSE 0 END), 0) AS sum_debit,
              COALESCE(SUM(CASE WHEN t.side = 'C' THEN t.amount ELSE 0 END), 0) AS sum_credit
         FROM accounts a
         LEFT JOIN (${TRANSACTION_LEGS}) t ON t.acct = a.id
         ${whereSql}
         GROUP BY a.id
         ORDER BY a.type, a.id`,
    )
    .all(...params) as AccountLegSums[];
}

interface TypeCurrencyLegSums {
  type: AccountType;
  currency: string;
  sum_debit: number;
  sum_credit: number;
}

/**
 * Income and expense legs dated within `from`..`to`, summed per
 * (type, currency) so each ledger is netted and converted on its own.
 */
export function getPeriodLegSums(
  db: Database.Database,
  from: string,
  to: string,
): TypeCurrencyLegSums[] {
  return db
    .prepare(
      `SELECT a.type AS type, ${ACCOUNT_CURRENCY_SQL} AS currency,
              COALESCE(SUM(CASE WHEN t.side = 'D' THEN t.amount ELSE 0 END), 0) AS sum_debit,
              COALESCE(SUM(CASE WHEN t.side = 'C' THEN t.amount ELSE 0 END), 0) AS sum_credit
         FROM (${TRANSACTION_LEGS}) t
         JOIN accounts a ON a.id = t.acct
         WHERE t.date BETWEEN ? AND ? AND a.type IN ('income', 'expense')
         GROUP BY a.type, ${ACCOUNT_CURRENCY_SQL}`,
    )
    .all(from, to) as TypeCurrencyLegSums[];
}

/** Leg sums for a set of accounts (a subtree), grouped by (type, currency). */
export function getLegSumsForAccounts(
  db: Database.Database,
  ids: string[],
): TypeCurrencyLegSums[] {
  // An empty IN () is a syntax error, and no accounts means no legs.
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");

  return db
    .prepare(
      `SELECT a.type AS type, ${ACCOUNT_CURRENCY_SQL} AS currency,
              COALESCE(SUM(CASE WHEN t.side = 'D' THEN t.amount ELSE 0 END), 0) AS sum_debit,
              COALESCE(SUM(CASE WHEN t.side = 'C' THEN t.amount ELSE 0 END), 0) AS sum_credit
         FROM accounts a
         LEFT JOIN (${TRANSACTION_LEGS}) t ON t.acct = a.id
         WHERE a.id IN (${placeholders})
         GROUP BY a.type, ${ACCOUNT_CURRENCY_SQL}`,
    )
    .all(...ids) as TypeCurrencyLegSums[];
}
