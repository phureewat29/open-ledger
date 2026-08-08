import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";

import { recordQuestion, listQuestions, closeQuestion, countQuestions, deferQuestion } from "./questions.js";
import { freshDb, seedAccount } from "../../../fixtures/db.js";

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function seedExpenseAccounts(db: Database.Database): void {
  seedAccount(db, { id: "thb:expense:food" });
}

function insertFile(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'ingested')`,
  ).run(id, `/tmp/${id}.pdf`, `hash-${id}`, "application/pdf");
}

describe("questions table", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedExpenseAccounts);
  });

  it("accepts arbitrary free-text kinds", () => {
    const kinds = ["uncategorized", "duplicate", "correlation", "recurrence_candidate", "similar_accounts", "file_password", "acme.tax_th__refund"];
    for (const k of kinds) {
      expect(() => recordQuestion(db, { file_id: null, account_id: "thb:expense:food", kind: k, prompt: k })).not.toThrow();
    }
    expect(listQuestions(db, { limit: 100 })).toHaveLength(kinds.length);
  });

  it("closeQuestion deletes the row and returns the captured tuple", () => {
    recordQuestion(db, { file_id: null, account_id: "thb:expense:food", kind: "uncategorized", prompt: "Which category?" });
    const open = listQuestions(db);
    expect(open).toHaveLength(1);
    const closed = closeQuestion(db, open[0].id, "thb:expense:food:groceries");
    expect(closed).toEqual({ prompt: "Which category?", kind: "uncategorized", answer: "thb:expense:food:groceries", rule_key: null });
    expect(listQuestions(db)).toHaveLength(0);
    expect(countQuestions(db)).toBe(0);
  });

  it("listQuestions scopes by batch_id when supplied", () => {
    recordQuestion(db, { file_id: null, batch_id: "ib:a", account_id: "thb:expense:food", kind: "uncategorized", prompt: "a" });
    recordQuestion(db, { file_id: null, batch_id: "ib:b", account_id: "thb:expense:food", kind: "uncategorized", prompt: "b" });
    recordQuestion(db, { file_id: null, batch_id: null, account_id: "thb:expense:food", kind: "uncategorized", prompt: "c" });
    expect(listQuestions(db, { batch_id: "ib:a" }).map(r => r.prompt)).toEqual(["a"]);
    expect(listQuestions(db, { batch_id: "ib:b" }).map(r => r.prompt)).toEqual(["b"]);
    expect(listQuestions(db).map(r => r.prompt).sort()).toEqual(["a", "b", "c"]);
  });

  it("countQuestions already supports kind and file_id scoping (pre-existing)", () => {
    insertFile(db, "sf-a");
    insertFile(db, "sf-b");
    recordQuestion(db, { file_id: "sf-a", account_id: "thb:expense:food", kind: "uncategorized", prompt: "a" });
    recordQuestion(db, { file_id: "sf-b", account_id: "thb:expense:food", kind: "duplicate", prompt: "b" });
    expect(countQuestions(db, { kind: "uncategorized" })).toBe(1);
    expect(countQuestions(db, { file_id: "sf-a" })).toBe(1);
    expect(countQuestions(db, { kind: "duplicate", file_id: "sf-b" })).toBe(1);
    expect(countQuestions(db, { kind: "duplicate", file_id: "sf-a" })).toBe(0);
  });
});

describe("deferQuestion", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedExpenseAccounts);
  });

  it("hides a deferred row from listQuestions and countQuestions by default", () => {
    const id = recordQuestion(db, { file_id: null, account_id: "thb:expense:food", kind: "uncategorized", prompt: "snooze me" });
    expect(listQuestions(db)).toHaveLength(1);
    expect(countQuestions(db)).toBe(1);

    expect(deferQuestion(db, id, 7)).toBe(true);

    expect(listQuestions(db)).toHaveLength(0);
    expect(countQuestions(db)).toBe(0);
  });

  it("surfaces deferred rows when includeDeferred is true", () => {
    const id = recordQuestion(db, { file_id: null, account_id: "thb:expense:food", kind: "uncategorized", prompt: "snooze me" });
    deferQuestion(db, id, 7);

    expect(listQuestions(db, { includeDeferred: true })).toHaveLength(1);
    expect(countQuestions(db, { includeDeferred: true })).toBe(1);
  });

  it("re-surfaces a row whose deferred_until has passed", () => {
    const id = recordQuestion(db, { file_id: null, account_id: "thb:expense:food", kind: "uncategorized", prompt: "stale defer" });
    deferQuestion(db, id, 7);
    expect(listQuestions(db)).toHaveLength(0);

    db.prepare(`UPDATE questions SET deferred_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') WHERE id = ?`).run(id);
    expect(listQuestions(db)).toHaveLength(1);
    expect(countQuestions(db)).toBe(1);
  });

  it("returns false when the id doesn't exist", () => {
    expect(deferQuestion(db, "cn:nope", 7)).toBe(false);
  });

  it("floors fractional days and clamps to >= 1", () => {
    const id = recordQuestion(db, { file_id: null, account_id: "thb:expense:food", kind: "uncategorized", prompt: "x" });
    expect(deferQuestion(db, id, 0)).toBe(true);
    const row = db.prepare(`SELECT deferred_until FROM questions WHERE id = ?`).get(id) as { deferred_until: string };
    expect(row.deferred_until).toMatch(ISO_TIMESTAMP_RE);
    expect(Date.parse(row.deferred_until)).toBeGreaterThan(Date.now() - 60_000);
  });
});
