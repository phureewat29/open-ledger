import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import {
  ACCOUNT_TYPES,
  countAccounts,
  findAccountById,
  listLedgerCurrencies,
  type AccountType,
} from "../db/queries/accounts.js";
import { findMerchantById, upsertMerchant } from "../db/queries/merchants.js";
import { insertTransaction } from "../db/queries/transactions.js";
import {
  createAccount,
  deleteAccount,
  ensureLedgerRoot,
  ensureStructuralAccount,
  isLedgerRootId,
  mergeAccounts,
  structuralAccountId,
  validateAccountId,
  STRUCTURAL_ACCOUNTS,
  type AccountRefusal,
  type AccountResult,
  type StructuralKind,
} from "./accounts.js";
import { freshDb, seedAccount } from "../../fixtures/db.js";

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Narrows a refusal for assertion, and fails loudly on an unexpected success. */
function refused(result: AccountResult): AccountRefusal {
  if (result.ok) throw new Error("expected a refusal, got { ok: true }");
  return result;
}

const STRUCTURAL_KINDS = Object.keys(STRUCTURAL_ACCOUNTS) as StructuralKind[];

/** Pinned here rather than imported: the test is what fixes these names. */
const THB_ROOT_NAMES: Record<AccountType, string> = {
  asset: "Assets (THB)",
  liability: "Liabilities (THB)",
  income: "Income (THB)",
  expense: "Expenses (THB)",
  equity: "Equity (THB)",
};

describe("createAccount id grammar", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("inserts a ledger type root with parent_id=null", () => {
    createAccount(db, { id: "thb:asset", name: "Assets (THB)", type: "asset", parent_id: null });
    const row = findAccountById(db, "thb:asset")!;
    expect(row.parent_id).toBeNull();
    expect(row.created_at).toMatch(ISO_TIMESTAMP_RE);
  });

  it("refuses an id with no lowercase currency head", () => {
    for (const id of ["asset:cash", "THB:asset:cash", "th:asset:cash"]) {
      const refusal = refused(
        createAccount(db, { id, name: "Cash", type: "asset", parent_id: "thb:asset" }),
      );
      expect(refusal.reason).toBe("invalid_hierarchy");
      expect(refusal.message).toMatch(/must be lowercase <currency>:<type>/);
    }
    expect(countAccounts(db)).toBe(0);
  });

  it("refuses a null parent for anything but a ledger type root", () => {
    const refusal = refused(
      createAccount(db, { id: "thb:asset:orphan", name: "Orphan", type: "asset", parent_id: null }),
    );
    expect(refusal.reason).toBe("invalid_hierarchy");
    expect(refusal.message).toMatch(/only a ledger's type root/);
  });

  it("refuses a type that contradicts the id's second segment, as a clean refusal", () => {
    const refusal = refused(
      createAccount(db, { id: "thb:asset:x", name: "X", type: "expense", parent_id: "thb:expense" }),
    );
    expect(refusal.reason).toBe("invalid_hierarchy");
    expect(refusal.message).toMatch(
      /must carry its type in the second segment: expected "thb:expense"/,
    );
    // Not the DDL's CHECK text: the refusal happens before the INSERT is attempted.
    expect(refusal.message).not.toMatch(/CHECK constraint/);
    expect(findAccountById(db, "thb:asset:x")).toBeNull();
  });

  it("refuses the same contradiction at rest, so no other writer can smuggle it in", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO accounts (id, name, type, parent_id)
         VALUES ('thb:expense:weird', 'Weird', 'asset', 'thb:expense')`,
      ).run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("refuses a parent in another ledger: a child extends its parent's id, prefix included", () => {
    seedAccount(db, { id: "thb:asset" });
    const refusal = refused(
      createAccount(db, { id: "usd:asset:kbank", name: "KBank", type: "asset", parent_id: "thb:asset" }),
    );
    expect(refusal.reason).toBe("invalid_hierarchy");
    expect(refusal.message).toMatch(/must start with parent id "thb:asset:"/);
  });

  it("rejects parent/type mismatch", () => {
    seedAccount(db, { id: "thb:expense" });
    const refusal = refused(
      createAccount(db, { id: "thb:asset:misc", name: "Misc", type: "asset", parent_id: "thb:expense" }),
    );
    expect(refusal.reason).toBe("invalid_hierarchy");
    expect(refusal.message).toMatch(/does not match parent/);
  });

  it("auto-creates the ledger type root, but no deeper ancestor", () => {
    seedAccount(db, { id: "thb:expense:food" });
    const root = findAccountById(db, "thb:expense")!;
    expect(root.name).toBe("Expenses (THB)");
    expect(root.parent_id).toBeNull();

    // Only reason not the caller's fault: CLI exits NOT_FOUND(5) here, INVALID(6) for the rest.
    const refusal = refused(
      createAccount(db, {
        id: "thb:expense:food:nuts",
        name: "Nuts",
        type: "expense",
        parent_id: "thb:expense:snacks",
      }),
    );
    expect(refusal.reason).toBe("parent_not_found");
    expect(refusal.message).toMatch(/does not exist/);
  });

  it("refuses a duplicate id with account_exists", () => {
    seedAccount(db, { id: "thb:asset:dup", name: "First" });
    const refusal = refused(
      createAccount(db, { id: "thb:asset:dup", name: "Second", type: "asset", parent_id: "thb:asset" }),
    );
    // resolve.ts's ancestor walk keys off this reason to swallow a lost race.
    expect(refusal.reason).toBe("account_exists");
    expect(refusal.message).toMatch(/already exists/);
    expect(findAccountById(db, "thb:asset:dup")!.name).toBe("First");
  });

  it("normalizes the at-rest form: uppercase bank, check-digit-trimmed mask, JSON metadata", () => {
    createAccount(db, {
      id: "thb:asset:scbsavings7652",
      name: "SCB Savings ••7652",
      type: "asset",
      parent_id: "thb:asset",
      bank_name: "scb",
      account_number_masked: "••7652-0",
      metadata: { points_program: "Forever" },
    });
    const row = findAccountById(db, "thb:asset:scbsavings7652")!;
    expect(row.bank_name).toBe("SCB");
    expect(row.account_number_masked).toBe("••7652");
    expect(JSON.parse(row.metadata_json!)).toEqual({ points_program: "Forever" });
  });

  it("derives currency from the id prefix; nothing carries a currency of its own", () => {
    createAccount(db, { id: "thb:asset:cash", name: "Cash", type: "asset", parent_id: "thb:asset" });
    createAccount(db, { id: "usd:asset:cash", name: "Dollar Cash", type: "asset", parent_id: "usd:asset" });

    expect(findAccountById(db, "thb:asset:cash")!.currency).toBe("THB");
    expect(findAccountById(db, "usd:asset:cash")!.currency).toBe("USD");
    expect(listLedgerCurrencies(db)).toEqual(["thb", "usd"]);
  });
});

describe("validateAccountId", () => {
  it("passes an id whose second segment is the declared type", () => {
    expect(validateAccountId("thb:expense:food", "expense")).toEqual({ ok: true });
    expect(validateAccountId("thb:asset", "asset")).toEqual({ ok: true });
  });

  it("refuses a head that is not three lowercase letters", () => {
    for (const id of ["th:asset:x", "THB:asset:x", "asset:x"]) {
      const refusal = refused(validateAccountId(id, "asset"));
      expect(refusal.reason).toBe("invalid_hierarchy");
      expect(refusal.message).toMatch(/must be lowercase <currency>:<type>/);
    }
  });

  it("refuses a type the id contradicts, naming the id that type would need", () => {
    // Callable with no database on purpose: must refuse before `accounts create` opens the ledger.
    expect(refused(validateAccountId("eur:asset:x", "expense")).message).toMatch(
      /must carry its type in the second segment: expected "eur:expense"/,
    );
  });
});

describe("a ledger id refuses a currency that is not a 3-letter code", () => {
  it("throws its own error before writing, rather than letting the DDL's CHECK abort", () => {
    const db = freshDb();
    expect(() => structuralAccountId("us", "uncategorized")).toThrow(/must be a 3-letter code/);
    expect(() => ensureLedgerRoot(db, "us", "asset")).toThrow(/must be a 3-letter code/);
    expect(() => ensureStructuralAccount(db, "us", "uncategorized")).toThrow(
      /must be a 3-letter code/,
    );
    expect(countAccounts(db)).toBe(0);
  });
});

describe("ensureLedgerRoot", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("idempotently creates every type root of a ledger, named for its currency", () => {
    for (const type of ACCOUNT_TYPES) {
      ensureLedgerRoot(db, "thb", type);
      ensureLedgerRoot(db, "thb", type);
      const row = findAccountById(db, `thb:${type}`)!;
      expect(row.name).toBe(THB_ROOT_NAMES[type]);
      expect(row.parent_id).toBeNull();
      expect(isLedgerRootId(row.id)).toBe(true);
    }
    expect(countAccounts(db)).toBe(ACCOUNT_TYPES.length);
  });

  it("gives each ledger its own root, so two ledgers are never one account", () => {
    ensureLedgerRoot(db, "thb", "asset");
    ensureLedgerRoot(db, "usd", "asset");
    // Distinct names, or the two roots are mutual fuzzy-match lookalikes.
    expect(findAccountById(db, "thb:asset")!.name).toBe("Assets (THB)");
    expect(findAccountById(db, "usd:asset")!.name).toBe("Assets (USD)");
  });
});

describe("ensureStructuralAccount", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("returns the id and builds each kind under its own ledger root", () => {
    for (const kind of STRUCTURAL_KINDS) {
      const { type, name } = STRUCTURAL_ACCOUNTS[kind];
      const id = ensureStructuralAccount(db, "thb", kind);
      expect(id).toBe(structuralAccountId("thb", kind));
      expect(id).toBe(`thb:${type}:${kind}`);

      const row = findAccountById(db, id)!;
      expect(row.type).toBe(type);
      expect(row.name).toBe(`${name} (THB)`);
      expect(row.parent_id).toBe(`thb:${type}`);
    }
  });

  it("is idempotent: the second call returns the same id and writes nothing", () => {
    const first = ensureStructuralAccount(db, "thb", "uncategorized");
    const after = countAccounts(db);
    expect(ensureStructuralAccount(db, "thb", "uncategorized")).toBe(first);
    expect(countAccounts(db)).toBe(after);
  });

  it("is per ledger: the same kind in another currency is a separate account", () => {
    const thb = ensureStructuralAccount(db, "thb", "adjustments");
    const usd = ensureStructuralAccount(db, "usd", "adjustments");
    expect(thb).toBe("thb:equity:adjustments");
    expect(usd).toBe("usd:equity:adjustments");
    expect(findAccountById(db, thb)!.name).toBe("Adjustments (THB)");
    expect(findAccountById(db, usd)!.name).toBe("Adjustments (USD)");
  });

  it("accepts an uppercase currency and lowercases it into the id", () => {
    expect(ensureStructuralAccount(db, "THB", "opening")).toBe("thb:equity:opening");
  });
});

describe("isLedgerRootId", () => {
  it("is true only for <currency>:<type>", () => {
    expect(isLedgerRootId("thb:asset")).toBe(true);
    expect(isLedgerRootId("thb:asset:cash")).toBe(false);
    // Two segments, but the second is not a type.
    expect(isLedgerRootId("thb:kbank")).toBe(false);
    expect(isLedgerRootId("asset")).toBe(false);
    expect(isLedgerRootId("thb")).toBe(false);
  });
});

describe("mergeAccounts", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb((d) => {
      seedAccount(d, { id: "thb:asset:cash" });
      seedAccount(d, { id: "thb:expense:fod" });
      seedAccount(d, { id: "thb:expense:food" });
    });
  });

  it("re-points legs, drops degenerate ones, and takes merchant defaults along", () => {
    const merchant = upsertMerchant(db, {
      canonical_name: "Cafe",
      default_account_id: "thb:expense:fod",
    }, []);
    const kept = insertTransaction(db, {
      date: "2026-05-01",
      description: "lunch",
      debit_account_id: "thb:expense:fod",
      credit_account_id: "thb:asset:cash",
      amount: 10000,
    });
    insertTransaction(db, {
      date: "2026-05-02",
      description: "would collapse",
      debit_account_id: "thb:expense:fod",
      credit_account_id: "thb:expense:food",
      amount: 5000,
    });

    expect(mergeAccounts(db, "thb:expense:fod", "thb:expense:food")).toEqual({
      moved: 1,
      deletedSelfTransactions: 1,
      movedMerchantDefaults: 1,
    });
    expect(findAccountById(db, "thb:expense:fod")).toBeNull();
    expect(findMerchantById(db, merchant.id)!.default_account_id).toBe("thb:expense:food");

    const row = db
      .prepare(`SELECT debit_account_id FROM transactions WHERE id = ?`)
      .get(kept.id) as { debit_account_id: string };
    expect(row.debit_account_id).toBe("thb:expense:food");
  });

  it("refuses a cross-ledger merge even when nothing would move", () => {
    seedAccount(db, { id: "usd:expense:food" });
    // No transactions: the cross-ledger trigger would never fire without this explicit guard.
    expect(() => mergeAccounts(db, "thb:expense:food", "usd:expense:food")).toThrow(
      /Cannot merge across ledgers/,
    );
    expect(findAccountById(db, "thb:expense:food")).toBeTruthy();
  });

  it("refuses a source that still has children", () => {
    seedAccount(db, { id: "thb:expense:food:dining" });
    expect(() => mergeAccounts(db, "thb:expense:food", "thb:expense:fod")).toThrow(
      /has 1 child account/,
    );
  });

  it("refuses a self-merge and unknown accounts", () => {
    expect(() => mergeAccounts(db, "thb:expense:food", "thb:expense:food")).toThrow(/into itself/);
    expect(() => mergeAccounts(db, "thb:expense:nope", "thb:expense:food")).toThrow(/not found/);
    expect(() => mergeAccounts(db, "thb:expense:food", "thb:expense:nope")).toThrow(/not found/);
  });
});

describe("deleteAccount", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb((d) => {
      seedAccount(d, { id: "thb:asset:cash" });
      seedAccount(d, { id: "thb:expense:food" });
    });
  });

  it("deletes an account nothing references", () => {
    deleteAccount(db, "thb:expense:food");
    expect(findAccountById(db, "thb:expense:food")).toBeNull();
  });

  it("refuses while transactions reference it", () => {
    insertTransaction(db, {
      date: "2026-05-01",
      description: "lunch",
      debit_account_id: "thb:expense:food",
      credit_account_id: "thb:asset:cash",
      amount: 10000,
    });
    expect(() => deleteAccount(db, "thb:expense:food")).toThrow(/still has transactions/);
  });

  it("refuses while it has children", () => {
    seedAccount(db, { id: "thb:expense:food:dining" });
    expect(() => deleteAccount(db, "thb:expense:food")).toThrow(/child account/);
  });

  it("nulls out a merchant default pointed at the deleted account (FK ON DELETE SET NULL)", () => {
    const merchant = upsertMerchant(db, {
      canonical_name: "Cafe",
      default_account_id: "thb:expense:food",
    }, []);

    deleteAccount(db, "thb:expense:food");

    expect(findAccountById(db, "thb:expense:food")).toBeNull();
    expect(findMerchantById(db, merchant.id)!.default_account_id).toBeNull();
  });
});
