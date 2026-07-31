import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";

import {
  countAccounts,
  findAccountById,
  getAccountSubtree,
  insertStructuralAccount,
  updateAccountMetadata,
} from "./accounts.js";
import { freshDb, seedAccount } from "../../../fixtures/db.js";

describe("getAccountSubtree", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedAccount(db, { id: "thb:expense:food" });
    seedAccount(db, { id: "thb:expense:food:groceries" });
    seedAccount(db, { id: "thb:expense:food:dining" });
    seedAccount(db, { id: "thb:asset:cash" });
  });

  it("returns the subtree rooted at a given id", () => {
    const subtree = getAccountSubtree(db, "thb:expense:food");
    const ids = subtree.map(r => r.id).sort();
    expect(ids).toEqual([
      "thb:expense:food",
      "thb:expense:food:dining",
      "thb:expense:food:groceries",
    ]);
  });
});

describe("insertStructuralAccount", () => {
  it("swallows a lost race on the id: the winner's row stands, no UNIQUE escapes", () => {
    // Every caller checks findAccountById first, so a second insert here is a concurrent writer having won in between.
    const db = freshDb();
    const root = { id: "thb:asset", name: "Assets (THB)", type: "asset", parent_id: null } as const;
    insertStructuralAccount(db, { ...root });

    expect(() =>
      insertStructuralAccount(db, { ...root, name: "Assets (THB) — later writer" }),
    ).not.toThrow();
    expect(findAccountById(db, "thb:asset")!.name).toBe("Assets (THB)");
    expect(countAccounts(db)).toBe(1);
  });
});

describe("updateAccountMetadata", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedAccount(db, { id: "thb:liability:ktc", name: "KTC Card", bank_name: "ktc", due_day: 15 });
  });

  it("returns before/after for changed fields", () => {
    const result = updateAccountMetadata(db, "thb:liability:ktc", { due_day: 20, statement_day: 28 });
    expect(Object.keys(result.after).length).toBeGreaterThan(0);
    expect(result.before.due_day).toBe(15);
    expect(result.after.due_day).toBe(20);
    expect(result.before.statement_day).toBeNull();
    expect(result.after.statement_day).toBe(28);
  });

  it("reports no change when patch is empty", () => {
    const result = updateAccountMetadata(db, "thb:liability:ktc", {});
    expect(Object.keys(result.after).length).toBe(0);
  });

  it("shallow-merges metadata into the existing blob", () => {
    updateAccountMetadata(db, "thb:liability:ktc", { metadata: { points_program: "Forever" } });
    updateAccountMetadata(db, "thb:liability:ktc", { metadata: { points_balance: 1200 } });
    const row = findAccountById(db, "thb:liability:ktc")!;
    expect(JSON.parse(row.metadata_json!)).toEqual({
      points_program: "Forever",
      points_balance: 1200,
    });
  });

  it("normalizes a masked number's check digit on the way in", () => {
    updateAccountMetadata(db, "thb:liability:ktc", { account_number_masked: "••7652-0" });
    expect(findAccountById(db, "thb:liability:ktc")!.account_number_masked).toBe("••7652");
  });

  it("throws on unknown account", () => {
    expect(() => updateAccountMetadata(db, "thb:asset:nope", { due_day: 1 })).toThrow(/not found/);
  });
});
