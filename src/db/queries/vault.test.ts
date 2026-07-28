import { describe, it, expect } from "vitest";
import { generateKey } from "../encryption.js";
import {
  deletePassword,
  listPasswordSecrets,
  listPasswords,
  recordPasswordUse,
  upsertPassword,
} from "./vault.js";
import { freshDb } from "../../../fixtures/db.js";

const dbKey = generateKey();

describe("file_passwords", () => {
  it("round-trips a password through the encrypted column", () => {
    const db = freshDb();
    const id = upsertPassword(db, "^kbank.*", "hunter2", dbKey);

    const secrets = listPasswordSecrets(db, dbKey);
    expect(secrets).toEqual([{ id, pattern: "^kbank.*", password: "hunter2" }]);
  });

  it("keeps the plaintext out of the browser rows and out of the stored column", () => {
    const db = freshDb();
    upsertPassword(db, "^kbank.*", "hunter2", dbKey);

    const rows = listPasswords(db);
    expect(rows).toEqual([
      { id: expect.stringMatching(/^fp:/), pattern: "^kbank.*", use_count: 0, last_used_at: null },
    ]);
    const stored = db.prepare(`SELECT password_encrypted FROM file_passwords`).get() as {
      password_encrypted: string;
    };
    expect(stored.password_encrypted).not.toContain("hunter2");
    expect(listPasswords(freshDb())).toEqual([]);
  });

  it("replaces the password on a re-add of the same pattern, resetting its use count", () => {
    const db = freshDb();
    const first = upsertPassword(db, "^kbank.*", "old", dbKey);
    recordPasswordUse(db, first);

    const second = upsertPassword(db, "^kbank.*", "new", dbKey);
    expect(second).toBe(first);
    expect(listPasswordSecrets(db, dbKey)).toEqual([
      expect.objectContaining({ password: "new" }),
    ]);
    expect(listPasswords(db)[0]).toMatchObject({ use_count: 0, last_used_at: null });
  });

  it("counts a use and orders the most-used pattern first", () => {
    const db = freshDb();
    upsertPassword(db, "^kbank.*", "a", dbKey);
    const busy = upsertPassword(db, "^scb.*", "b", dbKey);
    recordPasswordUse(db, busy);

    const rows = listPasswords(db);
    expect(rows.map((r) => r.pattern)).toEqual(["^scb.*", "^kbank.*"]);
    expect(rows[0]).toMatchObject({ use_count: 1, last_used_at: expect.any(String) });
  });

  it("deletes by id or by exact pattern, and reports a miss", () => {
    const db = freshDb();
    const id = upsertPassword(db, "^kbank.*", "a", dbKey);
    upsertPassword(db, "^scb.*", "b", dbKey);

    expect(deletePassword(db, "nope")).toBe(false);
    expect(deletePassword(db, id)).toBe(true);
    expect(deletePassword(db, "^scb.*")).toBe(true);
    expect(listPasswords(db)).toEqual([]);
  });
});
