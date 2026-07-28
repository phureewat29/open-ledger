import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { createAccount } from "../../accounts/accounts.js";
import { findAccountById, getAccountSubtree, updateAccountMetadata } from "./accounts.js";
import { freshDb } from "../../../fixtures/db.js";

describe("getAccountSubtree", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
    createAccount(db, { id: "expense:food:groceries", name: "Groceries", type: "expense", parent_id: "expense:food" });
    createAccount(db, { id: "expense:food:dining", name: "Dining", type: "expense", parent_id: "expense:food" });
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  });

  it("returns the subtree rooted at a given id", () => {
    const subtree = getAccountSubtree(db, "expense:food");
    const ids = subtree.map(r => r.id).sort();
    expect(ids).toEqual([
      "expense:food",
      "expense:food:dining",
      "expense:food:groceries",
    ]);
  });
});

describe("updateAccountMetadata", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    createAccount(db, {
      id: "liability:ktc",
      name: "KTC Card",
      type: "liability",
      parent_id: "liability",
      bank_name: "ktc",
      due_day: 15,
    });
  });

  it("returns before/after for changed fields", () => {
    const result = updateAccountMetadata(db, "liability:ktc", { due_day: 20, statement_day: 28 });
    expect(Object.keys(result.after).length).toBeGreaterThan(0);
    expect(result.before.due_day).toBe(15);
    expect(result.after.due_day).toBe(20);
    expect(result.before.statement_day).toBeNull();
    expect(result.after.statement_day).toBe(28);
  });

  it("reports no change when patch is empty", () => {
    const result = updateAccountMetadata(db, "liability:ktc", {});
    expect(Object.keys(result.after).length).toBe(0);
  });

  it("shallow-merges metadata into the existing blob", () => {
    updateAccountMetadata(db, "liability:ktc", { metadata: { points_program: "Forever" } });
    updateAccountMetadata(db, "liability:ktc", { metadata: { points_balance: 1200 } });
    const row = findAccountById(db, "liability:ktc")!;
    expect(JSON.parse(row.metadata_json!)).toEqual({
      points_program: "Forever",
      points_balance: 1200,
    });
  });

  it("normalizes a masked number's check digit on the way in", () => {
    updateAccountMetadata(db, "liability:ktc", { account_number_masked: "••7652-0" });
    expect(findAccountById(db, "liability:ktc")!.account_number_masked).toBe("••7652");
  });

  it("throws on unknown account", () => {
    expect(() => updateAccountMetadata(db, "asset:nope", { due_day: 1 })).toThrow(/not found/);
  });
});
