import Database from "libsql";
import { migrate } from "../src/db/schema.js";
import { createAccount, ensureLedgerRoot, isLedgerRootId } from "../src/accounts/accounts.js";
import { humanizeSegment } from "../src/accounts/resolve.js";
import type { AccountType, CreateAccountInput } from "../src/db/queries/accounts.js";
import { currencyOf, typeFromId } from "../src/lib/ids.js";

/** Foreign keys are ON: sqlite defaults them off, and the schema's cascades are what many of these tests assert. */
export function freshDb(seed?: (db: Database.Database) => void): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  seed?.(db);
  return db;
}

type SeedAccountInput = Partial<CreateAccountInput> & { id: string };

/**
 * Derives type, parent, and name from the id. Pass anything a test asserts
 * on directly. A refusal throws.
 */
export function seedAccount(db: Database.Database, account: SeedAccountInput): string {
  const segments = account.id.split(":");
  const type = account.type ?? (typeFromId(account.id) as AccountType);

  // A root's derived parent would be the bare currency, which is not an account.
  if (account.parent_id === undefined && isLedgerRootId(account.id)) {
    ensureLedgerRoot(db, currencyOf(account.id), type);
    return account.id;
  }

  const result = createAccount(db, {
    ...account,
    type,
    name: account.name ?? humanizeSegment(segments[segments.length - 1]),
    parent_id: account.parent_id ?? segments.slice(0, -1).join(":"),
  });
  if (!result.ok) throw new Error(`seedAccount("${account.id}"): ${result.message}`);
  return account.id;
}

/**
 * A database whose account INSERT fails for ids under `idPrefix`, simulating a
 * write failure (full disk, revoked handle) mid-walk. Every other statement
 * runs untouched.
 */
export function failingAccountInsert(
  db: Database.Database,
  idPrefix: string,
): Database.Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "prepare" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith("INSERT INTO accounts")) return statement;
        return {
          run: (...params: unknown[]) => {
            if (typeof params[0] === "string" && params[0].startsWith(idPrefix)) {
              throw new Error("disk I/O error");
            }
            return statement.run(...params);
          },
        };
      };
    },
  }) as Database.Database;
}
