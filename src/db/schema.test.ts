import { describe, it, expect } from "vitest";
import Database from "libsql";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, applyMigrations } from "./schema.js";
import { DBNotReadyError } from "./errors.js";
import * as baseline from "./migrations/0001_baseline.js";
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

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function rowCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

function backups(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.startsWith("db.sqlite.") && n.endsWith(".bak"));
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
}

/** Every table, index and trigger with the DDL sqlite would recreate it from; `schema_migrations` is left out (the runner's own ledger). */
function userSchema(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT type || ' ' || name || ' ' || COALESCE(sql, '') AS entry
           FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%' AND tbl_name <> 'schema_migrations'
          ORDER BY type, name`,
      )
      .all() as { entry: string }[]
  ).map((r) => r.entry);
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "oled-migrate-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("migrate", () => {
  it("creates the expected tables", () => {
    const db = freshDb();
    migrate(db);

    // The baseline is the whole schema and 0002 rebuilds it, so this is exhaustive.
    expect(tableNames(db).sort()).toEqual([
      "accounts",
      "files",
      "merchant_aliases",
      "merchants",
      "notes",
      "questions",
      "schema_migrations",
      "transactions",
    ]);
  });

  it("leaves a fresh database at the latest version", () => {
    const db = freshDb();
    migrate(db);

    expect(versions(db)).toEqual([1, 2]);
  });

  it("stamps schema_migrations.applied_at with the byte-identical ISO shape", () => {
    const db = freshDb();
    migrate(db);

    const rows = db.prepare(`SELECT applied_at FROM schema_migrations ORDER BY version`).all() as {
      applied_at: string;
    }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.applied_at).toMatch(ISO_TIMESTAMP_RE);
  });

  it("creates notes with a category CHECK and no default", () => {
    const db = freshDb();
    migrate(db);

    const insert = db.prepare(`INSERT INTO notes (content, category) VALUES (?, ?)`);
    for (const category of ["rule", "preference", "fact"]) {
      expect(() => insert.run(`a ${category}`, category)).not.toThrow();
    }
    expect(() => insert.run("a general note", "general")).toThrow();

    // Every write path supplies the category; an omitted one is a bug, not a row to be defaulted.
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

  it("records each applied version once and preserves data across re-migration", () => {
    const db = freshDb();
    migrate(db);
    db.prepare(
      `INSERT INTO accounts (id, name, type) VALUES ('thb:asset:a', 'A', 'asset'), ('thb:asset:b', 'B', 'asset')`,
    ).run();
    db.prepare(
      `INSERT INTO transactions (id, date, description, debit_account_id, credit_account_id, amount)
       VALUES ('tx:1', '2026-07-01', 'Coffee', 'thb:asset:a', 'thb:asset:b', 100)`,
    ).run();

    // A second migrate() takes the up-to-date fast path: no guard, no wipe.
    expect(() => migrate(db)).not.toThrow();

    expect(rowCount(db, "transactions")).toBe(1);
    expect(rowCount(db, "accounts")).toBe(2);
    expect(versions(db)).toEqual([1, 2]);
  });

  it("accepts hierarchical accounts via parent_id", () => {
    const db = freshDb();
    migrate(db);

    db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`)
      .run("thb:expense", "Expenses (THB)", "expense");
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("thb:expense:food", "Food", "expense", "thb:expense");
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("thb:expense:food:groceries", "Groceries", "expense", "thb:expense:food");

    const row = db
      .prepare(`SELECT parent_id FROM accounts WHERE id = ?`)
      .get("thb:expense:food:groceries") as { parent_id: string };
    expect(row.parent_id).toBe("thb:expense:food");
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
    db.prepare(`INSERT INTO accounts (id, name, type) VALUES ('thb:asset', 'Assets (THB)', 'asset')`).run();
    db.prepare(
      `INSERT INTO accounts (id, name, type, parent_id) VALUES ('thb:asset:a', 'A', 'asset', 'thb:asset')`,
    ).run();
    db.prepare(
      `INSERT INTO accounts (id, name, type, parent_id) VALUES ('thb:asset:b', 'B', 'asset', 'thb:asset')`,
    ).run();
    db.prepare(`INSERT INTO accounts (id, name, type) VALUES ('usd:asset', 'Assets (USD)', 'asset')`).run();
    db.prepare(
      `INSERT INTO accounts (id, name, type, parent_id) VALUES ('usd:asset:a', 'A', 'asset', 'usd:asset')`,
    ).run();
    return db;
  }

  function insertTransaction(
    db: Database.Database,
    over: Partial<{ id: string; debit: string; credit: string; amount: number; date: string }> = {},
  ) {
    return db
      .prepare(
        `INSERT INTO transactions (id, date, description, debit_account_id, credit_account_id, amount)
         VALUES (?, ?, 'x', ?, ?, ?)`,
      )
      .run(
        over.id ?? "tx:1",
        over.date ?? "2026-01-01",
        over.debit ?? "thb:asset:a",
        over.credit ?? "thb:asset:b",
        over.amount ?? 100,
      );
  }

  it("has the expected columns", () => {
    const db = seededDb();
    const cols = (db.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual([
      "id", "group_id", "date", "description", "merchant_id", "raw_descriptor",
      "source_file_id", "source_page", "debit_account_id", "credit_account_id",
      "amount", "void_of", "created_at",
    ]);
  });

  it("adds a transaction_id column to questions", () => {
    const db = seededDb();
    const cols = (db.prepare(`PRAGMA table_info(questions)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("transaction_id");
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
    expect(() => insertTransaction(db, { debit: "thb:asset:a", credit: "thb:asset:a" })).toThrow();
  });

  it("rejects a non-integer amount (INTEGER is only an affinity)", () => {
    const db = seededDb();
    expect(() => insertTransaction(db, { amount: 100.5 })).toThrow();
  });

  it("rejects an amount past the exact-JS-number ceiling", () => {
    const db = seededDb();
    expect(() => insertTransaction(db, { amount: 9007199254740992 })).toThrow();
  });

  it("rejects a date that is not YYYY-MM-DD (every filter compares lexicographically)", () => {
    const db = seededDb();
    for (const date of ["2026-1-01", "01/01/2026", "2026-01-01T00:00:00Z", "yesterday"]) {
      expect(() => insertTransaction(db, { date }), date).toThrow();
    }
  });

  it("rejects void_of pointing at the row itself", () => {
    const db = seededDb();
    insertTransaction(db);
    expect(() =>
      db.prepare(`UPDATE transactions SET void_of = id WHERE id = ?`).run("tx:1"),
    ).toThrow();
  });

  it("un-voids the mirrors of a deleted survivor (void_of self-FK)", () => {
    const db = seededDb();
    insertTransaction(db, { id: "tx:orig" });
    insertTransaction(db, { id: "tx:mirror" });
    db.prepare(`UPDATE transactions SET void_of = ? WHERE id = ?`).run("tx:orig", "tx:mirror");

    db.prepare(`DELETE FROM transactions WHERE id = ?`).run("tx:orig");

    const row = db.prepare(`SELECT void_of FROM transactions WHERE id = ?`).get("tx:mirror") as {
      void_of: string | null;
    };
    expect(row.void_of).toBeNull();
  });
});

describe("cross-ledger transactions are inexpressible", () => {
  function seededDb() {
    const db = freshDb();
    migrate(db);
    for (const [id, name, currency] of [
      ["thb:asset", "Assets (THB)", "thb"],
      ["usd:asset", "Assets (USD)", "usd"],
    ] as const) {
      db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, 'asset')`).run(id, name);
      db.prepare(
        `INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, 'asset', ?)`,
      ).run(`${currency}:asset:a`, "A", id);
      db.prepare(
        `INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, 'asset', ?)`,
      ).run(`${currency}:asset:b`, "B", id);
    }
    return db;
  }

  const insert = (db: Database.Database, id: string, debit: string, credit: string) =>
    db
      .prepare(
        `INSERT INTO transactions (id, date, description, debit_account_id, credit_account_id, amount)
         VALUES (?, '2026-01-01', 'x', ?, ?, 100)`,
      )
      .run(id, debit, credit);

  it("aborts an insert whose two accounts sit on different ledgers", () => {
    const db = seededDb();
    expect(() => insert(db, "tx:x", "thb:asset:a", "usd:asset:b")).toThrow(/cross-ledger/i);
  });

  it("aborts a recategorize that would move one side onto another ledger", () => {
    const db = seededDb();
    insert(db, "tx:x", "thb:asset:a", "thb:asset:b");
    expect(() =>
      db
        .prepare(`UPDATE transactions SET debit_account_id = ? WHERE id = ?`)
        .run("usd:asset:a", "tx:x"),
    ).toThrow(/cross-ledger/i);
  });
});

describe("account id CHECKs", () => {
  function migrated() {
    const db = freshDb();
    migrate(db);
    return db;
  }

  const insert = (db: Database.Database, id: string, type = "asset") =>
    db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, 'X', ?)`).run(id, type);

  it("requires a three-letter lowercase currency head", () => {
    const db = migrated();
    expect(() => insert(db, "asset")).toThrow();
    expect(() => insert(db, "th:asset")).toThrow();
    expect(() => insert(db, "THB:asset")).toThrow();
    expect(() => insert(db, "thb:asset")).not.toThrow();
  });

  it("requires the type in the second segment", () => {
    const db = migrated();
    expect(() => insert(db, "thb:bank:kbank")).toThrow();
    expect(() => insert(db, "thb:assets")).toThrow();
    expect(() => insert(db, "thb:asset:bank:kbank")).not.toThrow();
  });
});

describe("foreign DB guard (non-destructive)", () => {
  function foreignDb(): Database.Database {
    const db = freshDb();
    db.exec(`CREATE TABLE ledger_entries (id INTEGER PRIMARY KEY, memo TEXT NOT NULL)`);
    db.prepare(`INSERT INTO ledger_entries (memo) VALUES (?)`).run("not ours");
    return db;
  }

  it("refuses a version-0 database that already holds tables", () => {
    const db = foreignDb();
    expect(() => migrate(db)).toThrow(/not an OpenLedger database/i);
    // The type is what the CLI exits NOT_READY(3) on; the wording is free to change.
    expect(() => migrate(db)).toThrow(DBNotReadyError);
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

describe("version-1 databases are rebaselined, not adopted", () => {
  const TABLES = [
    "accounts",
    "files",
    "merchant_aliases",
    "merchants",
    "notes",
    "questions",
    "schema_migrations",
    "transactions",
  ];

  /**
   * The old schema shape, trimmed to what tells it apart from current:
   * unprefixed account ids, `currency`/`has_question` columns, and the
   * `settings` table.
   */
  function oldShapeDb(dbPath: string): Database.Database {
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        parent_id TEXT REFERENCES accounts(id),
        currency TEXT NOT NULL DEFAULT 'THB',
        has_question INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX accounts_parent_idx ON accounts(parent_id);

      CREATE TABLE merchants (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL UNIQUE,
        default_account_id TEXT REFERENCES accounts(id)
      );

      CREATE TABLE merchant_aliases (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        normalized_pattern TEXT NOT NULL UNIQUE
      );

      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        file_hash TEXT NOT NULL UNIQUE,
        mime TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        source_file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
        debit_account_id TEXT NOT NULL REFERENCES accounts(id),
        credit_account_id TEXT NOT NULL REFERENCES accounts(id),
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'THB',
        code TEXT,
        user_ref TEXT,
        void_of TEXT,
        has_question INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        answer TEXT,
        resolved_at TEXT
      );

      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        category TEXT NOT NULL
      );

      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version) VALUES (1);

      INSERT INTO accounts (id, name, type)
        VALUES ('expenses-food', 'Food', 'expense'), ('assets-kbank', 'KBank', 'asset');
      INSERT INTO merchants (id, canonical_name, default_account_id)
        VALUES ('m:cafe', 'Cafe', 'expenses-food');
      INSERT INTO transactions (id, date, description, debit_account_id, credit_account_id, amount)
        VALUES ('tx:1', '2026-01-01', 'Coffee', 'expenses-food', 'assets-kbank', 100);
      INSERT INTO settings (key, value) VALUES ('country', 'TH');
    `);
    return db;
  }

  it("carries an old-shape database to version 2 and drops what only it had", () => {
    withTempDir((dir) => {
      const dbPath = join(dir, "db.sqlite");
      const db = oldShapeDb(dbPath);

      migrate(db, dbPath);

      expect(versions(db)).toEqual([1, 2]);
      expect(tableNames(db).sort()).toEqual(TABLES);
      expect(columns(db, "transactions")).not.toContain("currency");
      expect(columns(db, "transactions")).not.toContain("has_question");
      expect(columns(db, "accounts")).not.toContain("currency");
      // Nothing of the old ledger is adopted: its ids can't satisfy the new CHECKs.
      expect(rowCount(db, "accounts")).toBe(0);
      expect(rowCount(db, "transactions")).toBe(0);
      db.close();
    });
  });

  it("leaves the rebaselined database identical to a fresh install", () => {
    withTempDir((dir) => {
      const dbPath = join(dir, "db.sqlite");
      const db = oldShapeDb(dbPath);
      migrate(db, dbPath);

      const fresh = freshDb();
      migrate(fresh);

      // Byte-for-byte the same tables, indexes and triggers, from the one authority.
      expect(userSchema(db)).toEqual(userSchema(fresh));
      expect(userSchema(db)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("trigger transactions_cross_ledger_insert"),
          expect.stringContaining("trigger transactions_cross_ledger_update"),
        ]),
      );
      db.close();
    });
  });

  it("backs the file up before dropping anything, so the old rows survive beside it", () => {
    withTempDir((dir) => {
      const dbPath = join(dir, "db.sqlite");
      const db = oldShapeDb(dbPath);

      migrate(db, dbPath);
      db.close();

      expect(backups(dir).length).toBe(1);

      // A backup taken after the drop would hold the new, empty shape instead.
      const saved = new Database(join(dir, backups(dir)[0]));
      expect(columns(saved, "transactions")).toContain("currency");
      expect(rowCount(saved, "transactions")).toBe(1);
      expect(
        (saved.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: string }[]).map(
          (r) => r.id,
        ),
      ).toEqual(["assets-kbank", "expenses-food"]);
      expect(rowCount(saved, "settings")).toBe(1);
      saved.close();
    });
  });

  it("rebaselines a version-1 database that already holds the current shape", () => {
    withTempDir((dir) => {
      const dbPath = join(dir, "db.sqlite");
      const db = new Database(dbPath);
      db.pragma("foreign_keys = ON");
      // Already the current shape, at the same version-1 stamp.
      baseline.up(db);
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_migrations (version) VALUES (1);
        INSERT INTO accounts (id, name, type) VALUES ('thb:asset:a', 'A', 'asset');
      `);

      migrate(db, dbPath);

      // Nothing at rest separates the two version-1 shapes, so neither is adopted.
      expect(versions(db)).toEqual([1, 2]);
      expect(rowCount(db, "accounts")).toBe(0);
      expect(backups(dir).length).toBe(1);
      db.close();
    });
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
    // Same "not usable by this build" condition as the foreign-db guard, so it shares the type and exits NOT_READY(3).
    expect(() => applyMigrations(db, [m1])).toThrow(DBNotReadyError);
  });

  it("refuses an on-disk DB that holds tables but no version ledger", () => {
    withTempDir((dir) => {
      const dbPath = join(dir, "db.sqlite");
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE preexisting (id INTEGER PRIMARY KEY)`);

      expect(() => applyMigrations(db, [m1, m2], dbPath)).toThrow(/not an OpenLedger database/i);

      // Refusal comes before any write, so there is nothing to back up.
      expect(backups(dir)).toEqual([]);
      db.close();
    });
  });

  it("backs up an on-disk DB before upgrading it to a newer version", () => {
    withTempDir((dir) => {
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
    });
  });
});
