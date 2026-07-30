import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSandbox,
  makeRunCli,
  parseNdjson,
  parseOne,
  type CliRunner,
  type Sandbox,
} from "../../../fixtures/sandbox.js";

let sandbox: Sandbox;
let runCli: CliRunner;

beforeAll(() => {
  sandbox = createSandbox("oled-ledger-it-");
  runCli = makeRunCli(sandbox);
});

afterAll(() => {
  sandbox.cleanup();
});

describe("transactions CLI integration (subprocess)", () => {
  it(
    "accounts create -> list -> tree round-trip includes rollup math with one recorded transaction",
    async () => {
      const bank = await runCli([
        "accounts",
        "create",
        "--id",
        "asset:bank",
        "--name",
        "Bank",
        "--type",
        "asset",
        "--parent",
        "asset",
        "--json",
      ]);
      expect(bank.code).toBe(0);
      expect(parseOne(bank.stdout)).toMatchObject({ id: "asset:bank", created: true });

      const groceries = await runCli([
        "accounts",
        "create",
        "--id",
        "expense:groceries",
        "--name",
        "Groceries",
        "--type",
        "expense",
        "--parent",
        "expense",
        "--json",
      ]);
      expect(groceries.code).toBe(0);
      expect(parseOne(groceries.stdout)).toMatchObject({
        id: "expense:groceries",
        created: true,
      });

      const rec = await runCli([
        "transactions",
        "add",
        "--date",
        "2026-01-01",
        "--description",
        "Grocery run",
        "--amount",
        "100",
        "--debit-account",
        "expense:groceries",
        "--credit-account",
        "asset:bank",
        "--json",
      ]);
      expect(rec.code).toBe(0);
      const recResult = parseOne(rec.stdout);
      expect(recResult.transaction_id).toMatch(/^tx:/);

      const list = await runCli(["accounts", "list", "--json"]);
      expect(list.code).toBe(0);
      const rows = parseNdjson(list.stdout);
      const bankRow = rows.find((r) => r.id === "asset:bank");
      const groceriesRow = rows.find((r) => r.id === "expense:groceries");
      expect(bankRow?.balance).toBe(-100);
      expect(groceriesRow?.balance).toBe(100);

      const tree = await runCli(["accounts", "tree", "--json"]);
      expect(tree.code).toBe(0);
      // One object per root, then the summary: the uniform NDJSON contract.
      const treeLines = parseNdjson(tree.stdout);
      const roots = treeLines.filter((r) => r.type !== "summary");
      expect(treeLines.find((r) => r.type === "summary")).toMatchObject({ roots: roots.length });
      const assetRoot = roots.find((r) => r.id === "asset");
      const expenseRoot = roots.find((r) => r.id === "expense");
      expect(assetRoot?.rollup).toBe(-100);
      expect(assetRoot?.children).toEqual([
        expect.objectContaining({ id: "asset:bank", balance: -100 }),
      ]);
      expect(expenseRoot?.rollup).toBe(100);
      expect(expenseRoot?.children).toEqual([
        expect.objectContaining({ id: "expense:groceries", balance: 100 }),
      ]);
    },
    60000,
  );

  it(
    "accounts show renders outside --json and never leaks libsql's _metadata into either mode",
    async () => {
      const json = await runCli(["accounts", "show", "asset:bank", "--json"]);
      expect(json.code).toBe(0);
      const shown = parseOne(json.stdout);
      expect(shown).toMatchObject({ id: "asset:bank", name: "Bank", type: "asset" });
      expect(shown).not.toHaveProperty("_metadata");

      const plain = await runCli(["accounts", "show", "asset:bank"]);
      expect(plain.code).toBe(0);
      expect(plain.stdout).toContain("id\tasset:bank");
      expect(plain.stdout).not.toContain("_metadata");
    },
    60000,
  );

  it(
    "transactions add strict mode: missing account fails NOT_FOUND (exit 5)",
    async () => {
      const result = await runCli([
        "transactions",
        "add",
        "--date",
        "2026-01-02",
        "--description",
        "Bad account",
        "--amount",
        "10",
        "--debit-account",
        "expense:does-not-exist",
        "--credit-account",
        "asset:bank",
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
      const result = await runCli([
        "transactions",
        "add",
        "--debit-account",
        "",
        "--credit-account",
        "asset:bank",
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
    "transactions add --resolve silently auto-creates a well-formed placeholder path (no question)",
    async () => {
      const result = await runCli([
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
        "expense:new-thing",
        "--credit-account",
        "asset:bank",
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
    "transactions recategorize round-trip re-points matching transactions",
    async () => {
      const food = await runCli([
        "accounts",
        "create",
        "--id",
        "expense:food",
        "--name",
        "Food",
        "--type",
        "expense",
        "--parent",
        "expense",
        "--json",
      ]);
      expect(food.code).toBe(0);

      const result = await runCli([
        "transactions",
        "recategorize",
        "--filter-account",
        "expense:groceries",
        "--set-account",
        "expense:food",
        "--json",
      ]);
      expect(result.code).toBe(0);
      const parsed = parseOne(result.stdout);
      expect(parsed.affected).toBe(1);
      expect(parsed.skipped_self_transaction).toBe(0);
      expect(parsed.sample_transaction_ids).toHaveLength(1);
    },
    45000,
  );

  it(
    "transactions show returns a transaction with amount rendered as a decimal",
    async () => {
      await runCli([
        "accounts", "create", "--id", "expense:coffee", "--name", "Coffee",
        "--type", "expense", "--parent", "expense", "--json",
      ]);

      const add = await runCli([
        "transactions", "add",
        "--debit-account", "expense:coffee",
        "--credit-account", "asset:bank",
        "--amount", "12.50",
        "--date", "2026-03-01",
        "--description", "flat white",
        "--json",
      ]);
      expect(add.code).toBe(0);
      const id = parseOne(add.stdout).transaction_id as string;
      expect(id).toMatch(/^tx:/);

      const show = await runCli(["transactions", "show", id, "--json"]);
      expect(show.code).toBe(0);
      const detail = parseOne(show.stdout);
      expect(detail).toMatchObject({
        id,
        description: "flat white",
        amount: 12.5,
        debit_account_id: "expense:coffee",
        credit_account_id: "asset:bank",
      });
    },
    45000,
  );

  it(
    "transactions dedupe groups same-amount / same-pair transactions",
    async () => {
      await runCli([
        "accounts", "create", "--id", "expense:tea", "--name", "Tea",
        "--type", "expense", "--parent", "expense", "--json",
      ]);

      const captured: string[] = [];
      for (const date of ["2026-04-01", "2026-04-02"]) {
        const add = await runCli([
          "transactions", "add",
          "--debit-account", "expense:tea",
          "--credit-account", "asset:bank",
          "--amount", "77",
          "--date", date,
          "--description", "matcha",
          "--json",
        ]);
        expect(add.code).toBe(0);
        captured.push(parseOne(add.stdout).transaction_id as string);
      }

      const dedupe = await runCli(["transactions", "dedupe", "--json"]);
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
      const upsert = await runCli([
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

      const resolve_ = await runCli([
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

      const setDefault = await runCli([
        "merchants",
        "set-default",
        "--merchant",
        merchant.id,
        "--account",
        "asset:bank",
        "--json",
      ]);
      expect(setDefault.code).toBe(0);
      const setDefaultResult = parseOne(setDefault.stdout);
      expect(setDefaultResult).toMatchObject({
        merchant_id: merchant.id,
        before: null,
        after: "asset:bank",
      });

      // merchants list announces its cap like every other list surface.
      const listed = parseNdjson((await runCli(["merchants", "list", "--json"])).stdout);
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
      const resolve_ = await runCli([
        "merchants",
        "resolve",
        "--descriptor",
        "Starbucks #789 Bangkok",
        "--json",
      ]);
      expect(resolve_.code).toBe(0);
      const merchant = { id: parseOne(resolve_.stdout).merchant_id };

      const cleared = await runCli([
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
        before: "asset:bank",
        after: null,
      });

      const neither = await runCli([
        "merchants",
        "set-default",
        "--merchant",
        merchant.id,
        "--json",
      ]);
      expect(neither.code).toBe(2); // EXIT.USAGE

      const both = await runCli([
        "merchants",
        "set-default",
        "--merchant",
        merchant.id,
        "--account",
        "asset:bank",
        "--clear",
        "--json",
      ]);
      expect(both.code).toBe(2); // EXIT.USAGE
    },
    45000,
  );

  it(
    "merchants update renames in place: transactions show flips, the raw name still resolves",
    async () => {
      const add = await runCli([
        "transactions", "add",
        "--debit-account", "expense:food",
        "--credit-account", "asset:bank",
        "--amount", "120",
        "--date", "2026-07-15",
        "--description", "Grab lunch run",
        "--merchant-name", "GRABPAY* JOHN DOE 123",
        "--json",
      ]);
      expect(add.code).toBe(0);
      const txId = parseOne(add.stdout).transaction_id as string;

      const before = parseOne((await runCli(["transactions", "show", txId, "--no-redact", "--json"])).stdout);
      expect(before.merchant_name).toBe("GRABPAY* JOHN DOE 123");
      const merchantId = before.merchant_id as string;

      const updated = await runCli([
        "merchants", "update", "--merchant", merchantId, "--name", "Grab", "--json",
      ]);
      expect(updated.code).toBe(0);
      expect(parseOne(updated.stdout)).toMatchObject({
        merchant_id: merchantId,
        before: "GRABPAY* JOHN DOE 123",
        after: "Grab",
      });

      // The display name is a live join, and the raw name survives as an alias.
      const after = parseOne((await runCli(["transactions", "show", txId, "--no-redact", "--json"])).stdout);
      expect(after.merchant_name).toBe("Grab");
      const resolved = parseOne(
        (await runCli(["merchants", "resolve", "--descriptor", "GRABPAY* JOHN DOE 123", "--json"])).stdout,
      );
      expect(resolved).toMatchObject({ found: true, merchant_id: merchantId });

      // Renaming onto a name another merchant holds is refused toward merge.
      const collision = await runCli([
        "merchants", "update", "--merchant", merchantId, "--name", "Starbucks", "--json",
      ]);
      expect(collision.code).toBe(6); // EXIT.INVALID
      expect(JSON.parse(collision.stderr.trim()).error.hint).toContain("merchants merge");
    },
    45000,
  );

  it(
    "accounts update: name only, metadata only, and none (USAGE)",
    async () => {
      const create = await runCli([
        "accounts",
        "create",
        "--id",
        "asset:wallet",
        "--name",
        "Wallet",
        "--type",
        "asset",
        "--parent",
        "asset",
        "--json",
      ]);
      expect(create.code).toBe(0);

      const nameOnly = await runCli([
        "accounts",
        "update",
        "asset:wallet",
        "--name",
        "Cash Wallet",
        "--json",
      ]);
      expect(nameOnly.code).toBe(0);
      expect(parseOne(nameOnly.stdout)).toMatchObject({
        id: "asset:wallet",
        name: "Cash Wallet",
        renamed: true,
      });

      const metadataOnly = await runCli([
        "accounts",
        "update",
        "asset:wallet",
        "--bank",
        "SCB",
        "--json",
      ]);
      expect(metadataOnly.code).toBe(0);
      const metaResult = parseOne(metadataOnly.stdout);
      expect(Object.keys(metaResult.after).length).toBeGreaterThan(0);
      expect(metaResult.after.bank_name).toBe("SCB");
      expect(metaResult.renamed).toBeUndefined();

      const none = await runCli(["accounts", "update", "asset:wallet", "--json"]);
      expect(none.code).toBe(2); // EXIT.USAGE
      expect(JSON.parse(none.stderr.trim()).error.code).toBe("E_USAGE");
    },
    45000,
  );

  it(
    "accounts create walks the ancestor chain: builds what is missing, reuses what exists, still type-checks the leaf",
    async () => {
      // "liability" is untouched by earlier tests in this file (shared db), so this chain is genuinely empty.
      const result = await runCli([
        "accounts",
        "create",
        "--id",
        "liability:credit_card:ttb",
        "--name",
        "TTB Credit Card",
        "--type",
        "liability",
        "--json",
      ]);
      expect(result.code).toBe(0);
      expect(parseOne(result.stdout)).toMatchObject({
        id: "liability:credit_card:ttb",
        created: true,
        created_parents: ["liability", "liability:credit_card"],
      });

      const list = await runCli(["accounts", "list", "--json"]);
      const rows = parseNdjson(list.stdout);
      expect(rows.find((r) => r.id === "liability")).toMatchObject({ type: "liability" });
      expect(rows.find((r) => r.id === "liability:credit_card")).toMatchObject({
        type: "liability",
        parent_id: "liability",
      });
      expect(rows.find((r) => r.id === "liability:credit_card:ttb")).toMatchObject({
        name: "TTB Credit Card",
        parent_id: "liability:credit_card",
      });

      const sibling = await runCli([
        "accounts", "create",
        "--id", "liability:credit_card:kbank",
        "--name", "KBank Credit Card",
        "--type", "liability",
        "--json",
      ]);
      expect(sibling.code).toBe(0);
      expect(parseOne(sibling.stdout)).toMatchObject({
        id: "liability:credit_card:kbank",
        created: true,
        created_parents: [],
      });

      // The ancestor walk skips the now-existing chain silently, so this mismatch is caught by createAccount's own parent/type check instead.
      const mismatch = await runCli([
        "accounts", "create",
        "--id", "liability:credit_card:mismatch",
        "--name", "Mismatch",
        "--type", "asset",
        "--json",
      ]);
      expect(mismatch.code).toBe(6); // EXIT.INVALID
      expect(mismatch.stdout.trim()).toBe("");
      expect(JSON.parse(mismatch.stderr.trim()).error.code).toBe("E_INVALID");
    },
    45000,
  );

  it(
    "accounts create --masked echoes the stored (normalized) masked number",
    async () => {
      // "equity" is untouched by every earlier test in this file (shared db).
      const result = await runCli([
        "accounts", "create",
        "--id", "equity:card",
        "--name", "Card",
        "--type", "equity",
        "--masked", "075-2-48870-0",
        "--json",
      ]);
      expect(result.code).toBe(0);
      expect(parseOne(result.stdout)).toMatchObject({
        id: "equity:card",
        created: true,
        account_number_masked: "••8870",
      });

      const unmasked = await runCli([
        "accounts", "create",
        "--id", "equity:plain",
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
        { id: "equity:batch-a", name: "Batch A", type: "equity", masked: "111-1-11111-1" },
        { id: "equity:batch-b", name: "Batch B", type: "equity" },
      ];
      writeFileSync(inputPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

      const first = await runCli(["accounts", "create", "--input", inputPath, "--json"]);
      expect(first.code).toBe(0);
      const firstObjs = parseNdjson(first.stdout);
      const firstResults = firstObjs.filter((o) => o.type === "result");
      expect(firstResults).toHaveLength(2);
      expect(firstResults[0]).toMatchObject({
        index: 0, ok: true, id: "equity:batch-a", created: true, account_number_masked: "••1111",
      });
      expect(Array.isArray(firstResults[0].created_parents)).toBe(true);
      expect(firstResults[1]).toMatchObject({
        index: 1, ok: true, id: "equity:batch-b", created: true, created_parents: [],
      });
      expect(firstObjs.find((o) => o.type === "summary")).toMatchObject({
        created: 2, duplicates: 0, failed: 0,
      });

      const second = await runCli(["accounts", "create", "--input", inputPath, "--json"]);
      expect(second.code).toBe(0);
      const secondObjs = parseNdjson(second.stdout);
      expect(secondObjs.filter((o) => o.type === "result")).toEqual([
        { type: "result", index: 0, ok: true, id: "equity:batch-a", duplicate: true },
        { type: "result", index: 1, ok: true, id: "equity:batch-b", duplicate: true },
      ]);
      expect(secondObjs.find((o) => o.type === "summary")).toMatchObject({
        created: 0, duplicates: 2, failed: 0,
      });

      const mixedPath = join(dir, "mixed.ndjson");
      writeFileSync(
        mixedPath,
        [
          JSON.stringify({ id: "equity:batch-c", type: "equity" }),
          JSON.stringify({ id: "equity:batch-d", name: "Batch D", type: "equity" }),
        ].join("\n") + "\n",
      );
      const mixed = await runCli(["accounts", "create", "--input", mixedPath, "--json"]);
      expect(mixed.code).toBe(7); // EXIT.PARTIAL
      const mixedObjs = parseNdjson(mixed.stdout);
      const mixedResults = mixedObjs.filter((o) => o.type === "result");
      expect(mixedResults[0]).toMatchObject({ index: 0, ok: false });
      expect(typeof mixedResults[0].message).toBe("string");
      expect(mixedResults[1]).toMatchObject({
        index: 1, ok: true, id: "equity:batch-d", created: true,
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
      writeFileSync(inputPath, JSON.stringify({ id: "equity:batch-e", name: "E", type: "equity" }) + "\n");

      const result = await runCli([
        "accounts", "create", "--input", inputPath, "--name", "Nope", "--json",
      ]);
      expect(result.code).toBe(2); // EXIT.USAGE
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
      // The redactor sources config.userName from OLED_DIR/config.json (no env var override).
      mkdirSync(join(sandbox.home, ".oled"), { recursive: true });
      writeFileSync(
        join(sandbox.home, ".oled", "config.json"),
        JSON.stringify({ userName }, null, 2) + "\n",
      );

      await runCli([
        "accounts", "create", "--id", "expense:travel", "--name", "Travel",
        "--type", "expense", "--parent", "expense", "--json",
      ]);

      const description = "Nutcha Wong card 4111 1111 1111 1111 purchase";
      const add = await runCli([
        "transactions", "add",
        "--debit-account", "expense:travel",
        "--credit-account", "asset:bank",
        "--amount", "50",
        "--date", "2026-05-01",
        "--description", description,
        "--json",
      ]);
      expect(add.code).toBe(0);

      const redacted = await runCli(["transactions", "list", "--account", "expense:travel", "--json"]);
      expect(redacted.code).toBe(0);
      const redactedRow = parseNdjson(redacted.stdout).find(
        (r) => r.debit_account_id === "expense:travel",
      );
      expect(redactedRow.description).toContain("[CARD]");
      expect(redactedRow.description).toContain("[USER]");
      expect(redactedRow.description).not.toContain("4111 1111 1111 1111");
      expect(redactedRow.description).not.toContain(userName);

      const verbatim = await runCli([
        "transactions", "list", "--account", "expense:travel", "--no-redact", "--json",
      ]);
      expect(verbatim.code).toBe(0);
      const verbatimRow = parseNdjson(verbatim.stdout).find(
        (r) => r.debit_account_id === "expense:travel",
      );
      expect(verbatimRow.description).toBe(description);
    },
    45000,
  );

  it(
    "transactions merge voids a mirror into its twin; re-merge is a no-op; guards reject non-mirrors and missing ids",
    async () => {
      await runCli([
        "accounts", "create", "--id", "expense:mirror", "--name", "Mirror",
        "--type", "expense", "--parent", "expense", "--json",
      ]);

      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const add = await runCli([
          "transactions", "add",
          "--debit-account", "expense:mirror",
          "--credit-account", "asset:bank",
          "--amount", "88",
          "--date", "2026-06-01",
          "--description", "cross-statement payment",
          "--json",
        ]);
        expect(add.code).toBe(0);
        ids.push(parseOne(add.stdout).transaction_id as string);
      }
      const [a, b] = ids;

      const found = await runCli([
        "transactions", "list", "--account", "expense:mirror", "--amount", "88", "--json",
      ]);
      expect(found.code).toBe(0);
      const foundSummary = parseNdjson(found.stdout).find((o) => o.type === "summary");
      expect(foundSummary.total).toBe(2);

      const merge = await runCli([
        "transactions", "merge", "--from", b, "--to", a, "--yes", "--json",
      ]);
      expect(merge.code).toBe(0);
      expect(parseOne(merge.stdout)).toEqual({ from: b, to: a, voided: true });

      const show = await runCli(["transactions", "show", b, "--json"]);
      expect(show.code).toBe(0);
      const shown = parseOne(show.stdout);
      expect(shown.void_of).toBe(a);

      const again = await runCli([
        "transactions", "merge", "--from", b, "--to", a, "--yes", "--json",
      ]);
      expect(again.code).toBe(0);
      expect(parseOne(again.stdout)).toEqual({ from: b, to: a, voided: false, already_void: true });

      const noYes = await runCli([
        "transactions", "merge", "--from", b, "--to", a, "--json",
      ]);
      expect(noYes.code).toBe(4); // EXIT.INPUT_REQUIRED

      const other = await runCli([
        "transactions", "add",
        "--debit-account", "expense:mirror",
        "--credit-account", "asset:bank",
        "--amount", "99",
        "--date", "2026-06-02",
        "--description", "not a mirror",
        "--json",
      ]);
      const otherId = parseOne(other.stdout).transaction_id as string;
      const mismatch = await runCli([
        "transactions", "merge", "--from", otherId, "--to", a, "--yes", "--json",
      ]);
      expect(mismatch.code).toBe(6); // EXIT.INVALID
      expect(JSON.parse(mismatch.stderr.trim()).error.code).toBe("E_INVALID");

      const missing = await runCli([
        "transactions", "merge", "--from", "tx:nope", "--to", a, "--yes", "--json",
      ]);
      expect(missing.code).toBe(5); // EXIT.NOT_FOUND
      expect(JSON.parse(missing.stderr.trim()).error.code).toBe("E_NOT_FOUND");
    },
    90000,
  );

  it(
    "transactions list --json emits a summary row with total/returned/has_more",
    async () => {
      await runCli([
        "accounts", "create", "--id", "expense:pagination", "--name", "Pagination",
        "--type", "expense", "--parent", "expense", "--json",
      ]);
      for (let i = 0; i < 3; i++) {
        const add = await runCli([
          "transactions", "add",
          "--debit-account", "expense:pagination",
          "--credit-account", "asset:bank",
          "--amount", String(10 + i),
          "--date", `2026-07-0${i + 1}`,
          "--description", `page row ${i}`,
          "--json",
        ]);
        expect(add.code).toBe(0);
      }

      const all = await runCli(["transactions", "list", "--account", "expense:pagination", "--json"]);
      expect(all.code).toBe(0);
      const allObjs = parseNdjson(all.stdout);
      const rows = allObjs.filter((o) => o.type !== "summary");
      const summary = allObjs.find((o) => o.type === "summary");
      expect(rows).toHaveLength(3);
      expect(summary).toMatchObject({ total: 3, returned: 3, has_more: false, limit: 50 });

      const capped = await runCli([
        "transactions", "list", "--account", "expense:pagination", "--limit", "1", "--json",
      ]);
      expect(capped.code).toBe(0);
      const cappedSummary = parseNdjson(capped.stdout).find((o) => o.type === "summary");
      expect(cappedSummary).toMatchObject({ total: 3, returned: 1, has_more: true, limit: 1, offset: 0 });

      // Paging: offset walks the stable (date DESC, id DESC) order to the tail,
      // and the pages never overlap.
      const pageOne = await runCli([
        "transactions", "list", "--account", "expense:pagination", "--limit", "2", "--json",
      ]);
      const pageTwo = await runCli([
        "transactions", "list", "--account", "expense:pagination", "--limit", "2", "--offset", "2", "--json",
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
