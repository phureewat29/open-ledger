import { describe, it, expect } from "vitest";
import Database from "libsql";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, applyMigrations } from "./schema.js";
import type { Migration } from "./migrations/index.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

function tableNames(db: Database.Database): string[] {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((r: any) => r.name);
}

function versions(db: Database.Database): number[] {
  return (db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as {
    version: number;
  }[]).map((r) => r.version);
}

function rowCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

function backups(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.startsWith("db.sqlite.") && n.endsWith(".bak"));
}

describe("migrate", () => {
  it("creates the expected tables", () => {
    const db = freshDb();
    migrate(db);

    // The baseline is the whole schema, so this list is exhaustive.
    expect(tableNames(db).sort()).toEqual([
      "accounts",
      "file_passwords",
      "files",
      "merchant_aliases",
      "merchants",
      "notes",
      "questions",
      "schema_migrations",
      "settings",
      "transactions",
    ]);
  });

  it("leaves a fresh database at the baseline version", () => {
    const db = freshDb();
    migrate(db);

    expect(versions(db)).toEqual([1]);
  });

  it("creates notes with a category CHECK and no default", () => {
    const db = freshDb();
    migrate(db);

    const insert = db.prepare(`INSERT INTO notes (content, category) VALUES (?, ?)`);
    for (const category of ["rule", "preference", "fact"]) {
      expect(() => insert.run(`a ${category}`, category)).not.toThrow();
    }
    expect(() => insert.run("a general note", "general")).toThrow();

    // Every write path supplies the category, so an omitted one is a bug, not
    // a row to be defaulted.
    expect(() => db.prepare(`INSERT INTO notes (content) VALUES (?)`).run("no category")).toThrow();
  });

  it("creates files with source and without provider/model", () => {
    const db = freshDb();
    migrate(db);

    const cols = (db.prepare(`PRAGMA table_info(files)`).all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toContain("source");
    expect(cols).not.toContain("provider");
    expect(cols).not.toContain("model");
  });

  it("is idempotent", () => {
    const db = freshDb();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });

  it("records each applied version once and preserves data across re-migration", () => {
    const db = freshDb();
    migrate(db);
    db.prepare(
      `INSERT INTO accounts (id, name, type) VALUES ('asset:a', 'A', 'asset'), ('asset:b', 'B', 'asset')`,
    ).run();
    db.prepare(
      `INSERT INTO transactions (id, date, description, debit_account_id, credit_account_id, amount, currency)
       VALUES ('tx:1', '2026-07-01', 'Coffee', 'asset:a', 'asset:b', 100, 'THB')`,
    ).run();

    // A second migrate() takes the up-to-date fast path: no guard, no wipe.
    expect(() => migrate(db)).not.toThrow();

    expect(rowCount(db, "transactions")).toBe(1);
    expect(rowCount(db, "accounts")).toBe(2);
    expect(versions(db)).toEqual([1]);
  });

  it("accepts hierarchical accounts via parent_id", () => {
    const db = freshDb();
    migrate(db);

    db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`)
      .run("expense", "Expenses", "expense");
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("expense:food", "Food", "expense", "expense");
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("expense:food:groceries", "Groceries", "expense", "expense:food");

    const row = db
      .prepare(`SELECT parent_id FROM accounts WHERE id = ?`)
      .get("expense:food:groceries") as { parent_id: string };
    expect(row.parent_id).toBe("expense:food");
  });

  it("dedups merchant aliases on normalized_pattern", () => {
    const db = freshDb();
    migrate(db);

    db.prepare(`INSERT INTO merchants (id, canonical_name) VALUES (?, ?)`)
      .run("m:starbucks", "Starbucks");
    db.prepare(
      `INSERT INTO merchant_aliases (id, merchant_id, normalized_pattern) VALUES (?, ?, ?)`
    ).run("ma:1", "m:starbucks", "starbucks");

    expect(() =>
      db.prepare(
        `INSERT INTO merchant_aliases (id, merchant_id, normalized_pattern) VALUES (?, ?, ?)`
      ).run("ma:2", "m:starbucks", "starbucks"),
    ).toThrow();
  });
});

describe("transactions table (TigerBeetle-core)", () => {
  function seededDb() {
    const db = freshDb();
    migrate(db);
    db.prepare(`INSERT INTO accounts (id, name, type) VALUES ('asset', 'Assets', 'asset')`).run();
    db.prepare(
      `INSERT INTO accounts (id, name, type, parent_id) VALUES ('asset:a', 'A', 'asset', 'asset')`,
    ).run();
    db.prepare(
      `INSERT INTO accounts (id, name, type, parent_id) VALUES ('asset:b', 'B', 'asset', 'asset')`,
    ).run();
    return db;
  }

  function insertTransaction(
    db: Database.Database,
    over: Partial<{ id: string; debit: string; credit: string; amount: number }> = {},
  ) {
    return db
      .prepare(
        `INSERT INTO transactions (id, date, description, debit_account_id, credit_account_id, amount, currency)
         VALUES (?, '2026-01-01', 'x', ?, ?, ?, 'THB')`,
      )
      .run(over.id ?? "tx:1", over.debit ?? "asset:a", over.credit ?? "asset:b", over.amount ?? 100);
  }

  it("has the expected columns", () => {
    const db = seededDb();
    const cols = (db.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const c of [
      "id", "group_id", "date", "description", "merchant_id", "raw_descriptor",
      "source_file_id", "source_page", "debit_account_id", "credit_account_id",
      "amount", "currency", "code", "user_ref", "void_of", "has_question", "created_at",
    ]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });

  it("adds a transaction_id column to questions", () => {
    const db = seededDb();
    const cols = (db.prepare(`PRAGMA table_info(questions)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("transaction_id");
    // questions carries transaction_id, not transfer_id.
    expect(cols).not.toContain("transfer_id");
  });

  it("accepts a well-formed transaction", () => {
    const db = seededDb();
    expect(() => insertTransaction(db)).not.toThrow();
  });

  it("rejects amount <= 0 (CHECK)", () => {
    const db = seededDb();
    expect(() => insertTransaction(db, { amount: 0 })).toThrow();
    expect(() => insertTransaction(db, { amount: -100 })).toThrow();
  });

  it("rejects debit == credit (CHECK)", () => {
    const db = seededDb();
    expect(() => insertTransaction(db, { debit: "asset:a", credit: "asset:a" })).toThrow();
  });
});

describe("foreign DB guard (non-destructive)", () => {
  /** A version-0 database that is somebody else's: tables, rows, no ledger. */
  function foreignDb(): Database.Database {
    const db = freshDb();
    db.exec(`CREATE TABLE ledger_entries (id INTEGER PRIMARY KEY, memo TEXT NOT NULL)`);
    db.prepare(`INSERT INTO ledger_entries (memo) VALUES (?)`).run("not ours");
    return db;
  }

  it("refuses a version-0 database that already holds tables", () => {
    const db = foreignDb();
    expect(() => migrate(db)).toThrow(/not an OpenLedger database/i);
  });

  it("leaves the refused database exactly as it found it", () => {
    const db = foreignDb();
    expect(() => migrate(db)).toThrow();

    expect(tableNames(db)).toEqual(["ledger_entries"]);
    expect(rowCount(db, "ledger_entries")).toBe(1);
  });

  it("names the database file in the refusal", () => {
    const db = foreignDb();
    // The guard reads sqlite_master only, so the path never has to exist.
    expect(() => migrate(db, "/nowhere/oled.sqlite")).toThrow("/nowhere/oled.sqlite");
  });
});

describe("applyMigrations runner", () => {
  const m1: Migration = { up: (db) => db.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY)`) };
  const m2: Migration = { up: (db) => db.exec(`CREATE TABLE t2 (id INTEGER PRIMARY KEY)`) };

  it("applies every pending migration and records its version", () => {
    const db = freshDb();
    applyMigrations(db, [m1, m2]);
    expect(tableNames(db)).toEqual(expect.arrayContaining(["t1", "t2"]));
    expect(versions(db)).toEqual([1, 2]);
  });

  it("is a no-op once the DB is at the latest version", () => {
    const db = freshDb();
    applyMigrations(db, [m1, m2]);
    // m1/m2 use bare CREATE TABLE, so a re-apply would throw "table exists";
    // not throwing proves the fast path returned before running anything.
    expect(() => applyMigrations(db, [m1, m2])).not.toThrow();
    expect(versions(db)).toEqual([1, 2]);
  });

  it("throws when the DB version is newer than the build", () => {
    const db = freshDb();
    applyMigrations(db, [m1, m2]);
    expect(() => applyMigrations(db, [m1])).toThrow(/newer than this build/i);
  });

  it("refuses an on-disk DB that holds tables but no version ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "oled-migrate-"));
    try {
      const dbPath = join(dir, "db.sqlite");
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE preexisting (id INTEGER PRIMARY KEY)`);

      expect(() => applyMigrations(db, [m1, m2], dbPath)).toThrow(/not an OpenLedger database/i);

      // Refusal comes before any write, so there is nothing to back up.
      expect(backups(dir)).toEqual([]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backs up an on-disk DB before upgrading it to a newer version", () => {
    const dir = mkdtempSync(join(tmpdir(), "oled-migrate-"));
    try {
      const dbPath = join(dir, "db.sqlite");
      const db = new Database(dbPath);

      // An empty file at version 0 has nothing worth copying.
      applyMigrations(db, [m1], dbPath);
      db.prepare(`INSERT INTO t1 (id) VALUES (1)`).run();
      expect(backups(dir)).toEqual([]);

      applyMigrations(db, [m1, m2], dbPath);

      expect(backups(dir).length).toBe(1);
      expect(versions(db)).toEqual([1, 2]);
      expect(rowCount(db, "t1")).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
