import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import {
  getAccountBalances,
  getNetWorth,
  getPeriodTotals,
  getRollupBalance,
} from "../../accounts/balances.js";
import {
  validateTransaction,
  validateTransactionFields,
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
import { freshDb, seedAccount } from "../../../fixtures/db.js";

function seedChartOfAccounts(db: Database.Database): void {
  seedAccount(db, { id: "thb:asset:cash" });
  seedAccount(db, { id: "thb:asset:bank", name: "KBank Savings" });
  seedAccount(db, { id: "thb:expense:food" });
  seedAccount(db, { id: "thb:expense:transport" });
}

function tf(over: Partial<TransactionInput> = {}): TransactionInput {
  return {
    date: "2026-05-01",
    description: "Coffee",
    debit_account_id: "thb:expense:food",
    credit_account_id: "thb:asset:cash",
    amount: 15000,
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

  it("rejects an amount past 2^53-1 here, so the DDL ceiling is never the one to report it", () => {
    // The `amount <= 9007199254740991` CHECK would abort the insert with DDL
    // text; the agent must read the same pinned prose every other refusal uses.
    for (const amount of [Number.MAX_SAFE_INTEGER + 1, 1e32]) {
      expect(validateTransaction(tf({ amount }))).toEqual({
        ok: false,
        reason: "invalid_transaction",
        message: "amount must be a positive integer in minor units.",
      });
    }
    expect(validateTransaction(tf({ amount: Number.MAX_SAFE_INTEGER }))).toEqual({ ok: true });
  });

  it("rejects empty account ids and debit == credit", () => {
    expect(validateTransaction(tf({ debit_account_id: "" }))).toMatchObject({ ok: false });
    expect(validateTransaction(tf({ credit_account_id: "" }))).toMatchObject({ ok: false });
    expect(validateTransaction(tf({ debit_account_id: "thb:asset:cash", credit_account_id: "thb:asset:cash" }))).toMatchObject({
      ok: false,
    });
  });

  it("refuses with a typed reason and the message the caller reports", () => {
    expect(validateTransaction(tf({ amount: 0 }))).toEqual({
      ok: false,
      reason: "invalid_transaction",
      message: "amount must be a positive integer in minor units.",
    });
  });

  it("delegates the form-independent rules, so both amount forms refuse alike", () => {
    // validateRawTransaction (src/ingest/commit.ts) reaches the same five rules
    // with a decimal amount; the wording an agent reads back is this one.
    for (const [over, message] of [
      [{ date: "2026/05/01" }, "date must be an ISO date (YYYY-MM-DD)."],
      [{ description: "  " }, "description must not be empty."],
      [{ debit_account_id: "" }, "debit_account_id must not be empty."],
      [{ credit_account_id: "" }, "credit_account_id must not be empty."],
      [{ credit_account_id: "thb:expense:food" }, "debit and credit accounts must differ."],
    ] as const) {
      expect(validateTransaction(tf(over))).toEqual({
        ok: false,
        reason: "invalid_transaction",
        message,
      });
      expect(validateTransactionFields(tf(over))).toEqual({
        ok: false,
        reason: "invalid_transaction",
        message,
      });
    }
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
    insertTransaction(db, tf({ id: "tx:mc", merchant: { canonical_name: "Starbucks", noise_tokens: [] } }));
    expect(findTransactionById(db, "tx:mc")?.merchant_name).toBe("Starbucks");
  });
});

describe("insertLinkedTransactions", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedChartOfAccounts); });

  it("shares one group id across every leg", () => {
    const res = insertLinkedTransactions(db, [
      tf({ id: "tx:a" }),
      tf({ id: "tx:b", debit_account_id: "thb:expense:transport" }),
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
        tf({ id: "tx:b", debit_account_id: "thb:asset:cash", credit_account_id: "thb:asset:cash" }),
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
      tf({ id: "tx:b", debit_account_id: "thb:expense:transport" }),
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
    insertTransaction(db, tf({ id: "tx:1", description: "Coffee", debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 15000 }));
    insertTransaction(db, tf({ id: "tx:2", description: "Taxi", debit_account_id: "thb:expense:transport", credit_account_id: "thb:asset:bank", amount: 20000 }));
  });

  it("orders by date DESC, id DESC", () => {
    expect(listTransactions(db).map((r) => r.id)).toEqual(["tx:2", "tx:1"]);
  });

  it("matches an account on EITHER side", () => {
    expect(listTransactions(db, { account: "thb:asset:cash" }).map((r) => r.id)).toEqual(["tx:1"]);
    expect(listTransactions(db, { account: "thb:expense:food" }).map((r) => r.id)).toEqual(["tx:1"]);
    expect(listTransactions(db, { account: "thb:asset:bank" }).map((r) => r.id)).toEqual(["tx:2"]);
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
      tf({ id: "tx:g2", debit_account_id: "thb:expense:transport", amount: 5000 }),
    ]);
    const clusters = listTransactions(db, { group: true });
    const grouped = clusters.find((c) => c.group_id === linked.group_id);
    expect(grouped?.transactions.map((t) => t.id).sort()).toEqual(["tx:g1", "tx:g2"]);
    const standalones = clusters.filter((c) => c.group_id === null).flatMap((c) => c.transactions.map((t) => t.id));
    expect(standalones).toContain("tx:1");
    expect(standalones).toContain("tx:2");
  });
});

describe("listTransactions by ledger", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb((seeded) => {
      seedChartOfAccounts(seeded);
      seedAccount(seeded, { id: "jpy:asset:cash" });
      seedAccount(seeded, { id: "jpy:expense:food" });
    });
    // 15.00 THB and 1500 JPY are the same integer at rest: only the ledger the
    // account ids carry tells the two rows apart.
    insertTransaction(db, tf({ id: "tx:thb", amount: 1500 }));
    insertTransaction(
      db,
      tf({
        id: "tx:jpy",
        debit_account_id: "jpy:expense:food",
        credit_account_id: "jpy:asset:cash",
        amount: 1500,
      }),
    );
  });

  it("scopes rows to one ledger, and the count agrees with the listing", () => {
    expect(listTransactions(db, { ledger: "jpy" }).map((r) => r.id)).toEqual(["tx:jpy"]);
    expect(countTransactions(db, { ledger: "jpy" })).toBe(1);
    expect(listTransactions(db, { ledger: "thb" }).map((r) => r.id)).toEqual(["tx:thb"]);
    expect(countTransactions(db, { ledger: "thb" })).toBe(1);
    // The code is compared upper-cased on both sides, as the emitted one is.
    expect(listTransactions(db, { ledger: "JPY" }).map((r) => r.id)).toEqual(["tx:jpy"]);
  });

  it("narrows an amount both ledgers share at rest", () => {
    expect(listTransactions(db, { amount: 1500 }).map((r) => r.id).sort()).toEqual([
      "tx:jpy",
      "tx:thb",
    ]);
    expect(listTransactions(db, { amount: 1500, ledger: "jpy" }).map((r) => r.id)).toEqual([
      "tx:jpy",
    ]);
  });

  it("leaves an account filter alone: the id already names a ledger, and it wins", () => {
    expect(
      listTransactions(db, { account: "thb:expense:food", ledger: "jpy" }).map((r) => r.id),
    ).toEqual(["tx:thb"]);
    expect(countTransactions(db, { account: "thb:expense:food", ledger: "jpy" })).toBe(1);
  });
});

describe("deleteTransaction", () => {
  it("removes a row and reports success", () => {
    const db = freshDb(seedChartOfAccounts);
    insertTransaction(db, tf({ id: "tx:1" }));
    expect(deleteTransaction(db, "tx:1")).toEqual({ deleted: true, unvoided: 0 });
    expect(deleteTransaction(db, "tx:1")).toEqual({ deleted: false, unvoided: 0 });
    expect(countTransactions(db)).toBe(0);
  });

  it("un-voids the mirrors of a deleted survivor and reports how many", () => {
    const db = freshDb(seedChartOfAccounts);
    insertTransaction(db, tf({ id: "tx:orig" }));
    insertTransaction(db, tf({ id: "tx:mirror" }));
    voidTransactionAsMirror(db, "tx:mirror", "tx:orig");

    expect(deleteTransaction(db, "tx:orig")).toEqual({ deleted: true, unvoided: 1 });
    expect(findTransactionById(db, "tx:mirror")?.void_of).toBeNull();
  });

  it("un-voids every mirror of a deleted survivor, and the balance doubles back to reflect both returning live", () => {
    const db = freshDb(seedChartOfAccounts);
    insertTransaction(db, tf({ id: "tx:orig", amount: 15000 }));
    insertTransaction(db, tf({ id: "tx:mirror1", amount: 15000 }));
    insertTransaction(db, tf({ id: "tx:mirror2", amount: 15000 }));
    voidTransactionAsMirror(db, "tx:mirror1", "tx:orig");
    voidTransactionAsMirror(db, "tx:mirror2", "tx:orig");

    const balanceOf = (id: string): number =>
      getAccountBalances(db).find((b) => b.id === id)!.balance;
    expect(balanceOf("thb:asset:cash")).toBe(-150);

    expect(deleteTransaction(db, "tx:orig")).toEqual({ deleted: true, unvoided: 2 });

    expect(findTransactionById(db, "tx:mirror1")?.void_of).toBeNull();
    expect(findTransactionById(db, "tx:mirror2")?.void_of).toBeNull();
    expect(balanceOf("thb:asset:cash")).toBe(-300);
  });
});

describe("bulkRecategorize", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedChartOfAccounts);
    insertTransaction(db, tf({ id: "tx:d", debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash" }));
    insertTransaction(db, tf({ id: "tx:c", debit_account_id: "thb:asset:cash", credit_account_id: "thb:expense:food" }));
    insertTransaction(db, tf({ id: "tx:self", debit_account_id: "thb:expense:food", credit_account_id: "thb:expense:transport" }));
  });

  it("moves both sides and skips would-be self-transactions", () => {
    const res = bulkRecategorize(db, { accountId: "thb:expense:food" }, { accountId: "thb:expense:transport" });
    expect(res.affected).toBe(2);
    expect(res.skipped_self_transaction).toBe(1);
    expect(findTransactionById(db, "tx:d")?.debit_account_id).toBe("thb:expense:transport");
    expect(findTransactionById(db, "tx:c")?.credit_account_id).toBe("thb:expense:transport");
    expect(findTransactionById(db, "tx:self")?.debit_account_id).toBe("thb:expense:food");
    expect(findTransactionById(db, "tx:self")?.credit_account_id).toBe("thb:expense:transport");
  });

  it("throws when the target account does not exist", () => {
    expect(() => bulkRecategorize(db, { accountId: "thb:expense:food" }, { accountId: "thb:expense:nope" })).toThrow(
      /does not exist/,
    );
  });

  it("refuses the no-op where set == filter account", () => {
    expect(() => bulkRecategorize(db, { accountId: "thb:expense:food" }, { accountId: "thb:expense:food" })).toThrow(
      /no-op/,
    );
  });

  it("pre-filters rows whose other side sits on another ledger, before the cross-ledger trigger would abort the statement", () => {
    seedAccount(db, { id: "usd:asset:cash", name: "Cash (USD)" });

    const res = bulkRecategorize(db, { accountId: "thb:expense:food" }, { accountId: "usd:asset:cash" });

    // All three seeded rows touch thb:expense:food on one side; every one of
    // them has a THB account on the other side, so all three are pre-filtered
    // before the cross-ledger trigger would ever see the UPDATE.
    expect(res).toEqual({
      affected: 0,
      skipped_self_transaction: 0,
      skipped_currency_mismatch: 3,
      sample_transaction_ids: [],
    });
    expect(findTransactionById(db, "tx:d")?.debit_account_id).toBe("thb:expense:food");
    expect(findTransactionById(db, "tx:c")?.credit_account_id).toBe("thb:expense:food");
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
    insertTransaction(db, tf({ id: "tx:2", debit_account_id: "thb:expense:transport" }));
    expect(countTransactions(db)).toBe(2);
    expect(countTransactionsBySourceFile(db, "sf:1")).toBe(1);
  });

  it("edits mutable metadata only", () => {
    insertTransaction(db, tf({ id: "tx:m" }));
    expect(updateTransactionMeta(db, "tx:m", { description: "Latte" })).toBe(1);
    const r = findTransactionById(db, "tx:m")!;
    expect(r.description).toBe("Latte");
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

  it("refuses when amount or either account differs", () => {
    insertTransaction(db, tf({ id: "tx:amt", amount: 99999 }));
    expect(() => voidTransactionAsMirror(db, "tx:amt", "tx:a")).toThrow(/mirror/);

    insertTransaction(db, tf({ id: "tx:pair", debit_account_id: "thb:expense:transport", amount: 15000 }));
    expect(() => voidTransactionAsMirror(db, "tx:pair", "tx:a")).toThrow(/mirror/);
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
    expect(balanceOf("thb:asset:cash")).toBe(-300);
    expect(balanceOf("thb:expense:food")).toBe(300);

    voidTransactionAsMirror(db, "tx:mirror", "tx:orig");

    expect(balanceOf("thb:asset:cash")).toBe(-150);
    expect(balanceOf("thb:expense:food")).toBe(150);
  });

  it("also excludes void from net worth, period totals, and rollup", () => {
    voidTransactionAsMirror(db, "tx:mirror", "tx:orig");
    expect(getNetWorth(db).net_worth).toEqual({ THB: -15000 });
    expect(getPeriodTotals(db, "2026-01-01", "2026-12-31").expenses).toEqual({ THB: 15000 });
    expect(getRollupBalance(db, "thb:expense")).toEqual({ THB: 15000 });
  });
});

describe("listTransactions / countTransactions void filtering", () => {
  it("excludes the voided mirror by default, includes it with includeVoid, and counts agree with both", () => {
    const db = freshDb(seedChartOfAccounts);
    insertTransaction(db, tf({ id: "tx:orig", amount: 15000 }));
    insertTransaction(db, tf({ id: "tx:mirror", amount: 15000 }));

    expect(listTransactions(db).map((r) => r.id)).toEqual(
      expect.arrayContaining(["tx:orig", "tx:mirror"]),
    );
    expect(countTransactions(db)).toBe(2);

    voidTransactionAsMirror(db, "tx:mirror", "tx:orig");

    expect(listTransactions(db).map((r) => r.id)).toEqual(["tx:orig"]);
    expect(countTransactions(db)).toBe(1);

    const withVoid = listTransactions(db, { includeVoid: true });
    expect(withVoid.map((r) => r.id).sort()).toEqual(["tx:mirror", "tx:orig"]);
    expect(countTransactions(db, { includeVoid: true })).toBe(2);
    expect(countTransactions(db, { includeVoid: true })).toBe(withVoid.length);
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
    insertTransaction(db, tf({ id: "tx:1", debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 15000 }));
    insertTransaction(db, tf({ id: "tx:2", debit_account_id: "thb:expense:transport", credit_account_id: "thb:asset:bank", amount: 20000 }));
    insertTransaction(db, tf({ id: "tx:3", debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:bank", amount: 15000 }));
  });

  it("counts every row with no filter", () => {
    expect(countTransactions(db)).toBe(3);
  });

  it("matches the row count of the same list filter", () => {
    for (const opts of [
      { account: "thb:expense:food" },
      { amount: 15000 },
      { account: "thb:asset:bank", amount: 20000 },
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
    seedAccount(db, { id: "thb:expense:food:dining" });
  });

  it("moves both columns and deletes would-be self-transactions", () => {
    insertTransaction(db, tf({ id: "tx:1", debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 10000 }));
    insertTransaction(db, tf({ id: "tx:2", debit_account_id: "thb:asset:cash", credit_account_id: "thb:expense:food", amount: 10000 }));
    insertTransaction(db, tf({ id: "tx:self", debit_account_id: "thb:expense:food", credit_account_id: "thb:expense:food:dining", amount: 10000 }));

    const res = repointTransactions(db, "thb:expense:food", "thb:expense:food:dining");
    expect(res.deletedSelfTransactions).toBe(1);
    expect(res.moved).toBe(2);
    expect(findTransactionById(db, "tx:1")?.debit_account_id).toBe("thb:expense:food:dining");
    expect(findTransactionById(db, "tx:2")?.credit_account_id).toBe("thb:expense:food:dining");
    expect(findTransactionById(db, "tx:self")).toBeNull();
  });

  it("refuses re-pointing an account to itself", () => {
    expect(() => repointTransactions(db, "thb:expense:food", "thb:expense:food")).toThrow();
  });
});
