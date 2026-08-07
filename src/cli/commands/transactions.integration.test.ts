import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSandbox,
  writeConfig,
  makeRunCLI,
  parseNdjson,
  parseOne,
  type CLIRunner,
  type Sandbox,
} from "../../../fixtures/sandbox.js";

let sandbox: Sandbox;
let runCLI: CLIRunner;

beforeAll(() => {
  sandbox = createSandbox("oled-ledger-it-");
  runCLI = makeRunCLI(sandbox);
  writeConfig(sandbox, {});
});

afterAll(() => {
  sandbox.cleanup();
});

describe("transactions CLI integration (subprocess)", () => {
  it(
    "accounts create -> list -> tree round-trip includes rollup math with one recorded transaction",
    async () => {
      const bank = await runCLI([
        "accounts",
        "create",
        "--id",
        "thb:asset:bank",
        "--name",
        "Bank",
        "--type",
        "asset",
        "--parent",
        "thb:asset",
        "--json",
      ]);
      expect(bank.code).toBe(0);
      expect(parseOne(bank.stdout)).toMatchObject({ id: "thb:asset:bank", created: true });

      const groceries = await runCLI([
        "accounts",
        "create",
        "--id",
        "thb:expense:groceries",
        "--name",
        "Groceries",
        "--type",
        "expense",
        "--parent",
        "thb:expense",
        "--json",
      ]);
      expect(groceries.code).toBe(0);
      expect(parseOne(groceries.stdout)).toMatchObject({
        id: "thb:expense:groceries",
        created: true,
      });

      const rec = await runCLI([
        "transactions",
        "add",
        "--date",
        "2026-01-01",
        "--description",
        "Grocery run",
        "--amount",
        "100",
        "--debit-account",
        "thb:expense:groceries",
        "--credit-account",
        "thb:asset:bank",
        "--json",
      ]);
      expect(rec.code).toBe(0);
      const recResult = parseOne(rec.stdout);
      expect(recResult.transaction_id).toMatch(/^tx:/);

      const list = await runCLI(["accounts", "list", "--json"]);
      expect(list.code).toBe(0);
      const rows = parseNdjson(list.stdout);
      const bankRow = rows.find((r) => r.id === "thb:asset:bank");
      const groceriesRow = rows.find((r) => r.id === "thb:expense:groceries");
      expect(bankRow?.balance).toBe(-100);
      expect(groceriesRow?.balance).toBe(100);

      const tree = await runCLI(["accounts", "tree", "--json"]);
      expect(tree.code).toBe(0);
      // One object per root, then the summary: the uniform NDJSON contract.
      const treeLines = parseNdjson(tree.stdout);
      const roots = treeLines.filter((r) => r.type !== "summary");
      expect(treeLines.find((r) => r.type === "summary")).toMatchObject({ roots: roots.length });
      // The whole node, key for key: rollup is a currency-keyed map beside the node's own `currency`.
      expect(roots.find((r) => r.id === "thb:asset")).toEqual({
        id: "thb:asset",
        name: "Assets (THB)",
        type: "asset",
        currency: "THB",
        balance: 0,
        rollup: { THB: -100 },
        children: [
          {
            id: "thb:asset:bank",
            name: "Bank",
            type: "asset",
            currency: "THB",
            balance: -100,
            rollup: { THB: -100 },
            children: [],
          },
        ],
      });
      expect(roots.find((r) => r.id === "thb:expense")).toEqual({
        id: "thb:expense",
        name: "Expenses (THB)",
        type: "expense",
        currency: "THB",
        balance: 0,
        rollup: { THB: 100 },
        children: [
          {
            id: "thb:expense:groceries",
            name: "Groceries",
            type: "expense",
            currency: "THB",
            balance: 100,
            rollup: { THB: 100 },
            children: [],
          },
        ],
      });
    },
    60000,
  );

  it(
    "accounts show renders outside --json and never leaks libsql's _metadata into either mode",
    async () => {
      const json = await runCLI(["accounts", "show", "thb:asset:bank", "--json"]);
      expect(json.code).toBe(0);
      const shown = parseOne(json.stdout);
      expect(shown).toMatchObject({ id: "thb:asset:bank", name: "Bank", type: "asset" });
      expect(shown).not.toHaveProperty("_metadata");

      const plain = await runCLI(["accounts", "show", "thb:asset:bank"]);
      expect(plain.code).toBe(0);
      expect(plain.stdout).toContain("id\tthb:asset:bank");
      expect(plain.stdout).not.toContain("_metadata");
    },
    60000,
  );

  it(
    "transactions add strict mode: missing account fails NOT_FOUND (exit 5)",
    async () => {
      const result = await runCLI([
        "transactions",
        "add",
        "--date",
        "2026-01-02",
        "--description",
        "Bad account",
        "--amount",
        "10",
        "--debit-account",
        "thb:expense:does-not-exist",
        "--credit-account",
        "thb:asset:bank",
        "--json",
      ]);
      expect(result.code).toBe(5);
      expect(result.stdout.trim()).toBe("");
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.error.code).toBe("E_NOT_FOUND");
    },
    30000,
  );

  it(
    "transactions add: an empty account flag fails USAGE (exit 2), not NOT_FOUND",
    async () => {
      const result = await runCLI([
        "transactions",
        "add",
        "--debit-account",
        "",
        "--credit-account",
        "thb:asset:bank",
        "--amount",
        "10",
        "--json",
      ]);
      expect(result.code).toBe(2);
      expect(result.stdout.trim()).toBe("");
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.error.code).toBe("E_USAGE");
      expect(parsed.error.message).toContain("cannot be empty");
    },
    30000,
  );

  it(
    "transactions add: an all-whitespace account flag is USAGE (2) on the strict and the --resolve path alike",
    async () => {
      // A blank-looking id is the flag not being passed; untrimmed, --resolve would
      // build an account literally named " ".
      for (const args of [["--json"], ["--resolve", "--json"]]) {
        const result = await runCLI([
          "transactions", "add",
          "--debit-account", "  ",
          "--credit-account", "thb:asset:bank",
          "--amount", "10",
          ...args,
        ]);
        expect(result.code, args.join(" ")).toBe(2);
        expect(result.stdout.trim()).toBe("");
        expect(JSON.parse(result.stderr.trim()).error.code).toBe("E_USAGE");
      }
    },
    45000,
  );

  it(
    "transactions add: an amount no minor units can hold is typed INVALID, and --resolve leaves no placeholder",
    async () => {
      // Its own accounts, so the case does not ride on another test's setup.
      for (const [id, type] of [
        ["thb:expense:absurd", "expense"],
        ["thb:asset:absurd-bank", "asset"],
      ]) {
        const created = await runCLI([
          "accounts", "create", "--id", id, "--name", "Absurd", "--type", type, "--json",
        ]);
        expect(created.code, id).toBe(0);
      }

      const strict = await runCLI([
        "transactions", "add",
        "--debit-account", "thb:expense:absurd",
        "--credit-account", "thb:asset:absurd-bank",
        "--amount", "1e30",
        "--json",
      ]);
      expect(strict.code).toBe(6);
      const strictErr = JSON.parse(strict.stderr.trim()).error;
      expect(strictErr.code).toBe("E_INVALID");
      // The pinned prose, never the DDL's own words.
      expect(strictErr.message).toMatch(/minor units/);
      expect(strictErr.message).not.toMatch(/CHECK|constraint/i);

      const resolved = await runCLI([
        "transactions", "add",
        "--resolve",
        "--debit-account", "thb:expense:absurd-amount-xyz",
        "--credit-account", "thb:asset:absurd-bank",
        "--amount", "1e30",
        "--json",
      ]);
      expect(resolved.code).toBe(6);
      expect(JSON.parse(resolved.stderr.trim()).error.code).toBe("E_INVALID");

      // Refused before resolution, so the placeholder tree was never built.
      const accounts = await runCLI(["accounts", "list", "--json"]);
      expect(accounts.stdout).not.toContain("thb:expense:absurd-amount-xyz");
    },
    45000,
  );

  it(
    "transactions add --resolve silently auto-creates a well-formed placeholder path (no question)",
    async () => {
      const result = await runCLI([
        "transactions",
        "add",
        "--resolve",
        "--date",
        "2026-01-03",
        "--description",
        "New category test",
        "--amount",
        "20",
        "--debit-account",
        "thb:expense:new-thing",
        "--credit-account",
        "thb:asset:bank",
        "--json",
      ]);
      expect(result.code).toBe(0);
      const parsed = parseOne(result.stdout);
      expect(parsed.transaction_id).toMatch(/^tx:/);
      expect(parsed.raised_questions).toBe(0);
    },
    30000,
  );

  it(
    "transactions add --resolve refuses an unopened ledger without the conversion-pair hint",
    async () => {
      const result = await runCLI([
        "transactions",
        "add",
        "--resolve",
        "--date",
        "2026-01-03",
        "--description",
        "Salary in a ledger nobody opened",
        "--amount",
        "1000",
        "--debit-account",
        "thb:asset:bank",
        "--credit-account",
        "eur:income:salary",
        "--json",
      ]);
      expect(result.code).toBe(6);
      const err = JSON.parse(result.stderr.trim()).error;
      expect(err.code).toBe("E_INVALID");
      expect(err.message).toContain('names ledger "eur"');
      // The repair is opening the ledger, not a conversion pair: no hint.
      expect(err.hint).toBeUndefined();
    },
    30000,
  );

  it(
    "transactions recategorize round-trip re-points matching transactions",
    async () => {
      const food = await runCLI([
        "accounts",
        "create",
        "--id",
        "thb:expense:food",
        "--name",
        "Food",
        "--type",
        "expense",
        "--parent",
        "thb:expense",
        "--json",
      ]);
      expect(food.code).toBe(0);

      const result = await runCLI([
        "transactions",
        "recategorize",
        "--filter-account",
        "thb:expense:groceries",
        "--set-account",
        "thb:expense:food",
        "--json",
      ]);
      expect(result.code).toBe(0);
      const parsed = parseOne(result.stdout);
      expect(parsed.affected).toBe(1);
      expect(parsed.skipped_self_transaction).toBe(0);
      expect(parsed.skipped_currency_mismatch).toBe(0);
      expect(parsed.sample_transaction_ids).toHaveLength(1);
    },
    45000,
  );

  it(
    "transactions recategorize: an empty account flag is USAGE (2), a missing target NOT_FOUND (5)",
    async () => {
      // An empty value is the flag not being passed, and must fail USAGE, not the
      // query layer's required-arg throw (INVALID).
      for (const args of [
        ["--filter-account", "", "--set-account", "thb:expense:food"],
        ["--filter-account", "thb:expense:food", "--set-account", ""],
      ]) {
        const empty = await runCLI(["transactions", "recategorize", ...args, "--json"]);
        expect(empty.code).toBe(2);
        const err = JSON.parse(empty.stderr.trim()).error;
        expect(err.code).toBe("E_USAGE");
        expect(err.message).toMatch(/required$/);
      }

      const missing = await runCLI([
        "transactions", "recategorize",
        "--filter-account", "thb:expense:food",
        "--set-account", "thb:expense:nowhere",
        "--json",
      ]);
      expect(missing.code).toBe(5);
      const err = JSON.parse(missing.stderr.trim()).error;
      expect(err.code).toBe("E_NOT_FOUND");
      expect(err.message).toMatch(/does not exist/);
    },
    45000,
  );

  it(
    "transactions show returns a transaction with amount rendered as a decimal",
    async () => {
      await runCLI([
        "accounts", "create", "--id", "thb:expense:coffee", "--name", "Coffee",
        "--type", "expense", "--parent", "thb:expense", "--json",
      ]);

      const add = await runCLI([
        "transactions", "add",
        "--debit-account", "thb:expense:coffee",
        "--credit-account", "thb:asset:bank",
        "--amount", "12.50",
        "--date", "2026-03-01",
        "--description", "flat white",
        "--json",
      ]);
      expect(add.code).toBe(0);
      const id = parseOne(add.stdout).transaction_id as string;
      expect(id).toMatch(/^tx:/);

      const show = await runCLI(["transactions", "show", id, "--json"]);
      expect(show.code).toBe(0);
      const detail = parseOne(show.stdout);
      expect(detail).toMatchObject({
        id,
        description: "flat white",
        amount: 12.5,
        debit_account_id: "thb:expense:coffee",
        credit_account_id: "thb:asset:bank",
      });
    },
    45000,
  );

  it(
    "transactions dedupe groups same-amount / same-pair transactions",
    async () => {
      await runCLI([
        "accounts", "create", "--id", "thb:expense:tea", "--name", "Tea",
        "--type", "expense", "--parent", "thb:expense", "--json",
      ]);

      const captured: string[] = [];
      for (const date of ["2026-04-01", "2026-04-02"]) {
        const add = await runCLI([
          "transactions", "add",
          "--debit-account", "thb:expense:tea",
          "--credit-account", "thb:asset:bank",
          "--amount", "77",
          "--date", date,
          "--description", "matcha",
          "--json",
        ]);
        expect(add.code).toBe(0);
        captured.push(parseOne(add.stdout).transaction_id as string);
      }

      const dedupe = await runCLI(["transactions", "dedupe", "--json"]);
      expect(dedupe.code).toBe(0);
      const objs = parseNdjson(dedupe.stdout);
      const summary = objs.find((o) => o.type === "summary");
      expect(summary.groups).toBeGreaterThanOrEqual(1);
      const dupIds = objs.filter((o) => o.type !== "summary").map((r) => r.id);
      for (const id of captured) expect(dupIds).toContain(id);
    },
    45000,
  );

  it(
    "merchants upsert -> resolve -> set-default round-trip",
    async () => {
      const upsert = await runCLI([
        "merchants",
        "upsert",
        "--name",
        "Starbucks",
        "--alias",
        "STARBUCKS #123 BKK",
        "--json",
      ]);
      expect(upsert.code).toBe(0);
      const merchant = parseOne(upsert.stdout);
      expect(merchant.canonical_name).toBe("Starbucks");
      expect(merchant.id).toMatch(/^m:/);

      const resolve_ = await runCLI([
        "merchants",
        "resolve",
        "--descriptor",
        "Starbucks #456 Bangkok Charge",
        "--json",
      ]);
      expect(resolve_.code).toBe(0);
      const resolved = parseOne(resolve_.stdout);
      expect(resolved.found).toBe(true);
      expect(resolved.merchant_id).toBe(merchant.id);

      const setDefault = await runCLI([
        "merchants",
        "set-default",
        "--merchant",
        merchant.id,
        "--account",
        "thb:asset:bank",
        "--json",
      ]);
      expect(setDefault.code).toBe(0);
      const setDefaultResult = parseOne(setDefault.stdout);
      expect(setDefaultResult).toMatchObject({
        merchant_id: merchant.id,
        before: null,
        after: "thb:asset:bank",
      });

      // merchants list announces its cap like every other list surface.
      const listed = parseNdjson((await runCLI(["merchants", "list", "--json"])).stdout);
      const summary = listed.find((r) => r.type === "summary");
      const rows = listed.filter((r) => r.type !== "summary");
      expect(summary).toMatchObject({ returned: rows.length, has_more: false, limit: 200 });
      expect(summary.total).toBeGreaterThanOrEqual(1);
    },
    45000,
  );

  it(
    "merchants set-default --clear removes the default account; exactly one of --account/--clear is required",
    async () => {
      // Relies on the merchant the round-trip test above created and defaulted to asset:bank.
      const resolve_ = await runCLI([
        "merchants",
        "resolve",
        "--descriptor",
        "Starbucks #789 Bangkok",
        "--json",
      ]);
      expect(resolve_.code).toBe(0);
      const merchant = { id: parseOne(resolve_.stdout).merchant_id };

      const cleared = await runCLI([
        "merchants",
        "set-default",
        "--merchant",
        merchant.id,
        "--clear",
        "--json",
      ]);
      expect(cleared.code).toBe(0);
      expect(parseOne(cleared.stdout)).toMatchObject({
        merchant_id: merchant.id,
        before: "thb:asset:bank",
        after: null,
      });

      const neither = await runCLI([
        "merchants",
        "set-default",
        "--merchant",
        merchant.id,
        "--json",
      ]);
      expect(neither.code).toBe(2); // EXIT.USAGE

      const both = await runCLI([
        "merchants",
        "set-default",
        "--merchant",
        merchant.id,
        "--account",
        "thb:asset:bank",
        "--clear",
        "--json",
      ]);
      expect(both.code).toBe(2);
    },
    45000,
  );

  it(
    "merchants update renames in place: transactions show flips, the raw name still resolves",
    async () => {
      const add = await runCLI([
        "transactions", "add",
        "--debit-account", "thb:expense:food",
        "--credit-account", "thb:asset:bank",
        "--amount", "120",
        "--date", "2026-07-15",
        "--description", "Grab lunch run",
        "--merchant-name", "GRABPAY* JOHN DOE 123",
        "--json",
      ]);
      expect(add.code).toBe(0);
      const txId = parseOne(add.stdout).transaction_id as string;

      const before = parseOne((await runCLI(["transactions", "show", txId, "--no-redact", "--json"])).stdout);
      expect(before.merchant_name).toBe("GRABPAY* JOHN DOE 123");
      const merchantId = before.merchant_id as string;

      const updated = await runCLI([
        "merchants", "update", "--merchant", merchantId, "--name", "Grab", "--json",
      ]);
      expect(updated.code).toBe(0);
      expect(parseOne(updated.stdout)).toMatchObject({
        merchant_id: merchantId,
        before: "GRABPAY* JOHN DOE 123",
        after: "Grab",
      });

      // The display name is a live join, and the raw name survives as an alias.
      const after = parseOne((await runCLI(["transactions", "show", txId, "--no-redact", "--json"])).stdout);
      expect(after.merchant_name).toBe("Grab");
      const resolved = parseOne(
        (await runCLI(["merchants", "resolve", "--descriptor", "GRABPAY* JOHN DOE 123", "--json"])).stdout,
      );
      expect(resolved).toMatchObject({ found: true, merchant_id: merchantId });

      // Renaming onto a name another merchant holds is refused toward merge.
      const collision = await runCLI([
        "merchants", "update", "--merchant", merchantId, "--name", "Starbucks", "--json",
      ]);
      expect(collision.code).toBe(6); // EXIT.INVALID
      expect(JSON.parse(collision.stderr.trim()).error.hint).toContain("merchants merge");
    },
    45000,
  );

  it(
    "merchants update --name refuses an all-whitespace name (USAGE), the same as upsert",
    async () => {
      const upserted = await runCLI([
        "merchants", "upsert", "--name", "Whitespace Guard", "--json",
      ]);
      expect(upserted.code).toBe(0);
      const merchantId = parseOne(upserted.stdout).id;

      const blank = await runCLI([
        "merchants", "update", "--merchant", merchantId, "--name", "   ", "--json",
      ]);
      expect(blank.code).toBe(2);
      expect(blank.stdout.trim()).toBe("");
      expect(JSON.parse(blank.stderr.trim()).error.code).toBe("E_USAGE");

      // The refusal is the flag's, not the merchant's; it precedes the lookup, so a bad
      // name never reads as a missing merchant.
      const missing = await runCLI([
        "merchants", "update", "--merchant", "mc:not-here", "--name", "  ", "--json",
      ]);
      expect(missing.code).toBe(2);

      const still = parseNdjson((await runCLI(["merchants", "list", "--json"])).stdout);
      expect(still.some((m) => m.canonical_name === "Whitespace Guard")).toBe(true);
    },
    45000,
  );

  it(
    "accounts update: name only, metadata only, and none (USAGE)",
    async () => {
      const create = await runCLI([
        "accounts",
        "create",
        "--id",
        "thb:asset:wallet",
        "--name",
        "Wallet",
        "--type",
        "asset",
        "--parent",
        "thb:asset",
        "--json",
      ]);
      expect(create.code).toBe(0);

      const nameOnly = await runCLI([
        "accounts",
        "update",
        "thb:asset:wallet",
        "--name",
        "Cash Wallet",
        "--json",
      ]);
      expect(nameOnly.code).toBe(0);
      expect(parseOne(nameOnly.stdout)).toMatchObject({
        id: "thb:asset:wallet",
        name: "Cash Wallet",
        renamed: true,
      });

      const metadataOnly = await runCLI([
        "accounts",
        "update",
        "thb:asset:wallet",
        "--bank",
        "SCB",
        "--json",
      ]);
      expect(metadataOnly.code).toBe(0);
      const metaResult = parseOne(metadataOnly.stdout);
      expect(Object.keys(metaResult.after).length).toBeGreaterThan(0);
      expect(metaResult.after.bank_name).toBe("SCB");
      expect(metaResult.renamed).toBeUndefined();

      const none = await runCLI(["accounts", "update", "thb:asset:wallet", "--json"]);
      expect(none.code).toBe(2);
      expect(JSON.parse(none.stderr.trim()).error.code).toBe("E_USAGE");
    },
    45000,
  );

  it(
    "accounts create walks the ancestor chain: builds what is missing, reuses what exists, still type-checks the leaf",
    async () => {
      // "thb:liability" is untouched by earlier tests in this file (shared db), so this chain is genuinely empty.
      const result = await runCLI([
        "accounts",
        "create",
        "--id",
        "thb:liability:credit_card:ttb",
        "--name",
        "TTB Credit Card",
        "--type",
        "liability",
        "--json",
      ]);
      expect(result.code).toBe(0);
      expect(parseOne(result.stdout)).toMatchObject({
        id: "thb:liability:credit_card:ttb",
        created: true,
        created_parents: ["thb:liability", "thb:liability:credit_card"],
      });

      const list = await runCLI(["accounts", "list", "--json"]);
      const rows = parseNdjson(list.stdout);
      expect(rows.find((r) => r.id === "thb:liability")).toMatchObject({ type: "liability" });
      expect(rows.find((r) => r.id === "thb:liability:credit_card")).toMatchObject({
        type: "liability",
        parent_id: "thb:liability",
      });
      expect(rows.find((r) => r.id === "thb:liability:credit_card:ttb")).toMatchObject({
        name: "TTB Credit Card",
        parent_id: "thb:liability:credit_card",
      });

      const sibling = await runCLI([
        "accounts", "create",
        "--id", "thb:liability:credit_card:kbank",
        "--name", "KBank Credit Card",
        "--type", "liability",
        "--json",
      ]);
      expect(sibling.code).toBe(0);
      expect(parseOne(sibling.stdout)).toMatchObject({
        id: "thb:liability:credit_card:kbank",
        created: true,
        created_parents: [],
      });

      // The ancestor walk skips the now-existing chain silently; createAccount's own
      // parent/type check catches this mismatch.
      const mismatch = await runCLI([
        "accounts", "create",
        "--id", "thb:liability:credit_card:mismatch",
        "--name", "Mismatch",
        "--type", "asset",
        "--json",
      ]);
      expect(mismatch.code).toBe(6);
      expect(mismatch.stdout.trim()).toBe("");
      expect(JSON.parse(mismatch.stderr.trim()).error.code).toBe("E_INVALID");
    },
    45000,
  );

  it(
    "accounts create --masked echoes the stored (normalized) masked number",
    async () => {
      // "thb:equity" is untouched by every earlier test in this file (shared db).
      const result = await runCLI([
        "accounts", "create",
        "--id", "thb:equity:card",
        "--name", "Card",
        "--type", "equity",
        "--masked", "075-2-48870-0",
        "--json",
      ]);
      expect(result.code).toBe(0);
      expect(parseOne(result.stdout)).toMatchObject({
        id: "thb:equity:card",
        created: true,
        account_number_masked: "••8870",
      });

      const unmasked = await runCLI([
        "accounts", "create",
        "--id", "thb:equity:plain",
        "--name", "Plain",
        "--type", "equity",
        "--json",
      ]);
      expect(unmasked.code).toBe(0);
      expect(parseOne(unmasked.stdout)).not.toHaveProperty("account_number_masked");
    },
    30000,
  );

  it(
    "accounts create --input batch-creates accounts, is idempotent on re-run, and PARTIALs on a malformed row",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "oled-accounts-input-"));
      const inputPath = join(dir, "accounts.ndjson");
      const rows = [
        { id: "thb:equity:batch-a", name: "Batch A", type: "equity", masked: "111-1-11111-1" },
        { id: "thb:equity:batch-b", name: "Batch B", type: "equity" },
      ];
      writeFileSync(inputPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

      const first = await runCLI(["accounts", "create", "--input", inputPath, "--json"]);
      expect(first.code).toBe(0);
      const firstObjs = parseNdjson(first.stdout);
      const firstResults = firstObjs.filter((o) => o.type === "result");
      expect(firstResults).toHaveLength(2);
      expect(firstResults[0]).toMatchObject({
        index: 0, ok: true, id: "thb:equity:batch-a", created: true, account_number_masked: "••1111",
      });
      expect(Array.isArray(firstResults[0].created_parents)).toBe(true);
      expect(firstResults[1]).toMatchObject({
        index: 1, ok: true, id: "thb:equity:batch-b", created: true, created_parents: [],
      });
      expect(firstObjs.find((o) => o.type === "summary")).toMatchObject({
        created: 2, duplicates: 0, failed: 0,
      });

      const second = await runCLI(["accounts", "create", "--input", inputPath, "--json"]);
      expect(second.code).toBe(0);
      const secondObjs = parseNdjson(second.stdout);
      expect(secondObjs.filter((o) => o.type === "result")).toEqual([
        { type: "result", index: 0, ok: true, id: "thb:equity:batch-a", duplicate: true },
        { type: "result", index: 1, ok: true, id: "thb:equity:batch-b", duplicate: true },
      ]);
      expect(secondObjs.find((o) => o.type === "summary")).toMatchObject({
        created: 0, duplicates: 2, failed: 0,
      });

      const mixedPath = join(dir, "mixed.ndjson");
      writeFileSync(
        mixedPath,
        [
          JSON.stringify({ id: "thb:equity:batch-c", type: "equity" }),
          JSON.stringify({ id: "thb:equity:batch-d", name: "Batch D", type: "equity" }),
        ].join("\n") + "\n",
      );
      const mixed = await runCLI(["accounts", "create", "--input", mixedPath, "--json"]);
      expect(mixed.code).toBe(7); // EXIT.PARTIAL
      const mixedObjs = parseNdjson(mixed.stdout);
      const mixedResults = mixedObjs.filter((o) => o.type === "result");
      expect(mixedResults[0]).toMatchObject({ index: 0, ok: false });
      expect(typeof mixedResults[0].message).toBe("string");
      expect(mixedResults[1]).toMatchObject({
        index: 1, ok: true, id: "thb:equity:batch-d", created: true,
      });
      expect(mixedObjs.find((o) => o.type === "summary")).toMatchObject({
        created: 1, duplicates: 0, failed: 1,
      });
    },
    45000,
  );

  it(
    "accounts create --input rejects per-account flags passed alongside it (USAGE)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "oled-accounts-input-usage-"));
      const inputPath = join(dir, "accounts.ndjson");
      writeFileSync(inputPath, JSON.stringify({ id: "thb:equity:batch-e", name: "E", type: "equity" }) + "\n");

      const result = await runCLI([
        "accounts", "create", "--input", inputPath, "--name", "Nope", "--json",
      ]);
      expect(result.code).toBe(2);
      expect(result.stdout.trim()).toBe("");
      const err = JSON.parse(result.stderr.trim());
      expect(err.error.code).toBe("E_USAGE");
      expect(err.error.message).toBe("--input and per-account flags are mutually exclusive");
    },
    30000,
  );

  it(
    "transactions list --json masks PII by default (card number + configured user name); --no-redact returns verbatim",
    async () => {
      const userName = "Nutcha Wong";
      // The redactor sources userName from the config file this invocation resolves.
      writeConfig(sandbox, { userName });

      await runCLI([
        "accounts", "create", "--id", "thb:expense:travel", "--name", "Travel",
        "--type", "expense", "--parent", "thb:expense", "--json",
      ]);

      const description = "Nutcha Wong card 4111 1111 1111 1111 purchase";
      const add = await runCLI([
        "transactions", "add",
        "--debit-account", "thb:expense:travel",
        "--credit-account", "thb:asset:bank",
        "--amount", "50",
        "--date", "2026-05-01",
        "--description", description,
        "--json",
      ]);
      expect(add.code).toBe(0);

      const redacted = await runCLI(["transactions", "list", "--account", "thb:expense:travel", "--json"]);
      expect(redacted.code).toBe(0);
      const redactedRow = parseNdjson(redacted.stdout).find(
        (r) => r.debit_account_id === "thb:expense:travel",
      );
      expect(redactedRow.description).toContain("[CARD]");
      expect(redactedRow.description).toContain("[USER]");
      expect(redactedRow.description).not.toContain("4111 1111 1111 1111");
      expect(redactedRow.description).not.toContain(userName);

      const verbatim = await runCLI([
        "transactions", "list", "--account", "thb:expense:travel", "--no-redact", "--json",
      ]);
      expect(verbatim.code).toBe(0);
      const verbatimRow = parseNdjson(verbatim.stdout).find(
        (r) => r.debit_account_id === "thb:expense:travel",
      );
      expect(verbatimRow.description).toBe(description);
    },
    45000,
  );

  it(
    "transactions merge voids a mirror into its twin; re-merge is a no-op; guards reject non-mirrors and missing ids",
    async () => {
      await runCLI([
        "accounts", "create", "--id", "thb:expense:mirror", "--name", "Mirror",
        "--type", "expense", "--parent", "thb:expense", "--json",
      ]);

      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const add = await runCLI([
          "transactions", "add",
          "--debit-account", "thb:expense:mirror",
          "--credit-account", "thb:asset:bank",
          "--amount", "88",
          "--date", "2026-06-01",
          "--description", "cross-statement payment",
          "--json",
        ]);
        expect(add.code).toBe(0);
        ids.push(parseOne(add.stdout).transaction_id as string);
      }
      const [a, b] = ids;

      const found = await runCLI([
        "transactions", "list", "--account", "thb:expense:mirror", "--amount", "88", "--json",
      ]);
      expect(found.code).toBe(0);
      const foundSummary = parseNdjson(found.stdout).find((o) => o.type === "summary");
      expect(foundSummary.total).toBe(2);

      const merge = await runCLI([
        "transactions", "merge", "--from", b, "--to", a, "--yes", "--json",
      ]);
      expect(merge.code).toBe(0);
      expect(parseOne(merge.stdout)).toEqual({ from: b, to: a, voided: true });

      const show = await runCLI(["transactions", "show", b, "--json"]);
      expect(show.code).toBe(0);
      const shown = parseOne(show.stdout);
      expect(shown.void_of).toBe(a);

      // Default listing hides the voided mirror so counts agree with balances;
      // --include-void opts back in.
      const relisted = await runCLI([
        "transactions", "list", "--account", "thb:expense:mirror", "--amount", "88", "--json",
      ]);
      expect(relisted.code).toBe(0);
      const relistedObjs = parseNdjson(relisted.stdout);
      expect(relistedObjs.filter((o) => o.type !== "summary").map((r) => r.id)).toEqual([a]);
      expect(relistedObjs.find((o) => o.type === "summary")).toMatchObject({ total: 1, returned: 1 });

      const relistedWithVoid = await runCLI([
        "transactions", "list", "--account", "thb:expense:mirror", "--amount", "88", "--include-void", "--json",
      ]);
      expect(relistedWithVoid.code).toBe(0);
      const relistedWithVoidObjs = parseNdjson(relistedWithVoid.stdout);
      expect(relistedWithVoidObjs.filter((o) => o.type !== "summary").map((r) => r.id).sort()).toEqual(
        [a, b].sort(),
      );
      expect(relistedWithVoidObjs.find((o) => o.type === "summary")).toMatchObject({ total: 2, returned: 2 });

      const again = await runCLI([
        "transactions", "merge", "--from", b, "--to", a, "--yes", "--json",
      ]);
      expect(again.code).toBe(0);
      expect(parseOne(again.stdout)).toEqual({ from: b, to: a, voided: false, already_void: true });

      const noYes = await runCLI([
        "transactions", "merge", "--from", b, "--to", a, "--json",
      ]);
      expect(noYes.code).toBe(4); // EXIT.INPUT_REQUIRED

      const other = await runCLI([
        "transactions", "add",
        "--debit-account", "thb:expense:mirror",
        "--credit-account", "thb:asset:bank",
        "--amount", "99",
        "--date", "2026-06-02",
        "--description", "not a mirror",
        "--json",
      ]);
      const otherId = parseOne(other.stdout).transaction_id as string;
      const mismatch = await runCLI([
        "transactions", "merge", "--from", otherId, "--to", a, "--yes", "--json",
      ]);
      expect(mismatch.code).toBe(6);
      expect(JSON.parse(mismatch.stderr.trim()).error.code).toBe("E_INVALID");

      const missing = await runCLI([
        "transactions", "merge", "--from", "tx:nope", "--to", a, "--yes", "--json",
      ]);
      expect(missing.code).toBe(5);
      expect(JSON.parse(missing.stderr.trim()).error.code).toBe("E_NOT_FOUND");
    },
    90000,
  );

  it(
    "transactions list --currency scopes the ledger, and --account wins when both are passed",
    async () => {
      for (const [id, type] of [
        ["jpy:expense:food", "expense"],
        ["jpy:asset:cash", "asset"],
        ["thb:expense:yen-twin", "expense"],
      ]) {
        const created = await runCLI([
          "accounts", "create", "--id", id, "--name", "Twin", "--type", type, "--json",
        ]);
        expect(created.code, id).toBe(0);
      }

      // 1500 yen and 15.00 baht are the same raw amount; --currency scopes an
      // amount filter to one ledger's unit.
      const yen = await runCLI([
        "transactions", "add",
        "--debit-account", "jpy:expense:food",
        "--credit-account", "jpy:asset:cash",
        "--amount", "1500",
        "--date", "2026-06-01",
        "--description", "Yen lunch",
        "--json",
      ]);
      expect(yen.code).toBe(0);
      const baht = await runCLI([
        "transactions", "add",
        "--debit-account", "thb:expense:yen-twin",
        "--credit-account", "thb:asset:bank",
        "--amount", "15",
        "--date", "2026-06-01",
        "--description", "Baht lunch",
        "--json",
      ]);
      expect(baht.code).toBe(0);

      const scoped = await runCLI([
        "transactions", "list", "--amount", "1500", "--currency", "jpy", "--json",
      ]);
      expect(scoped.code).toBe(0);
      const scopedObjs = parseNdjson(scoped.stdout);
      const scopedRows = scopedObjs.filter((o) => o.type !== "summary");
      expect(scopedRows.map((r) => r.id)).toEqual([parseOne(yen.stdout).transaction_id]);
      expect(scopedObjs.find((o) => o.type === "summary")).toMatchObject({ total: 1, returned: 1 });

      // Without an amount, --currency still narrows the listing to one ledger; the
      // summary's total uses the same filter.
      const thbOnly = await runCLI(["transactions", "list", "--currency", "thb", "--json"]);
      expect(thbOnly.code).toBe(0);
      const thbObjs = parseNdjson(thbOnly.stdout);
      const thbRows = thbObjs.filter((o) => o.type !== "summary");
      expect(thbRows.length).toBeGreaterThan(0);
      expect(new Set(thbRows.map((r) => r.currency))).toEqual(new Set(["THB"]));
      expect(thbObjs.find((o) => o.type === "summary")).toMatchObject({ total: thbRows.length });

      // --account names a ledger of its own, and a contradicting code cannot
      // narrow its rows away.
      const both = await runCLI([
        "transactions", "list", "--account", "jpy:expense:food", "--currency", "thb", "--json",
      ]);
      expect(both.code).toBe(0);
      const bothRows = parseNdjson(both.stdout).filter((o) => o.type !== "summary");
      expect(bothRows.map((r) => r.currency)).toEqual(["JPY"]);
    },
    90000,
  );

  it(
    "transactions list --json emits a summary row with total/returned/has_more",
    async () => {
      await runCLI([
        "accounts", "create", "--id", "thb:expense:pagination", "--name", "Pagination",
        "--type", "expense", "--parent", "thb:expense", "--json",
      ]);
      for (let i = 0; i < 3; i++) {
        const add = await runCLI([
          "transactions", "add",
          "--debit-account", "thb:expense:pagination",
          "--credit-account", "thb:asset:bank",
          "--amount", String(10 + i),
          "--date", `2026-07-0${i + 1}`,
          "--description", `page row ${i}`,
          "--json",
        ]);
        expect(add.code).toBe(0);
      }

      const all = await runCLI(["transactions", "list", "--account", "thb:expense:pagination", "--json"]);
      expect(all.code).toBe(0);
      const allObjs = parseNdjson(all.stdout);
      const rows = allObjs.filter((o) => o.type !== "summary");
      const summary = allObjs.find((o) => o.type === "summary");
      expect(rows).toHaveLength(3);
      expect(summary).toMatchObject({ total: 3, returned: 3, has_more: false, limit: 50 });

      const capped = await runCLI([
        "transactions", "list", "--account", "thb:expense:pagination", "--limit", "1", "--json",
      ]);
      expect(capped.code).toBe(0);
      const cappedSummary = parseNdjson(capped.stdout).find((o) => o.type === "summary");
      expect(cappedSummary).toMatchObject({ total: 3, returned: 1, has_more: true, limit: 1, offset: 0 });

      // offset walks the stable (date DESC, id DESC) order to the tail; pages never overlap.
      const pageOne = await runCLI([
        "transactions", "list", "--account", "thb:expense:pagination", "--limit", "2", "--json",
      ]);
      const pageTwo = await runCLI([
        "transactions", "list", "--account", "thb:expense:pagination", "--limit", "2", "--offset", "2", "--json",
      ]);
      const oneObjs = parseNdjson(pageOne.stdout);
      const twoObjs = parseNdjson(pageTwo.stdout);
      const oneIds = oneObjs.filter((o) => o.type !== "summary").map((o) => o.id);
      const twoIds = twoObjs.filter((o) => o.type !== "summary").map((o) => o.id);
      expect(oneIds).toHaveLength(2);
      expect(twoIds).toHaveLength(1);
      expect(oneObjs.find((o) => o.type === "summary")).toMatchObject({
        total: 3, returned: 2, has_more: true, limit: 2, offset: 0,
      });
      expect(twoObjs.find((o) => o.type === "summary")).toMatchObject({
        total: 3, returned: 1, has_more: false, limit: 2, offset: 2,
      });
      expect(new Set([...oneIds, ...twoIds]).size).toBe(3);
    },
    90000,
  );
});
