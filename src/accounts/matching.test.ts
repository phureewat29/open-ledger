import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { createAccount } from "./accounts.js";
import { findAccountsByFuzzyName } from "./matching.js";
import { freshDb } from "../../fixtures/db.js";

describe("findAccountsByFuzzyName", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    createAccount(db, { id: "asset:ttb-1", name: "TTB Savings ••1234", type: "asset", parent_id: "asset" });
    createAccount(db, { id: "asset:scb-1", name: "SCB Savings ••5678", type: "asset", parent_id: "asset" });
    createAccount(db, { id: "asset:kbank-1", name: "KBank Savings ••9012", type: "asset", parent_id: "asset" });
  });

  it("finds the right account by substring", () => {
    const matches = findAccountsByFuzzyName(db, "ttb saving");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].account.id).toBe("asset:ttb-1");
    expect(matches[0].similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("returns multiple candidates ranked by similarity", () => {
    const matches = findAccountsByFuzzyName(db, "saving");
    const ids = matches.map(m => m.account.id);
    expect(ids).toContain("asset:ttb-1");
    expect(ids).toContain("asset:scb-1");
    expect(ids).toContain("asset:kbank-1");
  });

  it("respects the threshold", () => {
    const matches = findAccountsByFuzzyName(db, "xyz", 0.9);
    expect(matches).toHaveLength(0);
  });

  it("returns nothing for empty query", () => {
    expect(findAccountsByFuzzyName(db, "")).toEqual([]);
    expect(findAccountsByFuzzyName(db, "   ")).toEqual([]);
  });

  it("matches a number with a trailing check digit against the masked number", () => {
    createAccount(db, {
      id: "asset:kbank-7652",
      name: "KBank Savings ••7652",
      type: "asset",
      parent_id: "asset",
      account_number_masked: "••7652",
    });
    const matches = findAccountsByFuzzyName(db, "kbank savings 76520");
    expect(matches[0].account.id).toBe("asset:kbank-7652");
    expect(matches[0].similarity).toBeGreaterThanOrEqual(0.9);
  });
});

describe("findAccountsByFuzzyName matching key derivation for a masked-middle query", () => {
  it("matches on the literal trailing digits, not the longer unmasked prefix run", () => {
    const db = freshDb();
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, {
      id: "asset:kbank-9483",
      name: "KBank Savings",
      type: "asset",
      parent_id: "asset",
      account_number_masked: "••9483",
    });
    const matches = findAccountsByFuzzyName(db, "470686XXXXXX9483");
    expect(matches[0]?.account.id).toBe("asset:kbank-9483");
  });
});
