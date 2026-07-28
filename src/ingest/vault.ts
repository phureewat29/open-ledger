import { basename } from "node:path";
import type Database from "libsql";
import { config } from "../config.js";
import {
  listPasswordSecrets,
  recordPasswordUse,
  upsertPassword,
  type StoredPassword,
} from "../db/queries/vault.js";
import { isEncryptedPdf, unlockPdf } from "../extract/pdf.js";

// The SQL and the at-rest encryption live in src/db/queries/vault.ts; the
// mupdf mechanism in src/extract/pdf.ts.

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const SEPARATORS = /[_\-\s.]/;
const MIN_PREFIX_LEN = 3;

/** Short or non-alpha prefixes fall back to escaped+digit-collapse to avoid `^a.*`-style false positives. */
function suggestPattern(filename: string): string {
  const name = basename(filename).toLowerCase();
  const prefix = name.split(SEPARATORS)[0];

  if (prefix.length >= MIN_PREFIX_LEN && /^[a-z]/.test(prefix)) {
    return `^${prefix.replace(REGEX_META, "\\$&")}.*`;
  }

  const escaped = name.replace(REGEX_META, "\\$&");
  const collapsed = escaped.replace(/\d+/g, "\\d+");
  return `^${collapsed}$`;
}

/** A pattern that no longer compiles must not sink the whole lookup. */
function safeTest(pattern: string, target: string): boolean {
  try {
    return new RegExp(pattern, "i").test(target);
  } catch {
    return false;
  }
}

/** Stored passwords whose pattern matches this file's name, most-used first. */
export function findCandidates(
  db: Database.Database,
  filePath: string,
  dbKey: string,
): StoredPassword[] {
  const target = basename(filePath);
  return listPasswordSecrets(db, dbKey).filter((row) => safeTest(row.pattern, target));
}

type UnlockNonInteractiveResult =
  | { ok: true; decrypted: Buffer }
  | { ok: false; reason: "password_required" | "wrong_password" };

/** Non-interactive unlock for the agent-CLI harness: no prompts, no spinners. */
export async function unlockNonInteractive(
  db: Database.Database,
  bytes: Buffer,
  filename: string,
  opts: { password?: string },
): Promise<UnlockNonInteractiveResult> {
  if (!(await isEncryptedPdf(bytes))) {
    return { ok: true, decrypted: bytes };
  }

  for (const cand of findCandidates(db, filename, config.dbEncryptionKey)) {
    const result = await unlockPdf(bytes, cand.password);
    if (result.ok) {
      recordPasswordUse(db, cand.id);
      return { ok: true, decrypted: result.decrypted };
    }
  }

  const password = opts.password ?? "";
  if (!password) return { ok: false, reason: "password_required" };

  const result = await unlockPdf(bytes, password);
  if (!result.ok) {
    return { ok: false, reason: "wrong_password" };
  }
  upsertPassword(db, suggestPattern(filename), password, config.dbEncryptionKey);
  return { ok: true, decrypted: result.decrypted };
}
