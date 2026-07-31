import type Database from "libsql";
import { copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DBNotReadyError } from "./errors.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";
import { ISO_NOW_SQL } from "./timestamps.js";

// A migration may drop tables (0002 rebaselines v1); the file is copied aside first.
export function migrate(db: Database.Database, dbPath?: string): void {
  applyMigrations(db, MIGRATIONS, dbPath);
}

/** Migrations are a parameter, not a direct import, so tests can drive a synthetic manifest. */
export function applyMigrations(
  db: Database.Database,
  migrations: Migration[],
  dbPath?: string,
): void {
  const current = currentVersion(db);

  if (current > migrations.length) {
    throw new DBNotReadyError(
      `Database schema version ${current} is newer than this build supports ` +
        `(${migrations.length}). Upgrade OpenLedger to open this database.`,
    );
  }
  if (current === migrations.length) return;

  // Every migration is CREATE TABLE IF NOT EXISTS, so a foreign database would otherwise be half-adopted in silence.
  if (current === 0 && hasUserTables(db)) {
    const at = dbPath ? ` at ${dbPath}` : "";
    throw new DBNotReadyError(
      `This database${at} is not an OpenLedger database. Your data has not been ` +
        `touched. Back up the file, then remove it to start fresh.`,
    );
  }

  // A version-0 database that reaches here is empty; only an upgrade has anything worth copying.
  if (dbPath && current >= 1) backupDatabase(db, dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (${ISO_NOW_SQL})
    );
  `);

  for (let i = current; i < migrations.length; i++) {
    const version = i + 1;
    const migration = migrations[i];
    const apply = db.transaction((): void => {
      migration.up(db);
      db.prepare(`INSERT INTO schema_migrations (version) VALUES (?)`).run(version);
    });
    apply();
  }
}

function currentVersion(db: Database.Database): number {
  const table = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1`,
    )
    .get();
  if (!table) return 0;
  const row = db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations`)
    .get() as { version: number };
  return row.version;
}

/** Which of `tables` this database does not have: the schema half of `doctor`. */
export function listMissingTables(db: Database.Database, tables: string[]): string[] {
  const placeholders = tables.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .all(...tables) as { name: string }[];
  const present = new Set(rows.map((r) => r.name));
  return tables.filter((t) => !present.has(t));
}

/** True if the database holds any table other than the migration ledger itself. */
function hasUserTables(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
        LIMIT 1`,
    )
    .get();
  return !!row;
}

// Checkpoints the WAL first so the copy is complete; a non-WAL database tolerates the checkpoint failing.
function backupDatabase(db: Database.Database, dbPath: string): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Rollback-journal databases have no WAL to checkpoint; the copy still holds.
  }
  copyFileSync(dbPath, `${dbPath}.${backupStamp()}.bak`);
  pruneBackups(dbPath);
}

function backupStamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Keeps the five newest `<dbPath>.<stamp>.bak` copies; older ones are pruned. */
function pruneBackups(dbPath: string): void {
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.`;
  // The fixed-width stamp makes lexicographic order chronological.
  const backups = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
    .sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - 5))) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // A backup already gone is fine; pruning is best-effort.
    }
  }
}
