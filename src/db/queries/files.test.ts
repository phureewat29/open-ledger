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

import { insertTransaction, findTransactionById, voidTransactionAsMirror } from "./transactions.js";
import { recordQuestion } from "./questions.js";
import { freshDb, seedAccount } from "../../../fixtures/db.js";

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function insertFile(db: Database.Database, id: string, status: "pending" | "ingested" | "failed"): void {
  db.prepare(
    `INSERT INTO files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, `/tmp/${id}.pdf`, `hash-${id}`, "application/pdf", status);
}

function seedChartOfAccounts(db: Database.Database): void {
  seedAccount(db, { id: "thb:asset:kbank", name: "KBank" });
  seedAccount(db, { id: "thb:expense:food" });
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
      debit_account_id: "thb:expense:food",
      credit_account_id: "thb:asset:kbank",
      amount: 10000,
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
    expect(result.unvoided).toBe(0);
    expect(findFileById(db, "a")).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toMatchObject({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM questions`).get()).toMatchObject({ n: 0 });
  });

  it("returns null counts and no error when the id is unknown", () => {
    const result = deleteFile(freshDb(), "nope");
    expect(result).toEqual({ removed: null, removedTransactions: 0, removedQuestions: 0, unvoided: 0 });
  });

  it("counts mirrors from OTHER files that the source-file CASCADE silently un-voids", () => {
    const db = freshDb();
    seedChartOfAccounts(db);
    insertFile(db, "a", "ingested");
    insertFile(db, "b", "ingested");
    const { id: survivorId } = insertTransaction(db, {
      date: "2026-05-19",
      description: "Coffee",
      source_file_id: "a",
      debit_account_id: "thb:expense:food",
      credit_account_id: "thb:asset:kbank",
      amount: 10000,
    });
    const { id: mirrorId } = insertTransaction(db, {
      date: "2026-05-19",
      description: "Coffee (restatement)",
      source_file_id: "b",
      debit_account_id: "thb:expense:food",
      credit_account_id: "thb:asset:kbank",
      amount: 10000,
    });
    voidTransactionAsMirror(db, mirrorId, survivorId);
    expect(findTransactionById(db, mirrorId)?.void_of).toBe(survivorId);

    const result = deleteFile(db, "a");

    // The self-FK's ON DELETE SET NULL un-voids the mirror; nothing else does.
    expect(result.removedTransactions).toBe(1);
    expect(result.unvoided).toBe(1);
    expect(findTransactionById(db, mirrorId)?.void_of).toBeNull();
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
    expect(row.ingested_at).toMatch(ISO_TIMESTAMP_RE);
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
