import type Database from "libsql";
import {
  findAccountById,
  getAccountSubtree,
  type AccountRow,
} from "../db/queries/accounts.js";
import {
  getAccountLegSums,
  getLegSumsForAccounts,
  getPeriodLegSums,
  type AccountLegSumsOptions,
} from "../db/queries/balances.js";
import { insertTransaction } from "../db/queries/transactions.js";
import { config } from "../config.js";
import { fromMinorUnits, toMinorUnits } from "../lib/money.js";
import { todayIso, ISO_DATE_RE } from "../lib/date.js";
import { ensureStructuralAccount } from "./accounts.js";

export interface AccountBalanceMinor extends AccountRow {
  /** Minor units. */
  debits_posted: number;
  /** Minor units. */
  credits_posted: number;
  balance_minor: number;
  balance: number;
}

interface NetWorth {
  assets: number;
  liabilities: number;
  net_worth: number;
}

interface PeriodTotals {
  income: number;
  expenses: number;
}

/**
 * Shared normal-balance rule: asset/expense are debit-normal, the rest
 * credit-normal. Leg sums are integer minor units; every decimal here comes
 * from the account's currency exponent (`fromMinorUnits`).
 */
export function getAccountBalances(
  db: Database.Database,
  opts: AccountLegSumsOptions = {},
): AccountBalanceMinor[] {
  return getAccountLegSums(db, opts).map((r) => {
    const debitNormal = r.type === "asset" || r.type === "expense";
    const balance_minor = debitNormal ? r.sum_debit - r.sum_credit : r.sum_credit - r.sum_debit;
    const { sum_debit, sum_credit, ...account } = r;
    return {
      ...(account as AccountRow),
      debits_posted: sum_debit,
      credits_posted: sum_credit,
      balance_minor,
      balance: fromMinorUnits(balance_minor, account.currency),
    };
  });
}

export function getNetWorth(db: Database.Database): NetWorth {
  const balances = getAccountBalances(db);
  let assets = 0;
  let liabilities = 0;
  for (const b of balances) {
    if (b.type === "asset") assets += b.balance;
    else if (b.type === "liability") liabilities += b.balance;
  }
  return { assets, liabilities, net_worth: assets - liabilities };
}

/**
 * Income (credits - debits) and expenses (debits - credits) over a date range.
 * Grouped by (type, currency) so each currency converts with its own exponent.
 */
export function getPeriodTotals(
  db: Database.Database,
  from: string,
  to: string,
): PeriodTotals {
  let income = 0;
  let expenses = 0;
  for (const r of getPeriodLegSums(db, from, to)) {
    if (r.type === "income") income += fromMinorUnits(r.c_minus_d, r.currency);
    else if (r.type === "expense") expenses += fromMinorUnits(-r.c_minus_d, r.currency);
  }
  return { income, expenses };
}

/** Subtree balance (root inclusive), grouped by (type, currency) for correct conversion. */
export function getRollupBalance(db: Database.Database, rootId: string): number {
  const subtree = getAccountSubtree(db, rootId);
  if (subtree.length === 0) return 0;

  let total = 0;
  for (const r of getLegSumsForAccounts(db, subtree.map((a) => a.id))) {
    const debitNormal = r.type === "asset" || r.type === "expense";
    const minor = debitNormal ? r.sum_debit - r.sum_credit : r.sum_credit - r.sum_debit;
    total += fromMinorUnits(minor, r.currency);
  }
  return total;
}

const EQUITY_ADJUST_ID = "equity:adjustments";

interface AdjustAccountBalanceOpts {
  accountId: string;
  /** New desired balance in the account's currency, decimal, natural sign. */
  targetAmount: number;
  reason: string;
  /** ISO YYYY-MM-DD. Defaults to today. */
  date?: string;
}

interface AdjustAccountBalanceResult {
  /** Id of the balancing transaction, or null when already at target (no-op). */
  transactionId: string | null;
  /** target - current, decimal, natural sign. 0 on no-op. */
  delta: number;
}

/**
 * Moves an account to `targetAmount` by posting one balancing transaction
 * against `equity:adjustments`. Delta math is integer minor units (no float
 * drift); a zero delta is a no-op.
 */
export function adjustAccountBalance(
  db: Database.Database,
  opts: AdjustAccountBalanceOpts,
): AdjustAccountBalanceResult {
  const account = findAccountById(db, opts.accountId);
  if (!account) throw new Error(`Account "${opts.accountId}" not found.`);

  const target = Number(opts.targetAmount);
  if (!Number.isFinite(target)) {
    throw new Error(`targetAmount must be a number, got ${JSON.stringify(opts.targetAmount)}.`);
  }

  const currency = account.currency || config.displayCurrency;
  const currentMinor =
    getAccountBalances(db, { idOrParent: account.id }).find((b) => b.id === account.id)
      ?.balance_minor ?? 0;
  const targetMinor = toMinorUnits(target, currency);
  const deltaMinor = targetMinor - currentMinor;
  if (deltaMinor === 0) return { transactionId: null, delta: 0 };

  const amount = Math.abs(deltaMinor);
  const debitNormal = account.type === "asset" || account.type === "expense";
  const accountIsDebit = (debitNormal && deltaMinor > 0) || (!debitNormal && deltaMinor < 0);
  const debitAccountId = accountIsDebit ? account.id : EQUITY_ADJUST_ID;
  const creditAccountId = accountIsDebit ? EQUITY_ADJUST_ID : account.id;

  const date =
    opts.date && ISO_DATE_RE.test(opts.date) ? opts.date : todayIso();
  const reason = String(opts.reason || "Balance adjustment").trim();

  let transactionId = "";
  const tx = db.transaction((): void => {
    ensureStructuralAccount(db, "equity:adjustments");
    transactionId = insertTransaction(db, {
      date,
      description: reason,
      debit_account_id: debitAccountId,
      credit_account_id: creditAccountId,
      amount,
      currency,
    }).id;
  });
  tx();

  return { transactionId, delta: fromMinorUnits(deltaMinor, currency) };
}
