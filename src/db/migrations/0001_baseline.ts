import type Database from "libsql";
import { ISO_NOW_SQL } from "../timestamps.js";

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('asset','liability','income','expense','equity')),
      parent_id TEXT REFERENCES accounts(id),
      subtype TEXT,
      bank_name TEXT,
      account_number_masked TEXT,
      due_day INTEGER,
      statement_day INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (${ISO_NOW_SQL}),
      -- Currency head only; full grammar lives in validateAccountId (src/accounts/accounts.ts).
      CHECK (id GLOB '[a-z][a-z][a-z]:*'),
      CHECK (id = lower(id)),
      -- substr(id,1,4) is every account's ledger: root = currency||':'||type, child extends it.
      CHECK (id = substr(id,1,4) || type OR substr(id,5,length(type)+1) = type || ':')
    );

    CREATE INDEX IF NOT EXISTS accounts_parent_idx ON accounts(parent_id);
    CREATE INDEX IF NOT EXISTS accounts_type_idx ON accounts(type);

    CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL UNIQUE,
      default_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (${ISO_NOW_SQL})
    );

    CREATE TABLE IF NOT EXISTS merchant_aliases (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      normalized_pattern TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (${ISO_NOW_SQL})
    );

    CREATE INDEX IF NOT EXISTS merchant_aliases_merchant_idx ON merchant_aliases(merchant_id);

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      file_hash TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','ingested','failed')),
      ingested_at TEXT,
      source TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (${ISO_NOW_SQL})
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id                TEXT PRIMARY KEY,
      group_id          TEXT,
      date              TEXT NOT NULL,
      description       TEXT NOT NULL,
      merchant_id       TEXT REFERENCES merchants(id),
      raw_descriptor    TEXT,
      source_file_id    TEXT REFERENCES files(id) ON DELETE CASCADE,
      source_page       INTEGER,
      debit_account_id  TEXT NOT NULL REFERENCES accounts(id),
      credit_account_id TEXT NOT NULL REFERENCES accounts(id),
      amount            INTEGER NOT NULL,
      -- ON DELETE SET NULL un-voids mirrors instead of leaving a dangling id that hides them from balance derivation.
      void_of           TEXT REFERENCES transactions(id) ON DELETE SET NULL,
      created_at        TEXT NOT NULL DEFAULT (${ISO_NOW_SQL}),
      -- INTEGER is an affinity, not a type: without this, 100.5 stores as-is.
      CHECK (typeof(amount) = 'integer'),
      CHECK (amount > 0),
      -- libsql hands an INTEGER back as a JS number.
      CHECK (amount <= 9007199254740991),
      -- Filters compare dates lexicographically; strftime('%Y-%m-%d',date) can't replace this GLOB since it returns NULL on garbage, and NULL passes a CHECK.
      CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      CHECK (debit_account_id <> credit_account_id),
      CHECK (void_of IS NULL OR void_of <> id)
    );

    CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(date);
    CREATE INDEX IF NOT EXISTS transactions_debit_account_idx ON transactions(debit_account_id);
    CREATE INDEX IF NOT EXISTS transactions_credit_account_idx ON transactions(credit_account_id);
    CREATE INDEX IF NOT EXISTS transactions_source_file_idx ON transactions(source_file_id);
    CREATE INDEX IF NOT EXISTS transactions_group_idx ON transactions(group_id);
    CREATE INDEX IF NOT EXISTS transactions_merchant_idx ON transactions(merchant_id);
    CREATE INDEX IF NOT EXISTS transactions_void_of_idx ON transactions(void_of);

    -- Positional substr(,1,4) compare, no join: sound since the accounts CHECKs fix the width and the FKs guarantee real accounts.
    CREATE TRIGGER IF NOT EXISTS transactions_cross_ledger_insert
    BEFORE INSERT ON transactions
    WHEN substr(NEW.debit_account_id,1,4) <> substr(NEW.credit_account_id,1,4)
    BEGIN
      SELECT RAISE(ABORT, 'cross-ledger transaction: debit and credit accounts must share a currency');
    END;

    CREATE TRIGGER IF NOT EXISTS transactions_cross_ledger_update
    BEFORE UPDATE OF debit_account_id, credit_account_id ON transactions
    WHEN substr(NEW.debit_account_id,1,4) <> substr(NEW.credit_account_id,1,4)
    BEGIN
      SELECT RAISE(ABORT, 'cross-ledger transaction: debit and credit accounts must share a currency');
    END;

    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      batch_id TEXT,
      file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
      transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT,
      prompt TEXT NOT NULL,
      options_json TEXT,
      context_json TEXT,
      deferred_until TEXT,
      created_at TEXT NOT NULL DEFAULT (${ISO_NOW_SQL})
    );

    CREATE INDEX IF NOT EXISTS questions_batch_idx ON questions(batch_id);
    CREATE INDEX IF NOT EXISTS questions_deferred_idx ON questions(deferred_until);
    CREATE INDEX IF NOT EXISTS questions_file_idx ON questions(file_id);
    CREATE INDEX IF NOT EXISTS questions_transaction_idx ON questions(transaction_id);
    CREATE INDEX IF NOT EXISTS questions_account_idx ON questions(account_id);

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('rule','preference','fact')),
      created_at TEXT NOT NULL DEFAULT (${ISO_NOW_SQL})
    );
  `);
}
