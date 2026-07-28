import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { createAccount } from "../../accounts/accounts.js";
import {
  getAccountBalances,
  getNetWorth,
  getPeriodTotals,
  getRollupBalance,
} from "../../accounts/balances.js";
import {
  validateTransaction,
  insertTransaction,
  insertLinkedTransactions,
  findTransactionById,
  listTransactions,
  deleteTransaction,
  bulkRecategorize,
  repointTransactions,
  voidTransactionAsMirror,
  countTransactions,
  countTransactionsBySourceFile,
  updateTransactionMeta,
  type TransactionInput,
} from "./transactions.js";
import { findDuplicateTransactions } from "./transactions-dedup.js";
import { freshDb } from "../../../fixtures/db.js";

function seedChartOfAccounts(db: Database.Database): void {
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "asset:bank", name: "KBank Savings", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "expense:transport", name: "Transport", type: "expense", parent_id: "expense" });
}

function tf(over: Partial<TransactionInput> = {}): TransactionInput {
  return {
    date: "2026-05-01",
    description: "Coffee",
    debit_account_id: "expense:food",
    credit_account_id: "asset:cash",
    amount: 15000,
    currency: "THB",
    ...over,
  };
}

describe("validateTransaction", () => {
  it("accepts a well-formed transaction", () => {
    expect(validateTransaction(tf())).toEqual({ ok: true });
  });

  it("rejects a non-ISO date", () => {
    expect(validateTransaction(tf({ date: "2026/05/01" }))).toMatchObject({ ok: false });
    expect(validateTransaction(tf({ date: "" }))).toMatchObject({ ok: false });
  });

  it("rejects an empty description", () => {
    expect(validateTransaction(tf({ description: "  " }))).toMatchObject({ ok: false });
  });

  it("rejects a non-integer or non-positive amount", () => {
    expect(validateTransaction(tf({ amount: 1.5 }))).toMatchObject({ ok: false });
    expect(validateTransaction(tf({ amount: 0 }))).toMatchObject({ ok: false });
    expect(validateTransaction(tf({ amount: -100 }))).toMatchObject({ ok: false });
  });

  it("rejects empty account ids and debit == credit", () => {
    expect(validateTransaction(tf({ debit_account_id: "" }))).toMatchObject({ ok: false });
    expect(validateTransaction(tf({ credit_account_id: "" }))).toMatchObject({ ok: false });
    expect(validateTransaction(tf({ debit_account_id: "asset:cash", credit_account_id: "asset:cash" }))).toMatchObject({
      ok: false,
    });
  });
});

describe("insertTransaction", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedChartOfAccounts); });

  it("inserts once and reports duplicate on the same id", () => {
    expect(insertTransaction(db, tf({ id: "tx:fixed" }))).toEqual({ id: "tx:fixed", duplicate: false });
    expect(insertTransaction(db, tf({ id: "tx:fixed" }))).toEqual({ id: "tx:fixed", duplicate: true });
    expect(countTransactions(db)).toBe(1);
  });

  it("throws on invalid input", () => {
    expect(() => insertTransaction(db, tf({ amount: 0 }))).toThrow();
  });

  it("upserts a merchant when supplied", () => {
    insertTransaction(db, tf({ id: "tx:mc", merchant: { canonical_name: "Starbucks" } }));
    expect(findTransactionById(db, "tx:mc")?.merchant_name).toBe("Starbucks");
  });
});

describe("insertLinkedTransactions", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedChartOfAccounts); });

  it("shares one group id across every leg", () => {
    const res = insertLinkedTransactions(db, [
      tf({ id: "tx:a" }),
      tf({ id: "tx:b", debit_account_id: "expense:transport" }),
    ]);
    expect(res.results.map((r) => r.id)).toEqual(["tx:a", "tx:b"]);
    expect(res.group_id.startsWith("tg:")).toBe(true);
    expect(findTransactionById(db, "tx:a")?.group_id).toBe(res.group_id);
    expect(findTransactionById(db, "tx:b")?.group_id).toBe(res.group_id);
  });

  it("rolls back every leg when one leg is invalid", () => {
    expect(() =>
      insertLinkedTransactions(db, [
        tf({ id: "tx:a" }),
        tf({ id: "tx:b", debit_account_id: "asset:cash", credit_account_id: "asset:cash" }),
      ]),
    ).toThrow();
    expect(countTransactions(db)).toBe(0);
  });
});

describe("findTransactionById", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedChartOfAccounts); });

  it("returns null for a missing id", () => {
    expect(findTransactionById(db, "tx:nope")).toBeNull();
  });

  it("joins account + merchant names and carries the full group", () => {
    const res = insertLinkedTransactions(db, [
      tf({ id: "tx:a" }),
      tf({ id: "tx:b", debit_account_id: "expense:transport" }),
    ]);
    const detail = findTransactionById(db, "tx:a")!;
    expect(detail.debit_account_name).toBe("Food");
    expect(detail.credit_account_name).toBe("Cash");
    expect(detail.group_id).toBe(res.group_id);
    expect(detail.group?.map((g) => g.id).sort()).toEqual(["tx:a", "tx:b"]);
  });
});

describe("listTransactions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedChartOfAccounts);
    insertTransaction(db, tf({ id: "tx:1", description: "Coffee", debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 15000 }));
    insertTransaction(db, tf({ id: "tx:2", description: "Taxi", debit_account_id: "expense:transport", credit_account_id: "asset:bank", amount: 20000 }));
  });

  it("orders by date DESC, id DESC", () => {
    expect(listTransactions(db).map((r) => r.id)).toEqual(["tx:2", "tx:1"]);
  });

  it("matches an account on EITHER side", () => {
    expect(listTransactions(db, { account: "asset:cash" }).map((r) => r.id)).toEqual(["tx:1"]);
    expect(listTransactions(db, { account: "expense:food" }).map((r) => r.id)).toEqual(["tx:1"]);
    expect(listTransactions(db, { account: "asset:bank" }).map((r) => r.id)).toEqual(["tx:2"]);
  });

  it("queries over description and either account name", () => {
    expect(listTransactions(db, { query: "Taxi" }).map((r) => r.id)).toEqual(["tx:2"]);
    expect(listTransactions(db, { query: "Cash" }).map((r) => r.id)).toEqual(["tx:1"]);
    expect(listTransactions(db, { query: "KBank" }).map((r) => r.id)).toEqual(["tx:2"]);
  });

  it("filters by exact amount (minor units)", () => {
    expect(listTransactions(db, { amount: 15000 }).map((r) => r.id)).toEqual(["tx:1"]);
    expect(listTransactions(db, { amount: 20000 }).map((r) => r.id)).toEqual(["tx:2"]);
    expect(listTransactions(db, { amount: 999 })).toHaveLength(0);
  });

  it("clusters by group when requested (nulls standalone)", () => {
    const linked = insertLinkedTransactions(db, [
      tf({ id: "tx:g1", amount: 5000 }),
      tf({ id: "tx:g2", debit_account_id: "expense:transport", amount: 5000 }),
    ]);
    const clusters = listTransactions(db, { group: true });
    const grouped = clusters.find((c) => c.group_id === linked.group_id);
    expect(grouped?.transactions.map((t) => t.id).sort()).toEqual(["tx:g1", "tx:g2"]);
    const standalones = clusters.filter((c) => c.group_id === null).flatMap((c) => c.transactions.map((t) => t.id));
    expect(standalones).toContain("tx:1");
    expect(standalones).toContain("tx:2");
  });
});

describe("deleteTransaction", () => {
  it("removes a row and reports success", () => {
    const db = freshDb(seedChartOfAccounts);
    insertTransaction(db, tf({ id: "tx:1" }));
    expect(deleteTransaction(db, "tx:1")).toBe(true);
    expect(deleteTransaction(db, "tx:1")).toBe(false);
    expect(countTransactions(db)).toBe(0);
  });
});

describe("bulkRecategorize", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedChartOfAccounts);
    insertTransaction(db, tf({ id: "tx:d", debit_account_id: "expense:food", credit_account_id: "asset:cash" }));
    insertTransaction(db, tf({ id: "tx:c", debit_account_id: "asset:cash", credit_account_id: "expense:food" }));
    insertTransaction(db, tf({ id: "tx:self", debit_account_id: "expense:food", credit_account_id: "expense:transport" }));
  });

  it("moves both sides and skips would-be self-transactions", () => {
    const res = bulkRecategorize(db, { accountId: "expense:food" }, { accountId: "expense:transport" });
    expect(res.affected).toBe(2);
    expect(res.skipped_self_transaction).toBe(1);
    expect(findTransactionById(db, "tx:d")?.debit_account_id).toBe("expense:transport");
    expect(findTransactionById(db, "tx:c")?.credit_account_id).toBe("expense:transport");
    expect(findTransactionById(db, "tx:self")?.debit_account_id).toBe("expense:food");
    expect(findTransactionById(db, "tx:self")?.credit_account_id).toBe("expense:transport");
  });

  it("throws when the target account does not exist", () => {
    expect(() => bulkRecategorize(db, { accountId: "expense:food" }, { accountId: "expense:nope" })).toThrow(
      /does not exist/,
    );
  });

  it("refuses the no-op where set == filter account", () => {
    expect(() => bulkRecategorize(db, { accountId: "expense:food" }, { accountId: "expense:food" })).toThrow(
      /no-op/,
    );
  });
});

describe("findDuplicateTransactions", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedChartOfAccounts); });

  it("detects cross-group duplicates but excludes intra-group members", () => {
    insertLinkedTransactions(db, [
      tf({ id: "tx:same1", debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 5000 }),
      tf({ id: "tx:same2", debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 5000 }),
    ]);
    insertTransaction(db, tf({ id: "tx:dup1", debit_account_id: "expense:transport", credit_account_id: "asset:bank", amount: 7000 }));
    insertTransaction(db, tf({ id: "tx:dup2", debit_account_id: "expense:transport", credit_account_id: "asset:bank", amount: 7000 }));

    const groups = findDuplicateTransactions(db);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id).sort()).toEqual(["tx:dup1", "tx:dup2"]);
  });

  it("excludes voided rows from candidates", () => {
    insertTransaction(db, tf({ id: "tx:dupA", debit_account_id: "expense:transport", credit_account_id: "asset:bank", amount: 7000 }));
    insertTransaction(db, tf({ id: "tx:dupB", debit_account_id: "expense:transport", credit_account_id: "asset:bank", amount: 7000 }));
    expect(findDuplicateTransactions(db)).toHaveLength(1);

    voidTransactionAsMirror(db, "tx:dupB", "tx:dupA");
    expect(findDuplicateTransactions(db)).toHaveLength(0);
  });
});

describe("counts + updateTransactionMeta", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedChartOfAccounts);
    db.prepare(
      `INSERT INTO files (id, path, file_hash, mime, status) VALUES ('sf:1','/f.pdf','h1','application/pdf','ingested')`,
    ).run();
  });

  it("counts total and by source file", () => {
    insertTransaction(db, tf({ id: "tx:1", source_file_id: "sf:1" }));
    insertTransaction(db, tf({ id: "tx:2", debit_account_id: "expense:transport" }));
    expect(countTransactions(db)).toBe(2);
    expect(countTransactionsBySourceFile(db, "sf:1")).toBe(1);
  });

  it("edits mutable metadata only", () => {
    insertTransaction(db, tf({ id: "tx:m" }));
    expect(updateTransactionMeta(db, "tx:m", { description: "Latte", source_page: 3 })).toBe(1);
    const r = findTransactionById(db, "tx:m")!;
    expect(r.description).toBe("Latte");
    expect(r.source_page).toBe(3);
    expect(updateTransactionMeta(db, "tx:m", {})).toBe(0);
  });
});

describe("voidTransactionAsMirror", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedChartOfAccounts);
    insertTransaction(db, tf({ id: "tx:a", amount: 15000 }));
    insertTransaction(db, tf({ id: "tx:b", amount: 15000 }));
  });

  it("voids from into to and records the surviving twin", () => {
    expect(voidTransactionAsMirror(db, "tx:b", "tx:a")).toEqual({ alreadyVoid: false });
    const row = findTransactionById(db, "tx:b")!;
    expect(row.void_of).toBe("tx:a");
  });

  it("is an idempotent no-op when from is already void", () => {
    voidTransactionAsMirror(db, "tx:b", "tx:a");
    expect(voidTransactionAsMirror(db, "tx:b", "tx:a")).toEqual({ alreadyVoid: true });
  });

  it("refuses a self-merge", () => {
    expect(() => voidTransactionAsMirror(db, "tx:a", "tx:a")).toThrow(/itself/);
  });

  it("throws not found for a missing row (either side)", () => {
    expect(() => voidTransactionAsMirror(db, "tx:missing", "tx:a")).toThrow(/not found/);
    expect(() => voidTransactionAsMirror(db, "tx:a", "tx:missing")).toThrow(/not found/);
  });

  it("refuses when amount, currency, or accounts differ", () => {
    insertTransaction(db, tf({ id: "tx:amt", amount: 99999 }));
    expect(() => voidTransactionAsMirror(db, "tx:amt", "tx:a")).toThrow(/mirror/);

    insertTransaction(db, tf({ id: "tx:pair", debit_account_id: "expense:transport", amount: 15000 }));
    expect(() => voidTransactionAsMirror(db, "tx:pair", "tx:a")).toThrow(/mirror/);

    insertTransaction(db, tf({ id: "tx:ccy", amount: 15000, currency: "USD" }));
    expect(() => voidTransactionAsMirror(db, "tx:ccy", "tx:a")).toThrow(/mirror/);
  });

  it("refuses merging into a voided row", () => {
    voidTransactionAsMirror(db, "tx:b", "tx:a");
    insertTransaction(db, tf({ id: "tx:c", amount: 15000 }));
    expect(() => voidTransactionAsMirror(db, "tx:c", "tx:b")).toThrow(/voided/);
  });
});

describe("void excludes rows from balance derivation", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedChartOfAccounts);
    insertTransaction(db, tf({ id: "tx:orig", amount: 15000 }));
    insertTransaction(db, tf({ id: "tx:mirror", amount: 15000 }));
  });

  const balanceOf = (id: string): number =>
    getAccountBalances(db).find((b) => b.id === id)!.balance;

  it("double-counts before void, counts once after", () => {
    expect(balanceOf("asset:cash")).toBe(-300);
    expect(balanceOf("expense:food")).toBe(300);

    voidTransactionAsMirror(db, "tx:mirror", "tx:orig");

    expect(balanceOf("asset:cash")).toBe(-150);
    expect(balanceOf("expense:food")).toBe(150);
  });

  it("also excludes void from net worth, period totals, and rollup", () => {
    voidTransactionAsMirror(db, "tx:mirror", "tx:orig");
    expect(getNetWorth(db).net_worth).toBe(-150);
    expect(getPeriodTotals(db, "2026-01-01", "2026-12-31").expenses).toBe(150);
    expect(getRollupBalance(db, "expense")).toBe(150);
  });
});

describe("void survives re-insert (ON CONFLICT)", () => {
  it("keeps void_of when the deterministic id is re-inserted", () => {
    const db = freshDb(seedChartOfAccounts);
    insertTransaction(db, tf({ id: "tx:orig", amount: 15000 }));
    insertTransaction(db, tf({ id: "tx:dup", amount: 15000 }));
    voidTransactionAsMirror(db, "tx:dup", "tx:orig");

    const res = insertTransaction(db, tf({ id: "tx:dup", amount: 15000 }));
    expect(res.duplicate).toBe(true);
    const row = findTransactionById(db, "tx:dup")!;
    expect(row.void_of).toBe("tx:orig");
  });
});

describe("countTransactions with filters", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedChartOfAccounts);
    insertTransaction(db, tf({ id: "tx:1", debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 15000 }));
    insertTransaction(db, tf({ id: "tx:2", debit_account_id: "expense:transport", credit_account_id: "asset:bank", amount: 20000 }));
    insertTransaction(db, tf({ id: "tx:3", debit_account_id: "expense:food", credit_account_id: "asset:bank", amount: 15000 }));
  });

  it("counts every row with no filter", () => {
    expect(countTransactions(db)).toBe(3);
  });

  it("matches the row count of the same list filter", () => {
    for (const opts of [
      { account: "expense:food" },
      { amount: 15000 },
      { account: "asset:bank", amount: 20000 },
      { query: "KBank" },
    ]) {
      expect(countTransactions(db, opts)).toBe(listTransactions(db, opts).length);
    }
  });
});

describe("repointTransactions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedChartOfAccounts);
    createAccount(db, { id: "expense:food:dining", name: "Dining", type: "expense", parent_id: "expense:food" });
  });

  it("moves both columns and deletes would-be self-transactions", () => {
    insertTransaction(db, tf({ id: "tx:1", debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 10000 }));
    insertTransaction(db, tf({ id: "tx:2", debit_account_id: "asset:cash", credit_account_id: "expense:food", amount: 10000 }));
    insertTransaction(db, tf({ id: "tx:self", debit_account_id: "expense:food", credit_account_id: "expense:food:dining", amount: 10000 }));

    const res = repointTransactions(db, "expense:food", "expense:food:dining");
    expect(res.deletedSelfTransactions).toBe(1);
    expect(res.moved).toBe(2);
    expect(findTransactionById(db, "tx:1")?.debit_account_id).toBe("expense:food:dining");
    expect(findTransactionById(db, "tx:2")?.credit_account_id).toBe("expense:food:dining");
    expect(findTransactionById(db, "tx:self")).toBeNull();
  });

  it("refuses re-pointing an account to itself", () => {
    expect(() => repointTransactions(db, "expense:food", "expense:food")).toThrow();
  });
});
