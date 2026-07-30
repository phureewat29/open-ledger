import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { findAccountById } from "../db/queries/accounts.js";
import { createAccount } from "./accounts.js";
import { resolveOnePosting } from "./resolve.js";
import { freshDb } from "../../fixtures/db.js";

function seedChartOfAccounts(db: Database.Database): void {
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
}

describe("resolveOnePosting", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedChartOfAccounts); });

  it("exact match: existing account, no hint", () => {
    const { posting, hint } = resolveOnePosting(db, { account_id: "expense:food" });
    expect(posting.account_id).toBe("expense:food");
    expect(hint).toBeNull();
  });

  it("well-formed multi-segment hint: auto-creates the path, placeholder_created (no fallback)", () => {
    const { posting, hint } = resolveOnePosting(db, { account_id: "expense:food:dining" });
    expect(posting.account_id).toBe("expense:food:dining");
    expect(hint).toEqual({ type: "placeholder_created", accountId: "expense:food:dining" });
    expect(findAccountById(db, "expense:food:dining")).toBeTruthy();
  });

  it("well-formed two-segment hint under a fresh top-level type: placeholder_created", () => {
    const { posting, hint } = resolveOnePosting(db, { account_id: "equity:opening-balance" });
    expect(posting.account_id).toBe("equity:opening-balance");
    expect(hint).toEqual({ type: "placeholder_created", accountId: "equity:opening-balance" });
    expect(findAccountById(db, "equity")).toBeTruthy();
    expect(findAccountById(db, "equity:opening-balance")).toBeTruthy();
  });

  it("leaf-only hint: falls back to expense:uncategorized (uncategorized_fallback)", () => {
    const { posting, hint } = resolveOnePosting(db, { account_id: "dining" });
    expect(posting.account_id).toBe("expense:uncategorized");
    expect(hint).toEqual({ type: "uncategorized_fallback", accountId: "expense:uncategorized" });
    expect(findAccountById(db, "dining")).toBeNull();
  });

  it("type-invalid hint (unknown top-level segment): uncategorized_fallback", () => {
    // "organic" misses fuzzy match; "groceries" isn't a known top-level type, so this falls back.
    const { posting, hint } = resolveOnePosting(db, { account_id: "groceries:organic" });
    expect(posting.account_id).toBe("expense:uncategorized");
    expect(hint).toEqual({ type: "uncategorized_fallback", accountId: "expense:uncategorized" });
    expect(findAccountById(db, "groceries:organic")).toBeNull();
  });

  // The guards' two target shapes: a leaf whose name contains its own parent's
  // ("kbank" contains "Bank") and an exact name match across roots ("p2p" vs the
  // expense twin). Neither is a lookalike, so neither may raise a question.
  it("never matches a leaf to its own ancestor: creates asset:bank:kbank", () => {
    createAccount(db, { id: "asset:bank", name: "Bank", type: "asset", parent_id: "asset" });

    const { posting, hint } = resolveOnePosting(db, { account_id: "asset:bank:kbank" });
    expect(posting.account_id).toBe("asset:bank:kbank");
    expect(hint).toEqual({ type: "placeholder_created", accountId: "asset:bank:kbank" });
    expect(findAccountById(db, "asset:bank:kbank")).toBeTruthy();
  });

  it("never matches across roots: creates income:transfers:p2p beside the expense twin", () => {
    createAccount(db, { id: "income", name: "Income", type: "income", parent_id: null });
    createAccount(db, { id: "expense:transfers", name: "Transfers", type: "expense", parent_id: "expense" });
    createAccount(db, {
      id: "expense:transfers:p2p",
      name: "P2p",
      type: "expense",
      parent_id: "expense:transfers",
    });

    const { posting, hint } = resolveOnePosting(db, { account_id: "income:transfers:p2p" });
    expect(posting.account_id).toBe("income:transfers:p2p");
    expect(hint).toEqual({ type: "placeholder_created", accountId: "income:transfers:p2p" });
  });

  it("a same-type lookalike is reported, never posted to", () => {
    createAccount(db, { id: "asset:bank", name: "Bank", type: "asset", parent_id: "asset" });
    createAccount(db, {
      id: "asset:bank:ttb",
      name: "TTB Savings",
      type: "asset",
      parent_id: "asset:bank",
    });

    const { posting, hint } = resolveOnePosting(db, { account_id: "asset:bank:ttb-saving" });
    expect(posting.account_id).toBe("asset:bank:ttb-saving");
    expect(hint).toEqual({
      type: "similar_account",
      accountId: "asset:bank:ttb-saving",
      similarId: "asset:bank:ttb",
    });
  });

  it("ancestor-type-mismatch during the walk: uncategorized_fallback", () => {
    // Raw INSERT creates a type-mismatched ancestor (bypassing createAccount's own
    // invariants) so the walk hits the mismatch that resolution swallows.
    db.prepare(
      `INSERT INTO accounts (id, name, type, parent_id) VALUES ('expense:weird', 'Weird', 'asset', 'expense')`,
    ).run();

    const { posting, hint } = resolveOnePosting(db, { account_id: "expense:weird:child" });
    expect(posting.account_id).toBe("expense:uncategorized");
    expect(hint).toEqual({ type: "uncategorized_fallback", accountId: "expense:uncategorized" });
    expect(findAccountById(db, "expense:weird:child")).toBeNull();
  });
});
