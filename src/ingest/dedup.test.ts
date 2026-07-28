import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { createAccount } from "../accounts/accounts.js";
import { upsertMerchant } from "../db/queries/merchants.js";
import { insertTransaction, countTransactions, type TransactionInput } from "../db/queries/transactions.js";
import { autoMergeStrictDuplicateTransactions } from "./dedup.js";
import { freshDb } from "../../fixtures/db.js";

function seedAccountsAndFile(db: Database.Database): void {
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  db.prepare(
    `INSERT INTO files (id, path, file_hash, mime, status) VALUES ('sf:1','/f.pdf','h1','application/pdf','ingested')`,
  ).run();
}

function tf(over: Partial<TransactionInput>): TransactionInput {
  return {
    date: "2026-05-01",
    description: "Starbucks",
    debit_account_id: "expense:food",
    credit_account_id: "asset:cash",
    amount: 15000,
    currency: "THB",
    source_file_id: "sf:1",
    ...over,
  };
}

describe("autoMergeStrictDuplicateTransactions", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedAccountsAndFile); });

  it("merges exact duplicates sharing merchant/file/date/amount", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" });
    for (let i = 0; i < 3; i++) {
      insertTransaction(db, tf({ merchant_id: merchant.id }));
    }
    expect(countTransactions(db)).toBe(3);
    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 2 });
    expect(countTransactions(db)).toBe(1);
  });

  it("keeps distinct amounts untouched", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" });
    for (const amount of [15000, 17500]) {
      insertTransaction(db, tf({ merchant_id: merchant.id, amount }));
    }
    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 0 });
    expect(countTransactions(db)).toBe(2);
  });

  it("does not merge when the earliest row lacks a merchant or source file", () => {
    for (let i = 0; i < 2; i++) {
      insertTransaction(db, tf({})); // no merchant_id
    }
    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 0 });
    expect(countTransactions(db)).toBe(2);
  });
});
