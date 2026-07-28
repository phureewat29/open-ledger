import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { findAccountById } from "../db/queries/accounts.js";
import {
  createAccount,
  ensureStructuralAccount,
  ensureTopLevelRoot,
} from "./accounts.js";
import { freshDb } from "../../fixtures/db.js";

describe("createAccount", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("inserts a top-level type root with parent_id=null", () => {
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    const row = findAccountById(db, "asset");
    expect(row).toBeTruthy();
    expect(row!.parent_id).toBeNull();
  });

  it("inserts a leaf account under an existing parent", () => {
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, {
      id: "asset:kbank-savings-1234",
      name: "KBank Savings ••1234",
      type: "asset",
      parent_id: "asset",
      subtype: "bank",
      bank_name: "kbank",
      account_number_masked: "••1234",
      currency: "THB",
    });
    const row = findAccountById(db, "asset:kbank-savings-1234");
    expect(row).toBeTruthy();
    expect(row!.parent_id).toBe("asset");
    expect(row!.bank_name).toBe("KBANK");
    expect(row!.currency).toBe("THB");
  });

  it("drops a trailing check digit from the stored masked number", () => {
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, {
      id: "asset:scb-savings-7652",
      name: "SCB Savings ••7652",
      type: "asset",
      parent_id: "asset",
      account_number_masked: "••7652-0",
      currency: "THB",
    });
    expect(findAccountById(db, "asset:scb-savings-7652")!.account_number_masked).toBe("••7652");
  });

  it("auto-bootstraps the top-level root when the parent is one of the five types", () => {
    createAccount(db, {
      id: "expense:food",
      name: "Food",
      type: "expense",
      parent_id: "expense",
    });
    expect(findAccountById(db, "expense")).toBeTruthy();
    expect(findAccountById(db, "expense:food")).toBeTruthy();
  });

  it("rejects parent/type mismatch", () => {
    createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
    expect(() =>
      createAccount(db, { id: "expense:misc", name: "Misc", type: "asset", parent_id: "expense" }),
    ).toThrow(/does not match parent/);
  });

  it("rejects id without parent prefix", () => {
    createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
    expect(() =>
      createAccount(db, { id: "groceries", name: "Groceries", type: "expense", parent_id: "expense" }),
    ).toThrow(/must start with parent id/);
  });

  it("rejects missing parent when not auto-bootstrappable", () => {
    expect(() =>
      createAccount(db, { id: "expense:food:nuts", name: "Nuts", type: "expense", parent_id: "expense:food" }),
    ).toThrow(/does not exist/);
  });

  it("throws ACCOUNT_EXISTS on duplicate id", () => {
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, { id: "asset:dup", name: "First", type: "asset", parent_id: "asset" });
    expect(() =>
      createAccount(db, { id: "asset:dup", name: "Second", type: "asset", parent_id: "asset" }),
    ).toThrow(/already exists/);
  });

  it("serializes metadata to JSON", () => {
    createAccount(db, {
      id: "liability:ktc",
      name: "KTC Card",
      type: "liability",
      parent_id: "liability",
      metadata: { points_program: "Forever" },
    });
    const row = findAccountById(db, "liability:ktc")!;
    expect(JSON.parse(row.metadata_json!)).toEqual({ points_program: "Forever" });
  });
});

describe("ensureStructuralAccount + ensureTopLevelRoot", () => {
  it("idempotently creates uncategorized expense + parent", () => {
    const db = freshDb();
    ensureStructuralAccount(db, "expense:uncategorized");
    ensureStructuralAccount(db, "expense:uncategorized");
    expect(findAccountById(db, "expense")).toBeTruthy();
    const row = findAccountById(db, "expense:uncategorized")!;
    expect(row.parent_id).toBe("expense");
    expect(row.name).toBe("Uncategorized");
  });

  it("idempotently creates the five top-level type roots", () => {
    const db = freshDb();
    for (const t of ["asset", "liability", "income", "expense", "equity"] as const) {
      ensureTopLevelRoot(db, t);
      ensureTopLevelRoot(db, t);
      expect(findAccountById(db, t)).toBeTruthy();
    }
  });
});
