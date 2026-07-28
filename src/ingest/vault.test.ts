import { describe, it, expect, beforeEach } from "vitest";
import { generateKey } from "../db/encryption.js";
import { config } from "../config.js";
import { encryptedPdf, textPdf } from "../../fixtures/pdf.js";
import { upsertPassword } from "../db/queries/vault.js";
import { findCandidates, unlockNonInteractive } from "./vault.js";
import { freshDb } from "../../fixtures/db.js";

describe("findCandidates", () => {
  it("matches a stored pattern against the file name alone, ignoring its directory", () => {
    const db = freshDb();
    const dbKey = generateKey();
    const id = upsertPassword(db, "^kbank-\\d+\\.pdf$", "hunter2", dbKey);

    expect(findCandidates(db, "/data/kbank-2026.pdf", dbKey)).toEqual([
      expect.objectContaining({ id, password: "hunter2" }),
    ]);
    expect(findCandidates(db, "/data/scb-2026.pdf", dbKey)).toEqual([]);
  });

  it("ignores a stored pattern that is not a valid regex", () => {
    const db = freshDb();
    const dbKey = generateKey();
    upsertPassword(db, "([unclosed", "secret", dbKey);
    expect(findCandidates(db, "anything.pdf", dbKey)).toEqual([]);
  });
});

describe("unlockNonInteractive", () => {
  beforeEach(() => {
    config.dbEncryptionKey = generateKey();
  });

  it("passes through a non-encrypted PDF unchanged", async () => {
    const db = freshDb();
    const bytes = textPdf();
    const result = await unlockNonInteractive(db, bytes, "plain.pdf", {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decrypted).toBe(bytes);
  });

  it("unlocks via a matching vault password and records the use", async () => {
    const db = freshDb();
    const enc = await encryptedPdf("secret");
    const id = upsertPassword(db, "^kbank.*", "secret", config.dbEncryptionKey);

    const result = await unlockNonInteractive(db, enc, "kbank-may.pdf", {});
    expect(result.ok).toBe(true);

    const row = db
      .prepare(`SELECT use_count FROM file_passwords WHERE id = ?`)
      .get(id) as { use_count: number };
    expect(row.use_count).toBe(1);
  });

  it("persists a caller-supplied password on success", async () => {
    const db = freshDb();
    const enc = await encryptedPdf("secret");

    const result = await unlockNonInteractive(db, enc, "kbank-may.pdf", {
      password: "secret",
    });
    expect(result.ok).toBe(true);

    const saved = findCandidates(db, "kbank-may.pdf", config.dbEncryptionKey);
    expect(saved).toHaveLength(1);
    expect(saved[0].password).toBe("secret");
  });

  it("reports wrong_password for a bad caller password", async () => {
    const db = freshDb();
    const enc = await encryptedPdf("secret");
    const result = await unlockNonInteractive(db, enc, "kbank-may.pdf", {
      password: "nope",
    });
    expect(result).toEqual({ ok: false, reason: "wrong_password" });
  });

  it("reports password_required when nothing unlocks it", async () => {
    const db = freshDb();
    const enc = await encryptedPdf("secret");
    const result = await unlockNonInteractive(db, enc, "kbank-may.pdf", {});
    expect(result).toEqual({ ok: false, reason: "password_required" });
  });

  // suggestPattern() is private; exercised here through its effect on findCandidates, not imported directly.
  it("derives a reusable alpha-prefix pattern, matching sibling statements from the same source", async () => {
    const db = freshDb();
    const enc = await encryptedPdf("secret");
    const result = await unlockNonInteractive(db, enc, "AcctSt_May26.pdf", {
      password: "secret",
    });
    expect(result.ok).toBe(true);

    expect(findCandidates(db, "AcctSt_Dec26.pdf", config.dbEncryptionKey)).toHaveLength(1);
    expect(findCandidates(db, "Other_May26.pdf", config.dbEncryptionKey)).toHaveLength(0);
  });

  it("falls back to a digit-collapsed pattern when the prefix is too short or non-alpha", async () => {
    const db = freshDb();
    const enc = await encryptedPdf("secret");
    const result = await unlockNonInteractive(db, enc, "1234567890.pdf", {
      password: "secret",
    });
    expect(result.ok).toBe(true);

    expect(findCandidates(db, "9876543210.pdf", config.dbEncryptionKey)).toHaveLength(1);
    expect(findCandidates(db, "abc.pdf", config.dbEncryptionKey)).toHaveLength(0);
  });
});
