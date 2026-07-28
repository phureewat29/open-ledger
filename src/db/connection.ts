import Database from "libsql";
import { config } from "../config.js";
import { migrate } from "./schema.js";
import { dirname } from "path";
import { mkdirSync, existsSync, chmodSync } from "fs";

let singleDb: Database.Database | null = null;

function openDb(dbPath: string, encryptionKey?: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const opts: Record<string, string> = {};
  if (encryptionKey) {
    opts.encryptionCipher = "aes256cbc";
    opts.encryptionKey = encryptionKey;
  }

  const db = new Database(dbPath, opts);

  try {
    db.pragma("journal_mode = WAL");
  } catch (err) {
    db.close();
    // Remaps into a NOT_READY-matching message (see NOT_READY_PATTERNS in cli/output.ts).
    throw new Error(
      "Failed to open database. Wrong encryption key or corrupt database file. " +
      "If you changed your encryption key, restore from backup or delete ~/.oled/db.sqlite to start fresh.",
      { cause: err },
    );
  }

  db.pragma("foreign_keys = ON");
  migrate(db, dbPath);
  try { chmodSync(dbPath, 0o600); } catch {}
  return db;
}

export function getDb(): Database.Database {
  if (!singleDb) {
    singleDb = openDb(config.dbPath, config.dbEncryptionKey || undefined);
  }
  return singleDb;
}

