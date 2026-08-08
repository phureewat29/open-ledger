import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { createAccount } from "../accounts/accounts.js";
import { upsertMerchant } from "../db/queries/merchants.js";
import {
  insertTransaction,
  insertLinkedTransactions,
  countTransactions,
  findTransactionById,
  voidTransactionAsMirror,
  type TransactionInput,
} from "../db/queries/transactions.js";
import { autoMergeStrictDuplicateTransactions, findDuplicateTransactions } from "./dedup.js";
import { freshDb, seedAccount } from "../../fixtures/db.js";

function seedAccountsAndFile(db: Database.Database): void {
  createAccount(db, { id: "thb:expense", name: "Expenses (THB)", type: "expense", parent_id: null });
  createAccount(db, { id: "thb:expense:food", name: "Food", type: "expense", parent_id: "thb:expense" });
  createAccount(db, { id: "thb:asset", name: "Assets (THB)", type: "asset", parent_id: null });
  createAccount(db, { id: "thb:asset:cash", name: "Cash", type: "asset", parent_id: "thb:asset" });
  createAccount(db, { id: "thb:equity", name: "Equity (THB)", type: "equity", parent_id: null });
  createAccount(db, {
    id: "thb:equity:adjustments",
    name: "Adjustments (THB)",
    type: "equity",
    parent_id: "thb:equity",
  });
  db.prepare(
    `INSERT INTO files (id, path, file_hash, mime, status) VALUES ('sf-1','/f.pdf','h1','application/pdf','ingested')`,
  ).run();
}

function tf(over: Partial<TransactionInput>): TransactionInput {
  return {
    date: "2026-05-01",
    description: "Starbucks",
    debit_account_id: "thb:expense:food",
    credit_account_id: "thb:asset:cash",
    amount: 15000,
    source_file_id: "sf-1",
    ...over,
  };
}

describe("autoMergeStrictDuplicateTransactions", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedAccountsAndFile); });

  it("merges exact duplicates sharing merchant/file/date/amount", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" }, []);
    for (let i = 0; i < 3; i++) {
      insertTransaction(db, tf({ merchant_id: merchant.id }));
    }
    expect(countTransactions(db)).toBe(3);
    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 2 });
    expect(countTransactions(db)).toBe(1);
  });

  it("keeps distinct amounts untouched", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" }, []);
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

  it("voids duplicates into the head instead of deleting them, so an existing void on a candidate survives", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" }, []);
    // A, B, C: three live identical rows; B already has a mirror M voided into it.
    const [a, b, c] = ["a", "b", "c"].map(
      () => insertTransaction(db, tf({ merchant_id: merchant.id })).id,
    );
    const m = insertTransaction(db, tf({ merchant_id: merchant.id })).id;
    voidTransactionAsMirror(db, m, b);

    expect(countTransactions(db)).toBe(3); // a, b, c live; m already void
    expect(countTransactions(db, { includeVoid: true })).toBe(4);

    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 2 });

    // Only the earliest (by date/id sort) row is still live.
    expect(countTransactions(db)).toBe(1);
    expect(countTransactions(db, { includeVoid: true })).toBe(4); // nothing deleted

    // Nothing got un-voided: m still points at b; none of a/b/c came back to void_of === null.
    const head = [a, b, c].find((id) => findTransactionById(db, id)?.void_of === null)!;
    expect(head).toBeDefined();
    expect(findTransactionById(db, m)?.void_of).toBe(b);
    for (const id of [a, b, c]) {
      if (id === head) continue;
      expect(findTransactionById(db, id)?.void_of).toBe(head);
    }

    // Re-running finds nothing left to merge: the live set is down to one row.
    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 0 });
  });

  it("never merges repeat postings on an equity:adjustments account: those are corrections, not duplicated statement rows", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Balance correction" }, []);
    for (let i = 0; i < 2; i++) {
      insertTransaction(
        db,
        tf({
          merchant_id: merchant.id,
          debit_account_id: "thb:equity:adjustments",
          credit_account_id: "thb:asset:cash",
        }),
      );
    }
    expect(countTransactions(db)).toBe(2);
    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 0 });
    expect(countTransactions(db)).toBe(2);
  });
});

function seedDedupAccounts(db: Database.Database): void {
  seedAccount(db, { id: "thb:asset:cash" });
  seedAccount(db, { id: "thb:asset:bank", name: "KBank Savings" });
  seedAccount(db, { id: "thb:expense:food" });
  seedAccount(db, { id: "thb:expense:transport" });
}

function dupTf(over: Partial<TransactionInput> = {}): TransactionInput {
  return {
    date: "2026-05-01",
    description: "Coffee",
    debit_account_id: "thb:expense:food",
    credit_account_id: "thb:asset:cash",
    amount: 15000,
    ...over,
  };
}

describe("findDuplicateTransactions", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedDedupAccounts); });

  it("detects cross-group duplicates but excludes intra-group members", () => {
    insertLinkedTransactions(db, [
      dupTf({ id: "tx:same1", debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 5000 }),
      dupTf({ id: "tx:same2", debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 5000 }),
    ]);
    insertTransaction(db, dupTf({ id: "tx:dup1", debit_account_id: "thb:expense:transport", credit_account_id: "thb:asset:bank", amount: 7000 }));
    insertTransaction(db, dupTf({ id: "tx:dup2", debit_account_id: "thb:expense:transport", credit_account_id: "thb:asset:bank", amount: 7000 }));

    const groups = findDuplicateTransactions(db);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id).sort()).toEqual(["tx:dup1", "tx:dup2"]);
  });

  it("excludes voided rows from candidates", () => {
    insertTransaction(db, dupTf({ id: "tx:dupA", debit_account_id: "thb:expense:transport", credit_account_id: "thb:asset:bank", amount: 7000 }));
    insertTransaction(db, dupTf({ id: "tx:dupB", debit_account_id: "thb:expense:transport", credit_account_id: "thb:asset:bank", amount: 7000 }));
    expect(findDuplicateTransactions(db)).toHaveLength(1);

    voidTransactionAsMirror(db, "tx:dupB", "tx:dupA");
    expect(findDuplicateTransactions(db)).toHaveLength(0);
  });
});
