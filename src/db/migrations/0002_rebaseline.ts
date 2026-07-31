import type Database from "libsql";
import * as baseline from "./0001_baseline.js";

// Version 1 can mean either schema shape and the two can't be told apart, so
// this drops every user table and rebuilds from baseline; migrate() backs up first.
export function up(db: Database.Database): void {
  // defer_foreign_keys holds FK enforcement until COMMIT; the OFF pragma is a no-op inside a transaction.
  db.exec(`
    PRAGMA defer_foreign_keys = ON;

    DROP TABLE IF EXISTS questions;
    DROP TABLE IF EXISTS transactions;
    DROP TABLE IF EXISTS merchant_aliases;
    DROP TABLE IF EXISTS merchants;
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS accounts;
    DROP TABLE IF EXISTS notes;
    DROP TABLE IF EXISTS settings;
  `);

  baseline.up(db);
}
