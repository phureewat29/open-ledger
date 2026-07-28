import { randomUUID } from "node:crypto";
import type Database from "libsql";
import { decryptSecret, encryptSecret } from "../encryption.js";

/**
 * The `file_passwords` table: every statement password, encrypted at rest.
 * Callers hand over and receive plaintext only, never `password_encrypted`.
 * Which pattern to try for a file is policy, in src/ingest/vault.ts.
 */

/** A stored pattern and its use history, without the password. */
interface VaultPasswordRow {
  id: string;
  pattern: string;
  use_count: number;
  last_used_at: string | null;
}

/** A stored pattern with its password decrypted; use history is browsing
 *  detail — the unlock path just walks `BY_USE` in order. */
export interface StoredPassword {
  id: string;
  pattern: string;
  password: string;
}

// Most-used first: most likely to open the next statement too.
const BY_USE = `ORDER BY use_count DESC, last_used_at DESC NULLS LAST, created_at ASC`;

/** A vault browser, not a decrypt path — `listPasswordSecrets` is that. */
export function listPasswords(db: Database.Database): VaultPasswordRow[] {
  return db
    .prepare(`SELECT id, pattern, use_count, last_used_at FROM file_passwords ${BY_USE}`)
    .all() as VaultPasswordRow[];
}

interface SecretRow {
  id: string;
  pattern: string;
  password_encrypted: string;
}

/** Every stored password, decrypted, most-used first. */
export function listPasswordSecrets(db: Database.Database, dbKey: string): StoredPassword[] {
  const rows = db
    .prepare(`SELECT id, pattern, password_encrypted FROM file_passwords ${BY_USE}`)
    .all() as SecretRow[];
  return rows.map((row) => ({
    id: row.id,
    pattern: row.pattern,
    password: decryptSecret(row.password_encrypted, dbKey),
  }));
}

/** Replaces on conflict, so a bank's rotated password overwrites the stale one. */
export function upsertPassword(
  db: Database.Database,
  pattern: string,
  password: string,
  dbKey: string,
): string {
  const encrypted = encryptSecret(password, dbKey);
  const existing = db
    .prepare(`SELECT id FROM file_passwords WHERE pattern = ?`)
    .get(pattern) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE file_passwords
       SET password_encrypted = ?, use_count = 0, last_used_at = NULL
       WHERE id = ?`,
    ).run(encrypted, existing.id);
    return existing.id;
  }
  const id = `fp:${randomUUID()}`;
  db.prepare(
    `INSERT INTO file_passwords (id, pattern, password_encrypted) VALUES (?, ?, ?)`,
  ).run(id, pattern, encrypted);
  return id;
}

export function recordPasswordUse(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE file_passwords
     SET use_count = use_count + 1, last_used_at = datetime('now')
     WHERE id = ?`,
  ).run(id);
}

export function deletePassword(db: Database.Database, patternOrId: string): boolean {
  const result = db
    .prepare(`DELETE FROM file_passwords WHERE id = ? OR pattern = ?`)
    .run(patternOrId, patternOrId);
  return result.changes > 0;
}
