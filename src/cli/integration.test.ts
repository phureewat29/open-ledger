import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "libsql";
import { createSandbox, makeRunCLI, writeConf, type CLIRunner, type Sandbox } from "../../fixtures/sandbox.js";
import { buildProgram } from "./program.js";
import { migrate } from "../db/schema.js";
import { ensureLedgerRoot } from "../accounts/accounts.js";
import { insertTransaction } from "../db/queries/transactions.js";

let sandbox: Sandbox;
let runCLI: CLIRunner;

beforeAll(() => {
  sandbox = createSandbox("oled-it-");
  runCLI = makeRunCLI(sandbox);
  writeConf(sandbox, {});
});

afterAll(() => {
  sandbox.cleanup();
});

describe("cli integration (subprocess)", () => {
  it("a guarded command without confirmation exits non-zero with a JSON error on stderr", async () => {
    // requireYes fires before the id lookup, so the nonexistent id never matters.
    const { stdout, stderr, code } = await runCLI(["transactions", "delete", "tx:none", "--json"]);
    expect(code).not.toBe(0);
    expect(stdout.trim()).toBe("");
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe("E_INPUT_REQUIRED");
    expect(typeof parsed.error.message).toBe("string");
  }, 30000);

  it("no-arg runs the new status in plain mode with tab-separated lines, exit 0", async () => {
    const { stdout, code } = await runCLI([]);
    expect(code).toBe(0);
    expect(stdout).toContain("\t");
    expect(stdout).toMatch(/^configured\t/m);
    // Piped, so the human renderer must not colour: chalk sees no TTY.
    expect(/\x1b\[[0-9;]*m/.test(stdout)).toBe(false);
  }, 30000);

  // The screen is derived from the registered tree, so the tree is what it must show.
  it("--help renders every command in the help screen", async () => {
    const { stdout, code } = await runCLI(["--help"]);
    expect(code).toBe(0);
    for (const command of buildProgram().commands) expect(stdout).toContain(command.name());
  }, 30000);
});

// Three ledgers whose exponents disagree (THB 2, JPY 0, KWD 3), each with one posting.
function seedLedgers(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  migrate(db);
  const amounts: Record<string, number> = { thb: 13500, jpy: 1500, kwd: 1234 };
  for (const [currency, amount] of Object.entries(amounts)) {
    ensureLedgerRoot(db, currency, "asset");
    ensureLedgerRoot(db, currency, "expense");
    insertTransaction(db, {
      date: "2026-02-01",
      description: `${currency} posting`,
      debit_account_id: `${currency}:expense`,
      credit_account_id: `${currency}:asset`,
      amount,
    });
  }
  db.close();
}

function cell(stdout: string, rowPrefix: string, column: number): string | undefined {
  const line = stdout.split("\n").find((l) => l.startsWith(`${rowPrefix}\t`));
  return line?.split("\t")[column];
}

describe("money rendering across ledgers (subprocess)", () => {
  beforeAll(() => seedLedgers(sandbox.dbPath));

  it("gives every table cell its own ledger's digits, THB unchanged", async () => {
    const accounts = await runCLI(["accounts", "list"]);
    expect(accounts.code).toBe(0);
    // Piped, so the plain tab-separated renderer runs and `cell` can split on \t.
    // ID, Name, Type, Parent, Balance, Debits, Credits, Currency
    expect(cell(accounts.stdout, "thb:expense", 4)).toBe("135.00");
    expect(cell(accounts.stdout, "jpy:expense", 4)).toBe("1500");
    expect(cell(accounts.stdout, "kwd:expense", 4)).toBe("1.234");
    expect(cell(accounts.stdout, "kwd:expense", 5)).toBe("1.234");
    expect(cell(accounts.stdout, "jpy:asset", 6)).toBe("1500");

    const rows = await runCLI(["transactions", "list"]);
    expect(rows.code).toBe(0);
    // ID, Date, Description, Debit, Credit, Amount, Currency
    const amounts = rows.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"))
      .map((c) => [c[6], c[5]]);
    expect(amounts).toEqual(
      expect.arrayContaining([
        ["THB", "135.00"],
        ["JPY", "1500"],
        ["KWD", "1.234"],
      ]),
    );
  }, 60000);

  it("refuses --amount with no ledger to measure it in", async () => {
    const { code, stderr } = await runCLI(["transactions", "list", "--amount", "1500", "--json"]);
    expect(code).toBe(2);
    const { error } = JSON.parse(stderr.trim());
    expect(error.code).toBe("E_USAGE");
    expect(error.message).toContain("--amount needs a unit");
  }, 30000);

  it("takes the --amount unit from --account's prefix, then from --currency", async () => {
    const viaAccount = await runCLI([
      "transactions", "list", "--account", "jpy:expense", "--amount", "1500", "--json",
    ]);
    expect(viaAccount.code).toBe(0);
    expect(JSON.parse(viaAccount.stdout.trim().split("\n").pop()!).total).toBe(1);

    // Same 1500 read as THB is 150000 satang, which matches nothing.
    const viaCurrency = await runCLI([
      "transactions", "list", "--amount", "1500", "--currency", "THB", "--json",
    ]);
    expect(viaCurrency.code).toBe(0);
    expect(JSON.parse(viaCurrency.stdout.trim().split("\n").pop()!).total).toBe(0);
  }, 60000);
});
