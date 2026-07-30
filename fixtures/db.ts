import Database from "libsql";
import { migrate } from "../src/db/schema.js";

/**
 * Foreign keys are ON: sqlite defaults them off, and the schema's cascades
 * are what many of these tests actually assert.
 */
export function freshDb(seed?: (db: Database.Database) => void): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  seed?.(db);
  return db;
}
