import { describe, it, expect } from "vitest";
import Database from "libsql";
import {
  countFiles,
  deleteFile,
  findFileById,
  listFiles,
  markFileIngested,
  markFileFailed,
} from "./files.js";
import { createAccount } from "../../accounts/accounts.js";
import { insertTransaction } from "./transactions.js";
import { recordQuestion } from "./questions.js";
import { freshDb } from "../../../fixtures/db.js";

function insertFile(db: Database.Database, id: string, status: "pending" | "ingested" | "failed"): void {
  db.prepare(
    `INSERT INTO files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, `/tmp/${id}.pdf`, `hash-${id}`, "application/pdf", status);
}

function seedChartOfAccounts(db: Database.Database): void {
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "asset:kbank", name: "KBank", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
}

describe("countFiles", () => {
  it("returns all zeros for an empty table", () => {
    expect(countFiles(freshDb())).toEqual({ ingested: 0, pending: 0, failed: 0 });
  });

  it("buckets rows by status", () => {
    const db = freshDb();
    insertFile(db, "a", "ingested");
    insertFile(db, "b", "ingested");
    insertFile(db, "c", "ingested");
    insertFile(db, "d", "pending");
    insertFile(db, "e", "failed");
    insertFile(db, "f", "failed");

    expect(countFiles(db)).toEqual({ ingested: 3, pending: 1, failed: 2 });
  });
});

describe("listFiles / findFileById", () => {
  it("returns rows including the source column", () => {
    const db = freshDb();
    insertFile(db, "a", "ingested");
    db.prepare(
      `UPDATE files SET source = 'anthropic', ingested_at = '2026-05-24 10:00:00' WHERE id = ?`,
    ).run("a");
    insertFile(db, "b", "pending");

    const rows = listFiles(db);
    expect(rows).toHaveLength(2);

    const ingested = rows.find(r => r.id === "a")!;
    expect(ingested.source).toBe("anthropic");

    const pending = rows.find(r => r.id === "b")!;
    expect(pending.source).toBeNull();
  });

  it("findFileById returns null for an unknown id", () => {
    expect(findFileById(freshDb(), "nope")).toBeNull();
  });
});

describe("deleteFile", () => {
  it("returns the removed row plus cascade counts and wipes the dependents", () => {
    const db = freshDb();
    seedChartOfAccounts(db);
    insertFile(db, "a", "ingested");
    const { id: transactionId } = insertTransaction(db, {
      date: "2026-05-19",
      description: "Coffee",
      source_file_id: "a",
      debit_account_id: "expense:food",
      credit_account_id: "asset:kbank",
      amount: 10000,
      currency: "THB",
    });
    recordQuestion(db, {
      file_id: "a",
      transaction_id: transactionId,
      account_id: null,
      kind: "uncategorized",
      prompt: "Categorize this",
    });

    const result = deleteFile(db, "a");

    expect(result.removed?.id).toBe("a");
    expect(result.removedTransactions).toBe(1);
    expect(result.removedQuestions).toBe(1);
    expect(findFileById(db, "a")).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toMatchObject({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM questions`).get()).toMatchObject({ n: 0 });
  });

  it("returns null counts and no error when the id is unknown", () => {
    const result = deleteFile(freshDb(), "nope");
    expect(result).toEqual({ removed: null, removedTransactions: 0, removedQuestions: 0 });
  });
});

describe("markFileIngested", () => {
  it("stamps status/source/ingested_at", () => {
    const db = freshDb();
    insertFile(db, "a", "pending");

    const changes = markFileIngested(db, "a", { source: "anthropic" });

    expect(changes).toBe(1);
    const row = findFileById(db, "a")!;
    expect(row.status).toBe("ingested");
    expect(row.source).toBe("anthropic");
    expect(row.ingested_at).not.toBeNull();
  });

  it("returns 0 changes for an unknown id", () => {
    expect(markFileIngested(freshDb(), "nope", { source: "anthropic" })).toBe(0);
  });
});

describe("markFileFailed", () => {
  it("stamps status/source/error, leaving ingested_at untouched", () => {
    const db = freshDb();
    insertFile(db, "a", "pending");

    const changes = markFileFailed(db, "a", { source: "external", error: "boom" });

    expect(changes).toBe(1);
    const row = findFileById(db, "a")!;
    expect(row.status).toBe("failed");
    expect(row.source).toBe("external");
    expect(row.error).toBe("boom");
    expect(row.ingested_at).toBeNull();
  });

  it("returns 0 changes for an unknown id", () => {
    expect(markFileFailed(freshDb(), "nope", { source: "external", error: "x" })).toBe(0);
  });
});
