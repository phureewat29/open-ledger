import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { countAccounts, findAccountById, ledgerExists } from "../db/queries/accounts.js";
import { createAccount, mergeAccounts } from "../accounts/accounts.js";
import { getAccountBalances } from "../accounts/balances.js";
import { bulkRecategorize, countTransactions, findTransactionById } from "../db/queries/transactions.js";
import { upsertMerchant } from "../db/queries/merchants.js";
import { deriveTransactionId, deriveGroupId } from "../lib/ids.js";
import { listQuestions, countQuestions, closeQuestion } from "../db/queries/questions.js";
import {
  commitTransaction,
  commitLinkedTransactions,
  type TransactionCommitContext,
  type RawTransactionInput,
} from "./commit.js";
import { failingAccountInsert, freshDb } from "../../fixtures/db.js";

function seedAccountsAndFile(db: Database.Database): void {
  db.prepare(
    `INSERT INTO files (id, path, file_hash, mime, status) VALUES ('sf:1','/f.pdf','hashABC','application/pdf','ingested')`,
  ).run();
  createAccount(db, { id: "thb:asset", name: "Assets (THB)", type: "asset", parent_id: null });
  createAccount(db, { id: "thb:asset:cash", name: "Cash", type: "asset", parent_id: "thb:asset" });
  createAccount(db, { id: "thb:asset:bank", name: "KBank Savings", type: "asset", parent_id: "thb:asset" });
  createAccount(db, { id: "thb:income", name: "Income (THB)", type: "income", parent_id: null });
  createAccount(db, { id: "thb:income:salary", name: "Salary", type: "income", parent_id: "thb:income" });
  createAccount(db, { id: "thb:expense", name: "Expenses (THB)", type: "expense", parent_id: null });
  createAccount(db, { id: "thb:expense:food", name: "Food", type: "expense", parent_id: "thb:expense" });
  createAccount(db, { id: "thb:expense:tax", name: "Tax", type: "expense", parent_id: "thb:expense" });
  createAccount(db, {
    id: "thb:expense:tax:withholding",
    name: "Withholding",
    type: "expense",
    parent_id: "thb:expense:tax",
  });
  createAccount(db, {
    id: "thb:expense:socialsecurity",
    name: "Social Security",
    type: "expense",
    parent_id: "thb:expense",
  });
}

const CTX: TransactionCommitContext = {
  batchId: "ib:1",
  fileId: "sf:1",
  fileHash: "hashABC",
};

function raw(over: Partial<RawTransactionInput> = {}): RawTransactionInput {
  return {
    date: "2026-05-01",
    description: "Coffee",
    debit_account_id: "thb:expense:food",
    credit_account_id: "thb:asset:cash",
    amount: 135.0,
    currency: "THB",
    row_index: 0,
    source_page: 1,
    ...over,
  };
}

describe("commitTransaction", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedAccountsAndFile); });

  it("happy path: converts decimal to minor units, derives id, raises no questions", () => {
    const out = commitTransaction(db, CTX, raw());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.duplicate).toBe(false);
    expect(out.raisedQuestions).toBe(0);
    expect(out.transactionId).toBe(deriveTransactionId("hashABC", 1, 0));

    const row = findTransactionById(db, out.transactionId)!;
    expect(row.amount).toBe(13500); // 135.00 THB -> minor units
    expect(row.debit_account_id).toBe("thb:expense:food");
    expect(countQuestions(db)).toBe(0);

    // Both sides posted where the row asked, and it named no merchant.
    expect(out.sides).toEqual([
      { side: "debit", requested: "thb:expense:food", resolved: "thb:expense:food", how: "exact" },
      { side: "credit", requested: "thb:asset:cash", resolved: "thb:asset:cash", how: "exact" },
    ]);
    expect(out.merchant).toEqual({ how: "none" });
  });

  it("auto-creates a well-formed placeholder silently: no question raised for it", () => {
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "thb:expense:subscriptions:news", row_index: 1 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.raisedQuestions).toBe(0);
    expect(countQuestions(db)).toBe(0);

    const row = findTransactionById(db, out.transactionId)!;
    expect(row.debit_account_id).toBe("thb:expense:subscriptions:news");
    expect(findAccountById(db, "thb:expense:subscriptions:news")).toBeTruthy();
    expect(countTransactions(db)).toBe(1);

    expect(out.sides[0]).toEqual({
      side: "debit",
      requested: "thb:expense:subscriptions:news",
      resolved: "thb:expense:subscriptions:news",
      how: "placeholder_created",
    });
  });

  it("a broken write stops the row: nothing is booked to uncategorized", () => {
    // A broken write must propagate, not be read as an unresolvable id booked to uncategorized.
    const broken = failingAccountInsert(db, "thb:expense:subscriptions");
    expect(() =>
      commitTransaction(
        broken,
        CTX,
        raw({ debit_account_id: "thb:expense:subscriptions:news", row_index: 30 }),
      ),
    ).toThrow(/disk I\/O/);

    expect(countTransactions(db)).toBe(0);
    expect(findAccountById(db, "thb:expense:uncategorized")).toBeNull();
    expect(countQuestions(db)).toBe(0);
  });

  it("raises an uncategorized question when a leaf-only hint falls back to expense:uncategorized", () => {
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "mysterycharge", row_index: 1 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.raisedQuestions).toBe(1);

    const qs = listQuestions(db);
    expect(qs).toHaveLength(1);
    expect(qs[0].transaction_id).toBe(out.transactionId);
    expect(qs[0].kind).toBe("uncategorized");
    const ctx = JSON.parse(qs[0].context_json!);
    expect(ctx.side).toBe("debit");
    expect(ctx.placeholder_id).toBe("thb:expense:uncategorized");
    expect(findTransactionById(db, out.transactionId)!.debit_account_id).toBe("thb:expense:uncategorized");
    expect(countTransactions(db)).toBe(1);

    // The side reports where the money landed, not the hint that failed.
    expect(out.sides).toEqual([
      {
        side: "debit",
        requested: "mysterycharge",
        resolved: "thb:expense:uncategorized",
        how: "uncategorized_fallback",
      },
      { side: "credit", requested: "thb:asset:cash", resolved: "thb:asset:cash", how: "exact" },
    ]);
  });

  it("an unprefixed hint has no currency head, so it falls back into the other side's ledger and raises uncategorized", () => {
    // "expense:food" names no ledger, so the other side (thb:asset:cash) supplies the fallback ledger.
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "expense:food", row_index: 20 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.raisedQuestions).toBe(1);
    expect(findTransactionById(db, out.transactionId)!.debit_account_id).toBe("thb:expense:uncategorized");
    expect(listQuestions(db).find((q) => q.kind === "uncategorized")).toBeTruthy();
  });

  it("refuses a side whose currency head names no existing ledger, and posts nothing", () => {
    // No eur ledger exists; booking into thb would re-label EUR as THB at 1:1, so the row is refused.
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "eur:expense:food", row_index: 21 }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("currency_mismatch");
    expect(out.message).toBe(
      'debit eur:expense:food names ledger "eur", which does not exist here; ' +
        "open it with `oled accounts create`, or fix the currency prefix",
    );
    expect(out.raisedQuestions).toBe(1);
    expect(countTransactions(db)).toBe(0);
    expect(ledgerExists(db, "eur")).toBe(false);
  });

  it("refuses the credit side the same way, leaving the good side's placeholder unbuilt", () => {
    const before = countAccounts(db);
    const out = commitTransaction(
      db,
      CTX,
      raw({
        // Buildable inside thb, but the refusal comes first, so it stays unbuilt.
        debit_account_id: "thb:asset:kbank",
        credit_account_id: "usd:income:salary",
        // The stated currency is discarded either way; the accounts decide.
        currency: "USD",
        row_index: 22,
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("currency_mismatch");
    expect(out.message).toContain('credit usd:income:salary names ledger "usd"');
    expect(countTransactions(db)).toBe(0);
    expect(findAccountById(db, "thb:asset:kbank")).toBeNull();
    expect(countAccounts(db)).toBe(before);
    expect(ledgerExists(db, "usd")).toBe(false);

    const q = listQuestions(db).find((x) => x.kind === "currency_mismatch")!;
    expect(q.transaction_id).toBeNull();
    // The account it names cannot exist, or the ledger would.
    expect(q.account_id).toBeNull();
    expect(q.prompt).toContain(
      "`oled accounts create --id usd:income:salary --name <name> --type income`",
    );
    expect(JSON.parse(q.context_json!)).toMatchObject({
      side: "credit",
      account_id: "usd:income:salary",
      ledger: "usd",
    });
  });

  it("refuses a mistyped currency head too: nothing tells it from a ledger not opened yet", () => {
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "thn:expense:food", row_index: 23 }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain('names ledger "thn"');
    expect(countTransactions(db)).toBe(0);
    expect(ledgerExists(db, "thn")).toBe(false);
  });

  it("the currency head alone is the claim: a malformed tail does not cancel it", () => {
    const out = commitTransaction(db, CTX, raw({ debit_account_id: "usd:food", row_index: 24 }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("currency_mismatch");
    expect(out.message).toContain('names ledger "usd"');
    expect(countTransactions(db)).toBe(0);
    // The id names no creatable account, so the question says fix-the-id, not create.
    const q = listQuestions(db).find((x) => x.kind === "currency_mismatch")!;
    expect(q.prompt).not.toContain("accounts create");
    expect(q.prompt).toContain("fix the id");
  });

  it("an uppercase currency head is still a currency claim", () => {
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "USD:expense:food", row_index: 25 }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("currency_mismatch");
    expect(out.message).toContain('names ledger "usd"');
    expect(countTransactions(db)).toBe(0);
  });

  it("a malformed tail on the OWN ledger's head still falls back, not refuses", () => {
    const out = commitTransaction(db, CTX, raw({ debit_account_id: "thb:food", row_index: 26 }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const committed = findTransactionById(db, out.transactionId)!;
    expect(committed.debit_account_id).toBe("thb:expense:uncategorized");
    expect(out.sides[0]).toMatchObject({ requested: "thb:food", how: "uncategorized_fallback" });
  });

  it("refuses a caller-supplied id outside the tx: namespace", () => {
    // Derived tx: ids make re-ingest idempotent; row_index null means this id is used verbatim.
    const out = commitTransaction(db, CTX, raw({ id: "acct:thb", row_index: null }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("dirty_input");
    expect(out.message).toBe('id must start with "tx:".');
    expect(countTransactions(db)).toBe(0);
  });

  it("refuses a malformed row in the shared wording, not a second copy of it", () => {
    // Shared rules live in validateTransactionFields; this path only adds the
    // decimal amount and tx: namespace.
    const messages = [
      raw({ description: "  ", row_index: 30 }),
      raw({ date: "2026/05/01", row_index: 31 }),
      raw({ credit_account_id: "thb:expense:food", row_index: 32 }),
      raw({ amount: 0, row_index: 33 }),
    ].map((input) => {
      const out = commitTransaction(db, CTX, input);
      return out.ok ? "committed" : out.message;
    });

    expect(messages).toEqual([
      "description must not be empty.",
      "date must be an ISO date (YYYY-MM-DD).",
      "debit and credit accounts must differ.",
      "amount must be a positive number.",
    ]);
    expect(countTransactions(db)).toBe(0);
  });

  it("refuses an amount no currency's minor units could hold, before resolution writes anything", () => {
    // 1e30 satang is past 2^53-1; decided among the pure input rules, before
    // resolution could build a placeholder tree.
    const out = commitTransaction(
      db,
      CTX,
      raw({ amount: 1e30, debit_account_id: "thb:expense:brandnewxyz", row_index: 40 }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("dirty_input");
    expect(out.message).toBe("amount is too large to hold in any currency's minor units.");
    expect(countTransactions(db)).toBe(0);
    expect(findAccountById(db, "thb:expense:brandnewxyz")).toBeNull();
  });

  it("posts to the requested account and raises similar_accounts for the lookalike", () => {
    // Leaf "fod" is one edit from "Food"; reported as a possible duplicate, but
    // the money stays where the input named.
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "thb:expense:fod", row_index: 3 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.raisedQuestions).toBe(1);
    expect(findTransactionById(db, out.transactionId)!.debit_account_id).toBe("thb:expense:fod");

    const qs = listQuestions(db);
    expect(qs).toHaveLength(1);
    expect(qs[0].kind).toBe("similar_accounts");
    // Anchored on the lookalike so the recommended merge cannot cascade it away.
    expect(qs[0].account_id).toBe("thb:expense:food");
    expect(JSON.parse(qs[0].context_json!)).toMatchObject({
      created_id: "thb:expense:fod",
      similar_id: "thb:expense:food",
      side: "debit",
    });

    // similar_to rides along, never the destination; serialized here because
    // callers emit these keys verbatim as NDJSON.
    expect(JSON.stringify(out.sides[0])).toBe(
      '{"side":"debit","requested":"thb:expense:fod","resolved":"thb:expense:fod",' +
        '"how":"similar_account","similar_to":"thb:expense:food"}',
    );
    expect(out.sides[1]).toEqual({
      side: "credit",
      requested: "thb:asset:cash",
      resolved: "thb:asset:cash",
      how: "exact",
    });
  });

  it("the similar_accounts question survives its own remedy and still answers", () => {
    const out = commitTransaction(db, CTX, raw({ debit_account_id: "thb:expense:fod", row_index: 8 }));
    expect(out.ok).toBe(true);

    // Merging the created account into the lookalike must not also kill the
    // question anchored on the survivor.
    mergeAccounts(db, "thb:expense:fod", "thb:expense:food");

    const qs = listQuestions(db);
    expect(qs).toHaveLength(1);
    const closed = closeQuestion(db, qs[0].id, "merged");
    expect(closed?.rule_key).toBe("account-pair:thb:expense:fod|thb:expense:food");
  });

  it("flags a stated currency the accounts overrule, and stays quiet when they agree", () => {
    // Accounts derive THB; the row claims USD; accounts win and the override is reported.
    const overridden = commitTransaction(db, CTX, raw({ currency: "USD", row_index: 10 }));
    expect(overridden.ok).toBe(true);
    if (!overridden.ok) return;
    expect(overridden.currencyOverridden).toBe(true);
    expect(findTransactionById(db, overridden.transactionId)!.currency).toBe("THB");

    const agreeing = commitTransaction(db, CTX, raw({ currency: "THB", row_index: 11 }));
    expect(agreeing.ok).toBe(true);
    if (!agreeing.ok) return;
    expect(agreeing.currencyOverridden).toBe(false);
  });

  it("raises one similar_accounts question per side when both sides have lookalikes", () => {
    // "fod" pairs with Food; "cash 1" pairs with Cash, a sibling, not a lineage relation.
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "thb:expense:fod", credit_account_id: "thb:asset:cash-1", row_index: 9 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.raisedQuestions).toBe(2);

    const row = findTransactionById(db, out.transactionId)!;
    expect(row.debit_account_id).toBe("thb:expense:fod");
    expect(row.credit_account_id).toBe("thb:asset:cash-1");

    const anchors = listQuestions(db).map((q) => q.account_id).sort();
    expect(anchors).toEqual(["thb:asset:cash", "thb:expense:food"]);
  });

  it("drops a cross-currency transaction and raises currency_mismatch (no insert)", () => {
    // A real, pre-existing usd ledger, not just a usd-shaped hint, so both
    // sides name a DIFFERENT EXISTING ledger.
    createAccount(db, { id: "usd:asset", name: "Assets (USD)", type: "asset", parent_id: null });
    createAccount(db, { id: "usd:asset:wallet", name: "USD Wallet", type: "asset", parent_id: "usd:asset" });
    const out = commitTransaction(
      db,
      CTX,
      raw({
        debit_account_id: "usd:asset:wallet",
        credit_account_id: "thb:asset:cash",
        currency: "USD",
        row_index: 5,
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("currency_mismatch");
    expect(countTransactions(db)).toBe(0);

    const cm = listQuestions(db).find((q) => q.kind === "currency_mismatch")!;
    expect(cm).toBeTruthy();
    expect(cm.transaction_id).toBeNull();
  });

  it("is idempotent: a re-commit is a duplicate reporting the row as committed", () => {
    const input = raw({ row_index: 9 });
    const a = commitTransaction(db, CTX, input);
    expect(a.ok && !a.duplicate).toBe(true);

    // thb:expense:food still exists, so re-resolving would wrongly report "exact".
    bulkRecategorize(db, { accountId: "thb:expense:food" }, { accountId: "thb:expense:tax" });

    const b = commitTransaction(db, CTX, input);
    expect(b.ok && b.duplicate).toBe(true);
    if (!b.ok) return;
    expect(b.raisedQuestions).toBe(0);
    expect(b.sides).toEqual([
      {
        side: "debit",
        requested: "thb:expense:food",
        resolved: "thb:expense:tax",
        how: "as_committed",
      },
      {
        side: "credit",
        requested: "thb:asset:cash",
        resolved: "thb:asset:cash",
        how: "as_committed",
      },
    ]);
    expect(b.merchant).toEqual({ how: "none" });
    expect(countTransactions(db)).toBe(1);
  });

  it("reports the merchant a row linked, and asks about one that resolves to nothing", () => {
    const known = upsertMerchant(db, { canonical_name: "Pet Paradise" }, []);

    const linked = commitTransaction(db, CTX, raw({ merchant_id: known.id, row_index: 12 }));
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.merchant).toEqual({ how: "linked", merchant_id: known.id });
    expect(linked.raisedQuestions).toBe(0);

    // The upsert form only earns its id at insert, so the report reads it back.
    const upserted = commitTransaction(
      db,
      CTX,
      raw({ merchant: { canonical_name: "Corner Cafe" }, row_index: 13 }),
    );
    expect(upserted.ok).toBe(true);
    if (!upserted.ok) return;
    expect(upserted.merchant).toEqual({
      how: "linked",
      merchant_id: findTransactionById(db, upserted.transactionId)!.merchant_id,
    });

    const unknown = commitTransaction(db, CTX, raw({ merchant_id: "m:nope", row_index: 14 }));
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    expect(unknown.merchant).toEqual({ how: "unknown" });
    expect(unknown.raisedQuestions).toBe(1);
    expect(findTransactionById(db, unknown.transactionId)!.merchant_id).toBeNull();
  });

  it("no-ops every question raise when batchId is null", () => {
    // With no batchId, raise() no-ops, so the fallback commits without persisting a question.
    const out = commitTransaction(
      db,
      { ...CTX, batchId: null },
      raw({ debit_account_id: "mysterycharge", row_index: 2 }),
    );
    expect(out.ok).toBe(true);
    expect(countQuestions(db, { includeDeferred: true })).toBe(0);
  });

  it("a cross-type lookalike raises nothing: the asset path is created beside the liability card", () => {
    // Existing account whose name shares the "ttb" token with the debit hint below.
    createAccount(db, { id: "thb:liability", name: "Liabilities (THB)", type: "liability", parent_id: null });
    createAccount(db, {
      id: "thb:liability:credit_card",
      name: "Credit Cards",
      type: "liability",
      parent_id: "thb:liability",
    });
    createAccount(db, {
      id: "thb:liability:credit_card:ttb",
      name: "TTB Credit Card",
      type: "liability",
      parent_id: "thb:liability:credit_card",
    });

    const out = commitTransaction(
      db,
      CTX,
      raw({
        debit_account_id: "thb:asset:bank:ttb",
        credit_account_id: "thb:liability:credit_card:ttb",
        row_index: 6,
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const row = findTransactionById(db, out.transactionId)!;
    expect(row.debit_account_id).toBe("thb:asset:bank:ttb");
    expect(row.credit_account_id).toBe("thb:liability:credit_card:ttb");

    // Different type, so not a lookalike; the well-formed asset path is created silently.
    expect(out.raisedQuestions).toBe(0);
    expect(listQuestions(db)).toHaveLength(0);
    expect(findAccountById(db, "thb:asset:bank:ttb")).toBeTruthy();
  });

  it("dirty_input when neither side resolves to any ledger", () => {
    // Neither carries a currency head, so resolution fails outright rather
    // than falling both to uncategorized.
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "bogus", credit_account_id: "alsobogus", row_index: 7 }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("dirty_input");
    expect(countTransactions(db)).toBe(0);
  });
});

describe("commitLinkedTransactions", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedAccountsAndFile); });

  it("commits the salary example atomically with a shared group and gross income", () => {
    const out = commitLinkedTransactions(
      db,
      CTX,
      { date: "2026-05-25", description: "May salary", row_index: 0, source_page: 2 },
      [
        { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 50000 },
        { debit_account_id: "thb:expense:tax:withholding", credit_account_id: "thb:income:salary", amount: 8000 },
        { debit_account_id: "thb:expense:socialsecurity", credit_account_id: "thb:income:salary", amount: 2000 },
      ],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results).toHaveLength(3);
    expect(out.group_id).toBe(deriveGroupId("hashABC", 2, 0));
    expect(out.currencyOverridden).toBe(false);
    expect(out.merchant).toEqual({ how: "none" });
    expect(countTransactions(db)).toBe(3);

    // thb:income:salary is credited by all three legs: 60000 THB gross.
    const salary = getAccountBalances(db).find((b) => b.id === "thb:income:salary")!;
    expect(salary.credits_posted).toBe(6_000_000); // minor units
    expect(salary.balance).toBe(60000); // decimal, credit-normal

    for (const r of out.results) {
      expect(findTransactionById(db, r.id)?.group_id).toBe(out.group_id);
    }
  });

  it("a refused later leg leaves the earlier legs' placeholder trees unbuilt", () => {
    const before = countAccounts(db);
    const out = commitLinkedTransactions(
      db,
      CTX,
      { date: "2026-05-25", description: "Split with a bad leg", row_index: 9, source_page: 2 },
      [
        // Leg 0 would build thb:expense:coffee:beans as a placeholder tree.
        { debit_account_id: "thb:expense:coffee:beans", credit_account_id: "thb:asset:bank", amount: 300 },
        // Leg 1 is refused: no eur ledger exists.
        { debit_account_id: "eur:expense:coffee", credit_account_id: "thb:asset:bank", amount: 100 },
      ],
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("currency_mismatch");
    expect(countTransactions(db)).toBe(0);
    expect(findAccountById(db, "thb:expense:coffee:beans")).toBeNull();
    expect(findAccountById(db, "thb:expense:coffee")).toBeNull();
    expect(countAccounts(db)).toBe(before);
  });

  it("reports a leg whose stated currency its accounts overruled", () => {
    const out = commitLinkedTransactions(
      db,
      CTX,
      { date: "2026-05-25", description: "May salary", row_index: 4, source_page: 2 },
      [
        { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 50000 },
        {
          debit_account_id: "thb:expense:tax",
          credit_account_id: "thb:income:salary",
          amount: 8000,
          currency: "USD",
        },
      ],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.currencyOverridden).toBe(true);
  });

  it("reports the header's merchant once for the whole group", () => {
    const out = commitLinkedTransactions(
      db,
      CTX,
      {
        date: "2026-05-25",
        description: "May salary",
        row_index: 5,
        source_page: 2,
        merchant: { canonical_name: "Employer Co" },
      },
      [
        { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 50000 },
        { debit_account_id: "thb:expense:tax", credit_account_id: "thb:income:salary", amount: 8000 },
      ],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Every leg carries the header's merchant, which is why one report covers the group.
    expect(out.merchant.how).toBe("linked");
    expect(out.results.map((r) => findTransactionById(db, r.id)!.merchant_id)).toEqual([
      out.merchant.merchant_id,
      out.merchant.merchant_id,
    ]);
  });

  it("rolls back all legs when one leg is invalid", () => {
    const out = commitLinkedTransactions(
      db,
      CTX,
      { date: "2026-05-25", description: "bad batch", row_index: 3, source_page: 2 },
      [
        { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 100 },
        { debit_account_id: "thb:asset:bank", credit_account_id: "thb:asset:bank", amount: 50 }, // debit == credit
      ],
    );
    expect(out.ok).toBe(false);
    expect(countTransactions(db)).toBe(0);
  });
});
