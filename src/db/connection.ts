import Database from "libsql";
import { DBNotReadyError } from "./errors.js";
import { migrate } from "./schema.js";
import { dirname } from "path";
import { mkdirSync, existsSync } from "fs";
import { chmod600 } from "../perms.js";

export function openDb(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const db = new Database(dbPath);

  try {
    db.pragma("journal_mode = WAL");
  } catch (err) {
    db.close();
    throw new DBNotReadyError(
      `Failed to open database. ${dbPath} is corrupt or is not a database. ` +
      "Move it aside (keep a backup) and re-run to start a fresh one.",
      { cause: err },
    );
  }

  db.pragma("foreign_keys = ON");
  migrate(db, dbPath);
  // WAL mode writes committed rows into the -wal/-shm sidecars, so the 0600 promise has to cover them too.
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    chmod600(path);
  }
  return db;
}
