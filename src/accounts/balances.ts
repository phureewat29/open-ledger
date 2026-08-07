import { groupBy, partition } from "es-toolkit";
import type Database from "libsql";
import {
  findAccountById,
  getAccountSubtree,
  type AccountRow,
  type AccountType,
} from "../db/queries/accounts.js";
import {
  getAccountLegSums,
  getLegSumsForAccounts,
  getPeriodLegSums,
  type AccountLegSumsOptions,
} from "../db/queries/balances.js";
import { insertTransaction } from "../db/queries/transactions.js";
import { currencyOf } from "../lib/ids.js";
import { fromMinorUnits, toMinorUnits } from "../lib/money.js";
import { todayIso, ISO_DATE_RE } from "../lib/date.js";
import { ensureStructuralAccount, structuralAccountId } from "./accounts.js";

export interface AccountBalanceMinor extends AccountRow {
  /** Minor units. */
  debits_posted: number;
  /** Minor units. */
  credits_posted: number;
  balance_minor: number;
  balance: number;
}

/** Per-currency integer minor units; never summed across keys. Decimals only
 *  appear at the CLI boundary, through `toDecimalTotals`. */
export type CurrencyTotals = Record<string, number>;

interface NetWorth {
  assets: CurrencyTotals;
  liabilities: CurrencyTotals;
  net_worth: CurrencyTotals;
}

interface PeriodTotals {
  income: CurrencyTotals;
  expenses: CurrencyTotals;
}

function addMinor(totals: CurrencyTotals, currency: string, minor: number): void {
  totals[currency] = (totals[currency] ?? 0) + minor;
}

/** Per-currency `a - b` over the union of both key sets; nothing collapses across keys. */
export function subtractTotals(a: CurrencyTotals, b: CurrencyTotals): CurrencyTotals {
  const out: CurrencyTotals = {};
  for (const [currency, minor] of Object.entries(a)) addMinor(out, currency, minor);
  for (const [currency, minor] of Object.entries(b)) addMinor(out, currency, -minor);
  return out;
}

/** Normal-balance rule: asset/expense are debit-normal, others credit-normal. */
function isDebitNormal(type: AccountType): boolean {
  return ["asset", "expense"].includes(type);
}

/** Signed balance in minor units, from the account type's normal side. */
function balanceMinor(type: AccountType, sumDebit: number, sumCredit: number): number {
  return isDebitNormal(type) ? sumDebit - sumCredit : sumCredit - sumDebit;
}

/** `balance` is the decimal of `balance_minor` under the account's own currency exponent. */
export function getAccountBalances(
  db: Database.Database,
  opts: AccountLegSumsOptions = {},
): AccountBalanceMinor[] {
  return getAccountLegSums(db, opts).map((r) => {
    const { sum_debit, sum_credit, ...account } = r;
    const balance_minor = balanceMinor(r.type, sum_debit, sum_credit);
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
  const assets: CurrencyTotals = {};
  const liabilities: CurrencyTotals = {};
  for (const b of getAccountBalances(db)) {
    if (b.type === "asset") addMinor(assets, b.currency, b.balance_minor);
    else if (b.type === "liability") addMinor(liabilities, b.currency, b.balance_minor);
  }
  return { assets, liabilities, net_worth: subtractTotals(assets, liabilities) };
}

export function getPeriodTotals(
  db: Database.Database,
  from: string,
  to: string,
): PeriodTotals {
  const income: CurrencyTotals = {};
  const expenses: CurrencyTotals = {};
  for (const r of getPeriodLegSums(db, from, to)) {
    // Guards against a future query widening booking an unexpected type as expense via the else.
    if (r.type !== "income" && r.type !== "expense") continue;
    const totals = r.type === "income" ? income : expenses;
    addMinor(totals, r.currency, balanceMinor(r.type, r.sum_debit, r.sum_credit));
  }
  return { income, expenses };
}

/** Single-currency by the id grammar, but derived here, not assumed. */
export function getRollupBalance(db: Database.Database, rootId: string): CurrencyTotals {
  const totals: CurrencyTotals = {};
  const subtree = getAccountSubtree(db, rootId);
  if (subtree.length === 0) return totals;

  for (const r of getLegSumsForAccounts(db, subtree.map((a) => a.id))) {
    addMinor(totals, r.currency, balanceMinor(r.type, r.sum_debit, r.sum_credit));
  }
  return totals;
}

export interface BalanceTreeNode {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  balance_minor: number;
  /** This account's balance plus every descendant's. */
  rollup: CurrencyTotals;
  children: BalanceTreeNode[];
}

function treeNode(
  row: AccountBalanceMinor,
  childrenByParent: Record<string, AccountBalanceMinor[]>,
): BalanceTreeNode {
  const children = (childrenByParent[row.id] ?? []).map((child) =>
    treeNode(child, childrenByParent),
  );
  const rollup: CurrencyTotals = {};
  for (const child of children) {
    for (const [currency, minor] of Object.entries(child.rollup)) addMinor(rollup, currency, minor);
  }
  addMinor(rollup, row.currency, row.balance_minor);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    balance_minor: row.balance_minor,
    rollup,
    children,
  };
}

/** A row whose parent is outside the selection becomes a root here. */
export function getBalanceTree(
  db: Database.Database,
  opts: AccountLegSumsOptions = {},
): BalanceTreeNode[] {
  const rows = getAccountBalances(db, opts);
  const selected = new Set(rows.map((r) => r.id));
  const [children, roots] = partition(rows, (r) => !!r.parent_id && selected.has(r.parent_id));
  // Every account id carries a colon, so no key here collides with Object.prototype.
  const childrenByParent = groupBy(children, (r) => r.parent_id!);
  return roots.map((row) => treeNode(row, childrenByParent));
}

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

/** Ledger comes from the target account, never config; delta math is integer minor units. */
export function adjustAccountBalance(
  db: Database.Database,
  opts: AdjustAccountBalanceOpts,
): AdjustAccountBalanceResult {
  const account = findAccountById(db, opts.accountId);
  if (!account) throw new Error(`Account "${opts.accountId}" not found.`);

  const currency = currencyOf(account.id);
  const adjustmentsId = structuralAccountId(currency, "adjustments");
  if (account.id === adjustmentsId) {
    throw new Error(
      `Account "${adjustmentsId}" is the balancing side of every adjustment on its own ledger, ` +
        "so adjusting it would need both legs on one account. Adjust the account that is wrong instead.",
    );
  }

  const currentMinor =
    getAccountBalances(db, { idOrParent: account.id }).find((b) => b.id === account.id)
      ?.balance_minor ?? 0;
  const targetMinor = toMinorUnits(opts.targetAmount, currency);
  const deltaMinor = targetMinor - currentMinor;
  if (deltaMinor === 0) return { transactionId: null, delta: 0 };

  const amount = Math.abs(deltaMinor);
  const debitNormal = isDebitNormal(account.type);
  const accountIsDebit = (debitNormal && deltaMinor > 0) || (!debitNormal && deltaMinor < 0);

  const date =
    opts.date && ISO_DATE_RE.test(opts.date) ? opts.date : todayIso();
  const reason = String(opts.reason || "Balance adjustment").trim();

  let transactionId = "";
  const tx = db.transaction((): void => {
    ensureStructuralAccount(db, currency, "adjustments");
    transactionId = insertTransaction(db, {
      date,
      description: reason,
      debit_account_id: accountIsDebit ? account.id : adjustmentsId,
      credit_account_id: accountIsDebit ? adjustmentsId : account.id,
      amount,
    }).id;
  });
  tx();

  return { transactionId, delta: fromMinorUnits(deltaMinor, currency) };
}
