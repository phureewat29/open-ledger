import Database from "libsql";
import { config } from "../config.js";
import { migrate } from "./schema.js";
import { dirname } from "path";
import { mkdirSync, existsSync, chmodSync } from "fs";

let singleDb: Database.Database | null = null;

function openDb(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const db = new Database(dbPath);

  try {
    db.pragma("journal_mode = WAL");
  } catch (err) {
    db.close();
    // Remaps into a NOT_READY-matching message (see NOT_READY_PATTERNS in cli/output.ts).
    throw new Error(
      `Failed to open database. ${dbPath} is corrupt or is not a database. ` +
      "Move it aside (keep a backup) and re-run to start a fresh one.",
      { cause: err },
    );
  }

  db.pragma("foreign_keys = ON");
  migrate(db, dbPath);
  // WAL mode writes committed rows into the -wal/-shm sidecars, so the 0600
  // promise has to cover them too. Best effort, same as the db file itself.
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { chmodSync(path, 0o600); } catch {}
  }
  return db;
}

export function getDb(): Database.Database {
  if (!singleDb) {
    singleDb = openDb(config.dbPath);
  }
  return singleDb;
}
