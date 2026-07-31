import { describe, it, expect } from "vitest";
import type Database from "libsql";
import { freshDb } from "../../fixtures/db.js";
import { insertAccount } from "../db/queries/accounts.js";
import { failAccountNotFound } from "./accounts.js";

interface ThrownCLIError {
  code: string;
  message: string;
  hint?: string;
}

// failAccountNotFound is typed `never`; catching it is the only way to assert on what it throws.
function catchFailAccountNotFound(
  ...args: Parameters<typeof failAccountNotFound>
): ThrownCLIError {
  try {
    failAccountNotFound(...args);
  } catch (err) {
    return err as ThrownCLIError;
  }
  throw new Error("unreachable: failAccountNotFound always throws");
}

function seedThbLedger(db: Database.Database): void {
  insertAccount(db, { id: "thb:expense", name: "Expenses", type: "expense", parent_id: null });
}

describe("failAccountNotFound", () => {
  it("prefix-less id, ledgers present: NOT_FOUND with a ledger-enumerating hint", () => {
    const db = freshDb(seedThbLedger);
    const err = catchFailAccountNotFound(db, "expense:food");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe('account "expense:food" not found');
    expect(err.hint).toBe("account ids start with a currency — existing ledgers: thb");
  });

  it("ledger-shaped id whose head names no existing ledger: NOT_FOUND with a ledger-enumerating hint, caller hint dropped", () => {
    const db = freshDb(seedThbLedger);
    const err = catchFailAccountNotFound(db, "eur:expense:food", "create it with `oled accounts create`");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe('account "eur:expense:food" not found');
    expect(err.hint).toBe("account ids start with a currency — existing ledgers: thb");
  });

  it("no ledgers at all: NOT_FOUND with the config --init hint, regardless of id shape", () => {
    const db = freshDb();
    const bare = catchFailAccountNotFound(db, "thb:expense:food");
    expect(bare.code).toBe("NOT_FOUND");
    expect(bare.hint).toBe(
      "account ids start with a currency (e.g. thb:expense:food); no ledger exists yet, run `oled config --init`",
    );

    const prefixLess = catchFailAccountNotFound(db, "expense:food");
    expect(prefixLess.hint).toBe(bare.hint);
  });

  it("ledger-scoped id whose head IS a real ledger: the caller's own hint passes through unchanged", () => {
    const db = freshDb(seedThbLedger);
    const err = catchFailAccountNotFound(db, "thb:expense:doesnotexist", "custom hint");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe('account "thb:expense:doesnotexist" not found');
    expect(err.hint).toBe("custom hint");
  });

  it("ledger-scoped id whose head IS a real ledger, no hint given: hint is undefined, not the ledger list", () => {
    const db = freshDb(seedThbLedger);
    const err = catchFailAccountNotFound(db, "thb:expense:doesnotexist");
    expect(err.hint).toBeUndefined();
  });
});
