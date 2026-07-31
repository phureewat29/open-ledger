import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import {
  countAccounts,
  findAccountById,
  listLedgerCurrencies,
} from "../db/queries/accounts.js";
import { ensureUncategorizedFallback, namesUnopenedLedger, resolveOnePosting } from "./resolve.js";
import { failingAccountInsert, freshDb, seedAccount } from "../../fixtures/db.js";

function seedThbLedger(db: Database.Database): void {
  seedAccount(db, { id: "thb:asset:cash" });
  seedAccount(db, { id: "thb:expense:food" });
}

describe("resolveOnePosting", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedThbLedger); });

  it("exact match: existing account, no hint", () => {
    expect(resolveOnePosting(db, "thb:expense:food")).toEqual({
      accountId: "thb:expense:food",
      hint: null,
    });
  });

  it("builds a missing path inside an existing ledger: placeholder_created", () => {
    expect(resolveOnePosting(db, "thb:expense:food:dining")).toEqual({
      accountId: "thb:expense:food:dining",
      hint: { type: "placeholder_created", accountId: "thb:expense:food:dining" },
    });
    const row = findAccountById(db, "thb:expense:food:dining")!;
    expect(row.parent_id).toBe("thb:expense:food");
    expect(row.name).toBe("Dining");
  });

  it("opens a missing type root of an existing ledger, with the ledger's own name", () => {
    const { hint } = resolveOnePosting(db, "thb:equity:opening");
    expect(hint).toEqual({
      type: "placeholder_created",
      accountId: "thb:equity:opening",
    });
    const root = findAccountById(db, "thb:equity")!;
    expect(root.name).toBe("Equity (THB)");
    expect(root.parent_id).toBeNull();
  });

  it("never opens a ledger: an unknown currency head resolves to nothing", () => {
    const before = countAccounts(db);
    // A one-character typo would otherwise manufacture a phantom ledger in silence.
    expect(resolveOnePosting(db, "zzz:expense:food")).toEqual({ accountId: null, hint: null });
    expect(resolveOnePosting(db, "thn:expense:food")).toEqual({ accountId: null, hint: null });
    expect(listLedgerCurrencies(db)).toEqual(["thb"]);
    expect(countAccounts(db)).toBe(before);
  });

  it("resolves nothing for an id with no currency head; the caller picks the ledger", () => {
    const before = countAccounts(db);
    expect(resolveOnePosting(db, "expense:food")).toEqual({ accountId: null, hint: null });
    expect(resolveOnePosting(db, "dining")).toEqual({ accountId: null, hint: null });
    expect(countAccounts(db)).toBe(before);
  });

  it("swallows a malformed segment mid-path and leaves no partial tree", () => {
    expect(resolveOnePosting(db, "thb:expense:_bad:leaf")).toEqual({ accountId: null, hint: null });
    expect(findAccountById(db, "thb:expense:_bad")).toBeNull();
    expect(findAccountById(db, "thb:expense:_bad:leaf")).toBeNull();
  });

  it("lets a broken write escape rather than reporting the id unresolvable", () => {
    // A broken database must not read as an unresolvable id, which books to uncategorized.
    const broken = failingAccountInsert(db, "thb:expense:food:dining");
    expect(() => resolveOnePosting(broken, "thb:expense:food:dining")).toThrow(/disk I\/O/);
    expect(findAccountById(db, "thb:expense:food:dining")).toBeNull();
  });

  it("swallows a lost create race: the winner's row stands and resolution still succeeds", () => {
    const raced = racingOnInsert(db, "thb:expense:snacks");
    expect(resolveOnePosting(raced, "thb:expense:snacks:nuts")).toEqual({
      accountId: "thb:expense:snacks:nuts",
      hint: { type: "placeholder_created", accountId: "thb:expense:snacks:nuts" },
    });
    expect(findAccountById(db, "thb:expense:snacks")!.name).toBe("Raced In");
    expect(findAccountById(db, "thb:expense:snacks:nuts")).toBeTruthy();
  });
});

describe("namesUnopenedLedger", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedThbLedger); });

  it("is true for any currency head naming a ledger this database never opened", () => {
    expect(namesUnopenedLedger(db, "usd:income:salary")).toBe(true);
    // A mistyped currency is indistinguishable from a real one with no ledger; refused the same way.
    expect(namesUnopenedLedger(db, "thn:expense:food")).toBe(true);
    // The head alone is the claim; a malformed tail or casing doesn't cancel it.
    expect(namesUnopenedLedger(db, "usd:kbank:savings")).toBe(true);
    expect(namesUnopenedLedger(db, "usd:food")).toBe(true);
    expect(namesUnopenedLedger(db, "USD:expense:food")).toBe(true);
  });

  it("is false for an existing ledger's head, and for hints with no currency claim", () => {
    expect(namesUnopenedLedger(db, "thb:expense:whatever")).toBe(false);
    // Own-ledger head with a malformed tail: falls back, never refused.
    expect(namesUnopenedLedger(db, "thb:food")).toBe(false);
    expect(namesUnopenedLedger(db, "expense:food")).toBe(false);
    expect(namesUnopenedLedger(db, "mysterycharge")).toBe(false);
  });
});

describe("resolveOnePosting lookalikes", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb((d) => {
      seedThbLedger(d);
      seedAccount(d, { id: "thb:asset:bank" });
      seedAccount(d, { id: "thb:asset:bank:ttb", name: "TTB Saving" });
      seedAccount(d, { id: "usd:asset:cash", name: "Dollar Cash" });
    });
  });

  it("reports a same-ledger lookalike without moving the posting", () => {
    seedAccount(db, { id: "usd:asset:bank", name: "Bank USD" });
    seedAccount(db, { id: "usd:asset:bank:ttb", name: "TTB Savings" });

    // The THB row's name is the closer match; the same-ledger filter excludes it.
    expect(resolveOnePosting(db, "usd:asset:bank:ttb-saving")).toEqual({
      accountId: "usd:asset:bank:ttb-saving",
      hint: {
        type: "similar_account",
        accountId: "usd:asset:bank:ttb-saving",
        similarId: "usd:asset:bank:ttb",
      },
    });
  });

  it("never suggests a lookalike from another ledger", () => {
    // The only near-name is in another ledger; proposing it would suggest a merge the ledgers forbid.
    expect(resolveOnePosting(db, "usd:asset:bank:ttb-saving")).toEqual({
      accountId: "usd:asset:bank:ttb-saving",
      hint: { type: "placeholder_created", accountId: "usd:asset:bank:ttb-saving" },
    });
  });

  it("never matches a leaf to its own ancestor", () => {
    // "kbank" scores 0.8 against its parent's name "Bank".
    expect(resolveOnePosting(db, "thb:asset:bank:kbank")).toEqual({
      accountId: "thb:asset:bank:kbank",
      hint: { type: "placeholder_created", accountId: "thb:asset:bank:kbank" },
    });
  });

  it("never matches across types", () => {
    seedAccount(db, { id: "thb:expense:transfers" });
    seedAccount(db, { id: "thb:expense:transfers:p2p", name: "P2p" });

    expect(resolveOnePosting(db, "thb:income:transfers:p2p")).toEqual({
      accountId: "thb:income:transfers:p2p",
      hint: { type: "placeholder_created", accountId: "thb:income:transfers:p2p" },
    });
  });
});

describe("ensureUncategorizedFallback", () => {
  it("returns the ledger's own uncategorized account, idempotently", () => {
    const db = freshDb(seedThbLedger);
    const id = ensureUncategorizedFallback(db, "thb");
    expect(id).toBe("thb:expense:uncategorized");
    expect(findAccountById(db, id)!.name).toBe("Uncategorized (THB)");
    expect(ensureUncategorizedFallback(db, "thb")).toBe(id);
  });

  it("keeps each ledger's fallback separate", () => {
    const db = freshDb(seedThbLedger);
    expect(ensureUncategorizedFallback(db, "usd")).toBe("usd:expense:uncategorized");
    expect(findAccountById(db, "usd:expense:uncategorized")!.name).toBe("Uncategorized (USD)");
  });
});

/** First insert of `racedId` loses to a concurrent writer claiming the same
 *  id: the only way to reach account_exists from a single-threaded test. */
function racingOnInsert(db: Database.Database, racedId: string): Database.Database {
  let raced = false;
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
            if (!raced && params[0] === racedId) {
              raced = true;
              target
                .prepare(
                  `INSERT INTO accounts (id, name, type, parent_id)
                   VALUES (?, 'Raced In', 'expense', 'thb:expense')`,
                )
                .run(racedId);
            }
            return statement.run(...params);
          },
        };
      };
    },
  }) as Database.Database;
}
