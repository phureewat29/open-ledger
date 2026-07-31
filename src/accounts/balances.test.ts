import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { findAccountById } from "../db/queries/accounts.js";
import { createAccount } from "./accounts.js";
import {
  getAccountBalances,
  getBalanceTree,
  getNetWorth,
  getPeriodTotals,
  getRollupBalance,
  adjustAccountBalance,
  subtractTotals,
  type BalanceTreeNode,
} from "./balances.js";
import {
  findTransactionById,
  insertTransaction,
  type TransactionInput,
} from "../db/queries/transactions.js";
import { todayIso } from "../lib/date.js";
import { freshDb } from "../../fixtures/db.js";

function seedThb(db: Database.Database): void {
  createAccount(db, { id: "thb:asset:cash", name: "Cash", type: "asset", parent_id: "thb:asset" });
  createAccount(db, { id: "thb:asset:bank", name: "KBank Savings", type: "asset", parent_id: "thb:asset" });
  createAccount(db, { id: "thb:liability:card", name: "KTC Card", type: "liability", parent_id: "thb:liability" });
  createAccount(db, { id: "thb:income:salary", name: "Salary", type: "income", parent_id: "thb:income" });
  createAccount(db, { id: "thb:expense:food", name: "Food", type: "expense", parent_id: "thb:expense" });
  createAccount(db, { id: "thb:expense:food:dining", name: "Dining", type: "expense", parent_id: "thb:expense:food" });
  createAccount(db, { id: "thb:expense:food:groceries", name: "Groceries", type: "expense", parent_id: "thb:expense:food" });
}

/** A zero-exponent ledger: 15000 minor units is 15000 yen, not 150. */
function seedJpy(db: Database.Database): void {
  createAccount(db, { id: "jpy:asset:cash", name: "Yen Cash", type: "asset", parent_id: "jpy:asset" });
  createAccount(db, { id: "jpy:income:salary", name: "Yen Salary", type: "income", parent_id: "jpy:income" });
  createAccount(db, { id: "jpy:expense:food", name: "Yen Food", type: "expense", parent_id: "jpy:expense" });
}

function seedBoth(db: Database.Database): void {
  seedThb(db);
  seedJpy(db);
}

/** Two ledgers sharing an exponent: only the key set reveals a merge across them. */
function seedThbUsd(db: Database.Database): void {
  seedThb(db);
  createAccount(db, { id: "usd:asset:brokerage", name: "Brokerage", type: "asset", parent_id: "usd:asset" });
  createAccount(db, { id: "usd:liability:card", name: "US Card", type: "liability", parent_id: "usd:liability" });
  createAccount(db, { id: "usd:income:dividends", name: "Dividends", type: "income", parent_id: "usd:income" });
  createAccount(db, { id: "usd:expense:fees", name: "Fees", type: "expense", parent_id: "usd:expense" });
}

/** Satang-level balances: decimals only add up exactly while they stay integers. */
function seedManySatang(db: Database.Database): void {
  createAccount(db, { id: "thb:income:salary", name: "Salary", type: "income", parent_id: "thb:income" });
  for (const leaf of ["one", "two", "three"]) {
    createAccount(db, { id: `thb:asset:${leaf}`, name: leaf, type: "asset", parent_id: "thb:asset" });
  }
}

function ins(
  db: Database.Database,
  over: Partial<TransactionInput> &
    Pick<TransactionInput, "debit_account_id" | "credit_account_id" | "amount">,
): void {
  insertTransaction(db, { date: "2026-05-01", description: "x", ...over });
}

describe("getAccountBalances", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedBoth); });

  it("derives minor-unit + decimal balances per the normal-balance rule", () => {
    ins(db, { debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 15000 });
    const balances = getAccountBalances(db);

    const food = balances.find((b) => b.id === "thb:expense:food")!;
    expect(food.debits_posted).toBe(15000);
    expect(food.credits_posted).toBe(0);
    expect(food.balance_minor).toBe(15000); // debit-normal
    expect(food.balance).toBe(150);

    const cash = balances.find((b) => b.id === "thb:asset:cash")!;
    expect(cash.balance_minor).toBe(-15000); // asset debit-normal, only credited here
    expect(cash.balance).toBe(-150);
  });

  it("converts each row with the exponent of the currency in its id", () => {
    ins(db, { debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 15000 });
    ins(db, { debit_account_id: "jpy:expense:food", credit_account_id: "jpy:asset:cash", amount: 15000 });
    const balances = getAccountBalances(db);

    const thb = balances.find((b) => b.id === "thb:expense:food")!;
    const jpy = balances.find((b) => b.id === "jpy:expense:food")!;
    expect([thb.currency, jpy.currency]).toEqual(["THB", "JPY"]);
    expect(thb.balance_minor).toBe(jpy.balance_minor);
    expect(thb.balance).toBe(150);
    expect(jpy.balance).toBe(15000);
  });

  it("filters by type across every ledger", () => {
    const expenses = getAccountBalances(db, { type: "expense" });
    expect(expenses.every((b) => b.type === "expense")).toBe(true);
    expect(expenses.map((b) => b.id)).toContain("jpy:expense:food");
    expect(expenses.some((b) => b.id === "thb:asset:cash")).toBe(false);
  });

  it("filters to self + direct children by idOrParent", () => {
    const rows = getAccountBalances(db, { idOrParent: "thb:expense" });
    expect(rows.map((b) => b.id).sort()).toEqual(["thb:expense", "thb:expense:food"]);
  });
});

describe("getNetWorth", () => {
  it("reports assets, liabilities and their difference in minor units", () => {
    const db = freshDb(seedThb);
    ins(db, { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 100000 });
    ins(db, { debit_account_id: "thb:expense:food", credit_account_id: "thb:liability:card", amount: 50000 });
    expect(getNetWorth(db)).toEqual({
      assets: { THB: 100000 },
      liabilities: { THB: 50000 },
      net_worth: { THB: 50000 },
    });
  });

  it("keeps two ledgers apart even when they share an exponent", () => {
    const db = freshDb(seedThbUsd);
    ins(db, { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 11213025 });
    ins(db, { debit_account_id: "usd:asset:brokerage", credit_account_id: "usd:income:dividends", amount: 21000 });
    // 11234025 (a plausible-looking single number) is the answer a merge gives.
    expect(getNetWorth(db)).toEqual({
      assets: { THB: 11213025, USD: 21000 },
      liabilities: { THB: 0, USD: 0 },
      net_worth: { THB: 11213025, USD: 21000 },
    });
  });

  it("subtracts liabilities per ledger, over the union of both key sets", () => {
    const db = freshDb(seedThbUsd);
    ins(db, { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 100000 });
    ins(db, { debit_account_id: "usd:expense:fees", credit_account_id: "usd:liability:card", amount: 21000 });
    expect(getNetWorth(db).net_worth).toEqual({ THB: 100000, USD: -21000 });
  });

  it("names a ledger that has no minor units of its own", () => {
    const db = freshDb(seedBoth);
    ins(db, { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 100000 });
    ins(db, { debit_account_id: "jpy:asset:cash", credit_account_id: "jpy:income:salary", amount: 15000 });
    // 15000 yen and 100000 satang are the same integer scale and different money.
    expect(getNetWorth(db).net_worth).toEqual({ JPY: 15000, THB: 100000 });
  });

  it("totals in minor units, where adding the decimals would drift", () => {
    const db = freshDb(seedManySatang);
    for (const [leaf, amount] of [["one", 10], ["two", 20], ["three", 30]] as const) {
      ins(db, { debit_account_id: `thb:asset:${leaf}`, credit_account_id: "thb:income:salary", amount });
    }
    // 0.1 + 0.2 + 0.3 is 0.6000000000000001; the satang add is exact.
    expect(getNetWorth(db).assets).toEqual({ THB: 60 });
  });
});

describe("subtractTotals", () => {
  it("subtracts over the union of both key sets, not only the left one's", () => {
    // A ledger with expenses and no income exists as soon as one is idle; the
    // right key must survive, negated.
    expect(subtractTotals({}, { THB: 15000 })).toEqual({ THB: -15000 });
    expect(subtractTotals({ THB: 100000 }, { JPY: 15000 })).toEqual({ THB: 100000, JPY: -15000 });
  });

  it("nets shared keys and leaves the empty case empty", () => {
    expect(subtractTotals({ THB: 100000, USD: 21000 }, { THB: 15000 })).toEqual({
      THB: 85000,
      USD: 21000,
    });
    expect(subtractTotals({}, {})).toEqual({});
  });
});

describe("getPeriodTotals", () => {
  it("computes income (C-D) and expenses (D-C) inside the range only", () => {
    const db = freshDb(seedThb);
    ins(db, { debit_account_id: "thb:asset:cash", credit_account_id: "thb:income:salary", amount: 100000, date: "2026-05-10" });
    ins(db, { debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 15000, date: "2026-05-11" });
    ins(db, { debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 99900, date: "2026-07-01" });

    expect(getPeriodTotals(db, "2026-05-01", "2026-05-31")).toEqual({
      income: { THB: 100000 },
      expenses: { THB: 15000 },
    });
  });

  it("keeps each ledger's period total under its own key", () => {
    const db = freshDb(seedThbUsd);
    ins(db, { debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 15000, date: "2026-05-10" });
    ins(db, { debit_account_id: "usd:expense:fees", credit_account_id: "usd:asset:brokerage", amount: 15000, date: "2026-05-10" });
    expect(getPeriodTotals(db, "2026-05-01", "2026-05-31").expenses).toEqual({
      THB: 15000,
      USD: 15000,
    });
  });

  it("has no keys at all over a range nothing was posted in", () => {
    expect(getPeriodTotals(freshDb(seedThb), "2020-01-01", "2020-12-31")).toEqual({
      income: {},
      expenses: {},
    });
  });
});

describe("getRollupBalance", () => {
  it("sums a subtree (root inclusive)", () => {
    const db = freshDb(seedThb);
    ins(db, { debit_account_id: "thb:expense:food:dining", credit_account_id: "thb:asset:cash", amount: 35000 });
    ins(db, { debit_account_id: "thb:expense:food:groceries", credit_account_id: "thb:asset:cash", amount: 60000 });
    expect(getRollupBalance(db, "thb:expense:food")).toEqual({ THB: 95000 });
    expect(getRollupBalance(db, "thb:asset:cash")).toEqual({ THB: -95000 });
  });

  it("carries the subtree's own ledger, never a neighbouring one", () => {
    const db = freshDb(seedBoth);
    ins(db, { debit_account_id: "jpy:expense:food", credit_account_id: "jpy:asset:cash", amount: 35000 });
    ins(db, { debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 35000 });
    expect(getRollupBalance(db, "jpy:expense")).toEqual({ JPY: 35000 });
    expect(getRollupBalance(db, "thb:expense")).toEqual({ THB: 35000 });
  });

  it("has no keys for an account that does not exist", () => {
    expect(getRollupBalance(freshDb(seedThb), "thb:expense:nope")).toEqual({});
  });
});

describe("getBalanceTree", () => {
  function find(nodes: BalanceTreeNode[], id: string): BalanceTreeNode | undefined {
    for (const node of nodes) {
      if (node.id === id) return node;
      const hit = find(node.children, id);
      if (hit) return hit;
    }
    return undefined;
  }

  it("rolls a subtree up to its root, agreeing with getRollupBalance", () => {
    const db = freshDb(seedThb);
    ins(db, { debit_account_id: "thb:expense:food:dining", credit_account_id: "thb:asset:cash", amount: 35000 });
    ins(db, { debit_account_id: "thb:expense:food:groceries", credit_account_id: "thb:asset:cash", amount: 60000 });

    const tree = getBalanceTree(db);
    const food = find(tree, "thb:expense:food")!;
    expect(food.rollup).toEqual(getRollupBalance(db, "thb:expense:food"));
    expect(food.rollup).toEqual({ THB: 95000 });
    expect(food.balance_minor).toBe(0);
    expect(food.children.map((c) => c.id)).toEqual([
      "thb:expense:food:dining",
      "thb:expense:food:groceries",
    ]);
    expect(find(tree, "thb:expense")!.rollup).toEqual({ THB: 95000 });
  });

  it("gives every ledger its own roots, each rollup keyed by that ledger alone", () => {
    const db = freshDb(seedThbUsd);
    ins(db, { debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 15000 });
    ins(db, { debit_account_id: "usd:expense:fees", credit_account_id: "usd:asset:brokerage", amount: 21000 });

    const tree = getBalanceTree(db);
    expect(find(tree, "thb:expense")!.rollup).toEqual({ THB: 15000 });
    expect(find(tree, "usd:expense")!.rollup).toEqual({ USD: 21000 });
    // Type roots are the only parentless accounts, so both ledgers' roots sit flat at depth 0.
    expect(tree.every((root) => root.id.split(":").length === 2)).toBe(true);
    expect(tree.map((root) => root.id)).toContain("usd:asset");
  });

  it("totals in minor units, where adding the decimals would drift", () => {
    const db = freshDb(seedManySatang);
    for (const [leaf, amount] of [["one", 10], ["two", 20], ["three", 30]] as const) {
      ins(db, { debit_account_id: `thb:asset:${leaf}`, credit_account_id: "thb:income:salary", amount });
    }
    expect(find(getBalanceTree(db), "thb:asset")!.rollup).toEqual({ THB: 60 });
  });

  it("re-roots at the accounts a type filter kept", () => {
    const db = freshDb(seedThb);
    const tree = getBalanceTree(db, { type: "expense" });
    expect(tree.map((r) => r.id)).toEqual(["thb:expense"]);
    expect(find(tree, "thb:expense:food")!.children.map((c) => c.id)).toEqual([
      "thb:expense:food:dining",
      "thb:expense:food:groceries",
    ]);
  });
});

describe("adjustAccountBalance", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedBoth); });

  it("balances against the target account's own ledger, and opens no other", () => {
    const res = adjustAccountBalance(db, {
      accountId: "jpy:asset:cash",
      targetAmount: 1500,
      reason: "counted the wallet",
    });
    expect(res.delta).toBe(1500);

    const tx = findTransactionById(db, res.transactionId!)!;
    expect(tx.debit_account_id).toBe("jpy:asset:cash");
    expect(tx.credit_account_id).toBe("jpy:equity:adjustments");
    expect(tx.currency).toBe("JPY");
    // Zero-exponent currency: 1500 yen is 1500 minor units.
    expect(tx.amount).toBe(1500);
    expect(tx.description).toBe("counted the wallet");

    expect(findAccountById(db, "jpy:equity:adjustments")!.name).toBe("Adjustments (JPY)");
    expect(findAccountById(db, "thb:equity:adjustments")).toBeNull();
    expect(getAccountBalances(db).find((b) => b.id === "jpy:asset:cash")!.balance).toBe(1500);
  });

  it("credits a credit-normal account to raise it", () => {
    const res = adjustAccountBalance(db, {
      accountId: "thb:liability:card",
      targetAmount: 500,
      reason: "statement balance",
    });
    expect(res.delta).toBe(500);

    const tx = findTransactionById(db, res.transactionId!)!;
    expect(tx.debit_account_id).toBe("thb:equity:adjustments");
    expect(tx.credit_account_id).toBe("thb:liability:card");
    expect(tx.amount).toBe(50000);
  });

  it("is a no-op when already at target", () => {
    ins(db, { debit_account_id: "thb:asset:cash", credit_account_id: "thb:income:salary", amount: 150000 });
    expect(
      adjustAccountBalance(db, {
        accountId: "thb:asset:cash",
        targetAmount: 1500,
        reason: "already there",
      }),
    ).toEqual({ transactionId: null, delta: 0 });
  });

  it("posts on the given date, and on today when the date is unusable", () => {
    const dated = adjustAccountBalance(db, {
      accountId: "thb:asset:cash",
      targetAmount: 10,
      reason: "x",
      date: "2026-05-01",
    });
    expect(findTransactionById(db, dated.transactionId!)!.date).toBe("2026-05-01");

    const undated = adjustAccountBalance(db, {
      accountId: "thb:asset:cash",
      targetAmount: 20,
      reason: "x",
      date: "yesterday",
    });
    expect(findTransactionById(db, undated.transactionId!)!.date).toBe(todayIso());
  });

  it("throws for an unknown account", () => {
    expect(() =>
      adjustAccountBalance(db, { accountId: "thb:asset:nope", targetAmount: 10, reason: "x" }),
    ).toThrow(/not found/);
  });

  it("refuses to adjust a ledger's own adjustments account", () => {
    // Counterparty of every adjustment on thb:; the balancing transaction
    // would need both legs on one account.
    adjustAccountBalance(db, { accountId: "thb:asset:cash", targetAmount: 100, reason: "seed" });
    expect(() =>
      adjustAccountBalance(db, {
        accountId: "thb:equity:adjustments",
        targetAmount: 10,
        reason: "x",
      }),
    ).toThrow(/balancing side of every adjustment/);
    // The refusal is not a not-found: the CLI maps it to INVALID, not NOT_FOUND.
    expect(() =>
      adjustAccountBalance(db, {
        accountId: "thb:equity:adjustments",
        targetAmount: 10,
        reason: "x",
      }),
    ).not.toThrow(/not found/);
  });
});
