import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { createAccount } from "./accounts.js";
import { findAccountsByFuzzyName } from "./matching.js";
import { freshDb } from "../../fixtures/db.js";

describe("findAccountsByFuzzyName", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    createAccount(db, { id: "thb:asset:ttb1", name: "TTB Savings ••1234", type: "asset", parent_id: "thb:asset" });
    createAccount(db, { id: "thb:asset:scb1", name: "SCB Savings ••5678", type: "asset", parent_id: "thb:asset" });
    createAccount(db, { id: "thb:asset:kbank1", name: "KBank Savings ••9012", type: "asset", parent_id: "thb:asset" });
  });

  it("finds the right account by substring", () => {
    const matches = findAccountsByFuzzyName(db, "ttb saving");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].account.id).toBe("thb:asset:ttb1");
    expect(matches[0].similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("returns multiple candidates ranked by similarity", () => {
    const ids = findAccountsByFuzzyName(db, "saving").map((m) => m.account.id);
    expect(ids).toContain("thb:asset:ttb1");
    expect(ids).toContain("thb:asset:scb1");
    expect(ids).toContain("thb:asset:kbank1");
  });

  it("searches every ledger; narrowing to one is the caller's job", () => {
    createAccount(db, { id: "usd:asset:ttb1", name: "TTB Savings ••1234", type: "asset", parent_id: "usd:asset" });
    const ids = findAccountsByFuzzyName(db, "ttb savings").map((m) => m.account.id);
    expect(ids).toContain("thb:asset:ttb1");
    expect(ids).toContain("usd:asset:ttb1");
  });

  it("respects the threshold", () => {
    expect(findAccountsByFuzzyName(db, "xyz", 0.9)).toHaveLength(0);
  });

  it("returns nothing for empty query", () => {
    expect(findAccountsByFuzzyName(db, "")).toEqual([]);
    expect(findAccountsByFuzzyName(db, "   ")).toEqual([]);
  });

  it("matches a number with a trailing check digit against the masked number", () => {
    createAccount(db, {
      id: "thb:asset:kbank7652",
      name: "KBank Savings ••7652",
      type: "asset",
      parent_id: "thb:asset",
      account_number_masked: "••7652",
    });
    const matches = findAccountsByFuzzyName(db, "kbank savings 76520");
    expect(matches[0].account.id).toBe("thb:asset:kbank7652");
    expect(matches[0].similarity).toBeGreaterThanOrEqual(0.9);
  });
});

describe("findAccountsByFuzzyName matching key derivation for a masked-middle query", () => {
  it("matches on the literal trailing digits, not the longer unmasked prefix run", () => {
    const db = freshDb();
    createAccount(db, {
      id: "thb:asset:kbank9483",
      name: "KBank Savings",
      type: "asset",
      parent_id: "thb:asset",
      account_number_masked: "••9483",
    });
    const matches = findAccountsByFuzzyName(db, "470686XXXXXX9483");
    expect(matches[0]?.account.id).toBe("thb:asset:kbank9483");
  });
});
