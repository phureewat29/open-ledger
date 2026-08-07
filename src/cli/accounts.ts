import type Database from "libsql";
import { findAccountById, ledgerExists, listLedgerCurrencies, type AccountRow } from "../db/queries/accounts.js";
import { isLedgerScopedId } from "../lib/ids.js";
import { fail } from "./output.js";

// Ledgers are enumerated from the accounts table, never from config, so a bad prefix can't
// resolve against config state; the caller's own hint applies only once the id names a real ledger.
export function failAccountNotFound(db: Database.Database, id: string, hint?: string): never {
  if (isLedgerScopedId(id) && ledgerExists(db, id.slice(0, 3))) {
    fail("NOT_FOUND", `account "${id}" not found`, { hint });
  }
  const ledgers = listLedgerCurrencies(db);
  fail("NOT_FOUND", `account "${id}" not found`, {
    hint: ledgers.length
      ? `account ids start with a currency — existing ledgers: ${ledgers.join(", ")}`
      : "account ids start with a currency (e.g. thb:expense:food); no ledger exists yet, run `oled config --init`",
  });
}

export function requireAccount(db: Database.Database, id: string, hint?: string): AccountRow {
  const account = findAccountById(db, id);
  if (!account) failAccountNotFound(db, id, hint);
  return account;
}
