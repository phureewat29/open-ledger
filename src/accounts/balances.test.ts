import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { findAccountById } from "../db/queries/accounts.js";
import { createAccount } from "./accounts.js";
import {
  getAccountBalances,
  getNetWorth,
  getPeriodTotals,
  getRollupBalance,
  adjustAccountBalance,
} from "./balances.js";
import { insertTransaction, type TransactionInput } from "../db/queries/transactions.js";
import { freshDb } from "../../fixtures/db.js";

function seedChartOfAccounts(db: Database.Database): void {
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "asset:bank", name: "KBank Savings", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "income", name: "Income", type: "income", parent_id: null });
  createAccount(db, { id: "income:salary", name: "Salary", type: "income", parent_id: "income" });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "expense:food:dining", name: "Dining", type: "expense", parent_id: "expense:food" });
  createAccount(db, { id: "expense:food:groceries", name: "Groceries", type: "expense", parent_id: "expense:food" });
}

function ins(db: Database.Database, over: Partial<TransactionInput> & Pick<TransactionInput, "debit_account_id" | "credit_account_id" | "amount">) {
  insertTransaction(db, {
    date: "2026-05-01",
    description: "x",
    currency: "THB",
    ...over,
  });
}

describe("getAccountBalances", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedChartOfAccounts); });

  it("derives minor-unit + decimal balances per the normal-balance rule", () => {
    ins(db, { debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 15000 });
    const balances = getAccountBalances(db);

    const food = balances.find((b) => b.id === "expense:food")!;
    expect(food.debits_posted).toBe(15000);
    expect(food.credits_posted).toBe(0);
    expect(food.balance_minor).toBe(15000); // debit-normal
    expect(food.balance).toBe(150);

    const cash = balances.find((b) => b.id === "asset:cash")!;
    expect(cash.balance_minor).toBe(-15000); // asset debit-normal, only credited here
    expect(cash.balance).toBe(-150);
  });

  it("filters by type", () => {
    ins(db, { debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 15000 });
    const expenses = getAccountBalances(db, { type: "expense" });
    expect(expenses.every((b) => b.type === "expense")).toBe(true);
    expect(expenses.some((b) => b.id === "asset:cash")).toBe(false);
  });

  it("filters to self + direct children by idOrParent", () => {
    const rows = getAccountBalances(db, { idOrParent: "expense" });
    expect(rows.map((b) => b.id).sort()).toEqual(["expense", "expense:food"]);
  });
});

describe("getNetWorth", () => {
  it("sums assets minus liabilities", () => {
    const db = freshDb(seedChartOfAccounts);
    ins(db, { debit_account_id: "asset:bank", credit_account_id: "income:salary", amount: 100000 });
    const nw = getNetWorth(db);
    expect(nw.assets).toBe(1000);
    expect(nw.liabilities).toBe(0);
    expect(nw.net_worth).toBe(1000);
  });
});

describe("getPeriodTotals", () => {
  it("computes income (C-D) and expenses (D-C) over the range", () => {
    const db = freshDb(seedChartOfAccounts);
    ins(db, { debit_account_id: "asset:cash", credit_account_id: "income:salary", amount: 100000, date: "2026-05-10" });
    ins(db, { debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 15000, date: "2026-05-11" });
    ins(db, { debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 99900, date: "2026-07-01" });

    const totals = getPeriodTotals(db, "2026-05-01", "2026-05-31");
    expect(totals.income).toBe(1000);
    expect(totals.expenses).toBe(150);
  });
});

describe("getRollupBalance", () => {
  it("sums a subtree (root inclusive)", () => {
    const db = freshDb(seedChartOfAccounts);
    ins(db, { debit_account_id: "expense:food:dining", credit_account_id: "asset:cash", amount: 35000 });
    ins(db, { debit_account_id: "expense:food:groceries", credit_account_id: "asset:cash", amount: 60000 });
    expect(getRollupBalance(db, "expense:food")).toBe(950);
    expect(getRollupBalance(db, "asset:cash")).toBe(-950);
  });
});

describe("adjustAccountBalance", () => {
  it("posts a balancing transaction against equity:adjustments", () => {
    const db = freshDb(seedChartOfAccounts);
    const res = adjustAccountBalance(db, {
      accountId: "asset:cash",
      targetAmount: 1500,
      reason: "set to market value",
    });
    expect(res.delta).toBe(1500);
    expect(res.transactionId).not.toBeNull();
    expect(findAccountById(db, "equity:adjustments")).toBeTruthy();

    const cash = getAccountBalances(db).find((b) => b.id === "asset:cash")!;
    expect(cash.balance).toBe(1500);
  });

  it("is a no-op when already at target", () => {
    const db = freshDb(seedChartOfAccounts);
    ins(db, { debit_account_id: "asset:cash", credit_account_id: "income:salary", amount: 150000 });
    const res = adjustAccountBalance(db, {
      accountId: "asset:cash",
      targetAmount: 1500,
      reason: "already there",
    });
    expect(res).toEqual({ transactionId: null, delta: 0 });
  });

  it("throws for an unknown account", () => {
    const db = freshDb(seedChartOfAccounts);
    expect(() =>
      adjustAccountBalance(db, { accountId: "asset:nope", targetAmount: 10, reason: "x" }),
    ).toThrow(/not found/);
  });
});
