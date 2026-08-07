import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { createAccount } from "../../accounts/accounts.js";
import { countAccounts, findAccountById, listLedgerCurrencies } from "../../db/queries/accounts.js";
import {
  createSandbox,
  makeRunCLI,
  parseOne,
  type CLIRunner,
  type Sandbox,
} from "../../../fixtures/sandbox.js";

let sandbox: Sandbox;
let runCLI: CLIRunner;
let dbPath: string;

beforeAll(() => {
  sandbox = createSandbox("oled-accounts-it-");
  runCLI = makeRunCLI(sandbox);
  dbPath = sandbox.dbPath;

  // Closed before the CLI runs so the subprocess owns the writer. Only the thb asset root is
  // seeded; every other ledger/type root must stay absent unless a create legitimately opens it.
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "thb:asset:cash", name: "Cash", type: "asset", parent_id: "thb:asset" });
  db.close();
});

afterAll(() => {
  sandbox.cleanup();
});

interface LedgerSnapshot {
  currencies: string[];
  accounts: number;
}

function snapshot(): LedgerSnapshot {
  const db = new Database(dbPath);
  try {
    return { currencies: listLedgerCurrencies(db), accounts: countAccounts(db) };
  } finally {
    db.close();
  }
}

describe("accounts create (subprocess)", () => {
  it("refuses a type its id contradicts without opening the ledger that id names", async () => {
    const before = snapshot();
    const res = await runCLI([
      "accounts", "create", "--id", "eur:asset:x", "--name", "X", "--type", "expense", "--json",
    ]);
    expect(res.code).toBe(6);

    const { error } = JSON.parse(res.stderr.trim());
    expect(error.code).toBe("E_INVALID");
    expect(error.message).toContain('must carry its type in the second segment: expected "eur:expense"');
    // The ancestor walk runs before the leaf is validated; a refusal must not leave
    // eur:asset behind for ingest to build a whole EUR tree onto.
    expect(snapshot()).toEqual(before);
  }, 30000);

  it("refuses a two-letter currency head with its own message, never the DDL's CHECK", async () => {
    const before = snapshot();
    const res = await runCLI([
      "accounts", "create", "--id", "th:asset:x", "--name", "X", "--type", "asset", "--json",
    ]);
    expect(res.code).toBe(6);

    const { error } = JSON.parse(res.stderr.trim());
    expect(error.message).toContain("must be lowercase <currency>:<type>");
    expect(error.message).not.toMatch(/CHECK constraint/);
    expect(snapshot()).toEqual(before);
  }, 30000);

  it("takes back the type root that a refused parent lookup opened", async () => {
    const before = snapshot();
    // thb:expense doesn't exist yet; the hierarchy check opens it before discovering the
    // types disagree, and one transaction rolls it back.
    const res = await runCLI([
      "accounts", "create", "--id", "thb:asset:x", "--name", "X",
      "--type", "asset", "--parent", "thb:expense", "--json",
    ]);
    expect(res.code).toBe(6);
    expect(JSON.parse(res.stderr.trim()).error.message).toContain("does not match parent");

    const db = new Database(dbPath);
    const orphanRoot = findAccountById(db, "thb:expense");
    db.close();
    expect(orphanRoot).toBeNull();
    expect(snapshot()).toEqual(before);
  }, 30000);

  it("still creates the missing ancestors of a good leaf", async () => {
    const res = await runCLI([
      "accounts", "create", "--id", "thb:asset:bank:ttb", "--name", "TTB", "--type", "asset", "--json",
    ]);
    expect(res.code).toBe(0);
    expect(parseOne(res.stdout)).toEqual({
      id: "thb:asset:bank:ttb",
      created: true,
      created_parents: ["thb:asset:bank"],
    });
  }, 30000);

  // The remaining two AccountFailure arms REASON_EXIT splits: a taken id is the caller's
  // to rename, a missing parent is one to create.
  it("refuses a taken id as INVALID (6), leaving the row that holds it", async () => {
    const res = await runCLI([
      "accounts", "create", "--id", "thb:asset:cash", "--name", "Second Cash", "--type", "asset", "--json",
    ]);
    expect(res.code).toBe(6);

    const { error } = JSON.parse(res.stderr.trim());
    expect(error.code).toBe("E_INVALID");
    expect(error.message).toBe('Account "thb:asset:cash" already exists.');

    const db = new Database(dbPath);
    const held = findAccountById(db, "thb:asset:cash");
    db.close();
    expect(held!.name).toBe("Cash");
  }, 30000);

  it("refuses a parent that does not exist as NOT_FOUND (5), writing nothing", async () => {
    const before = snapshot();
    const res = await runCLI([
      "accounts", "create", "--id", "thb:expense:food:nuts", "--name", "Nuts",
      "--type", "expense", "--parent", "thb:expense:snacks", "--json",
    ]);
    expect(res.code).toBe(5);

    const { error } = JSON.parse(res.stderr.trim());
    expect(error.code).toBe("E_NOT_FOUND");
    expect(error.message).toContain('Parent account "thb:expense:snacks" does not exist');
    expect(snapshot()).toEqual(before);
  }, 30000);
});
