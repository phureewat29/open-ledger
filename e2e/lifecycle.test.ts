import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createSandbox,
  makeRunCLI,
  parseNdjson,
  parseOne,
  type CLIResult,
  type CLIRunner,
  type Sandbox,
} from "../fixtures/sandbox.js";
import { encryptedPdf, type PageKind } from "../fixtures/pdf.js";

let sandbox: Sandbox;
let runCLI: CLIRunner;

// Threaded by the steps below, in the order the steps run.
let statementPath = "";
let fileId = "";
let salaryId = "";
let groomingId = "";
let manualDupId = "";

// Its own sandbox, never shared with the read sweep: this file mutates the ledger from step one.
beforeAll(() => {
  sandbox = createSandbox("oled-e2e-lifecycle-");
  runCLI = makeRunCLI(sandbox, "dist");
});

afterAll(() => {
  sandbox.cleanup();
});

// One ledger, one chain: a mid-chain failure would cascade into unrelated steps.
// `it.skipIf` reads its condition at collection time, so it can't see this runtime flag.
let stepFailed = false;

beforeEach((ctx) => ctx.skip(stepFailed, "an earlier lifecycle step failed"));

afterEach((ctx) => {
  if (ctx.task.result?.state === "fail") stepFailed = true;
});

/** Appends `--json`: every step asserts the machine surface. */
function oled(args: string[], stdin?: string): Promise<CLIResult> {
  return runCLI([...args, "--json"], { stdin });
}

/** Exit 0 is the precondition of the next step, so it is asserted with the stderr that explains a failure. */
async function ok(args: string[], stdin?: string): Promise<CLIResult> {
  const result = await oled(args, stdin);
  expect(result.code, `oled ${args.join(" ")} failed: ${result.stderr}`).toBe(0);
  return result;
}

async function transactionCount(): Promise<number> {
  return parseOne((await ok(["status"])).stdout).counts.transactions;
}

/** Void-inclusive row total; `transactionCount` counts live rows only. */
async function allTransactionCount(): Promise<number> {
  const rows = parseNdjson((await ok(["transactions", "list", "--include-void"])).stdout);
  const summary = rows.find((row) => row.type === "summary");
  if (!summary) throw new Error("transactions list emitted no summary row");
  return summary.total as number;
}

function ndjson(items: Record<string, unknown>[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n");
}

// The staged statement: AES-256 password-protected, a real text layer on every page.
const FIXTURE_PAGES = 6;
const FIXTURE_PASSWORD = "password";

interface CommitSide {
  side: string;
  requested: string;
  resolved: string;
  how: string;
}

// Hand-crafted, not parsed from the fixture PDF (that only exercises discovery/prepare);
// returns fresh objects each call since the idempotency step re-pipes them verbatim.
function lifecycleItems(): Record<string, unknown>[] {
  return [
    {
      date: "2026-06-01",
      description: "Salary Deposit",
      debit_account: "thb:asset:bank:kasibank",
      credit_account: "thb:income:salary",
      amount: 45000.0,
      row_index: 0,
      source_page: 0,
    },
    {
      date: "2026-06-02",
      description: "Pet Paradise Dog Food",
      debit_account: "thb:expense:pet:food",
      credit_account: "thb:asset:bank:kasibank",
      amount: 1290.0,
      row_index: 1,
      source_page: 0,
      raw_descriptor: "PET PARADISE DOG FOOD",
      merchant: { canonical_name: "Pet Paradise", alias: "PET PARADISE DOG FOOD" },
    },
    {
      date: "2026-06-12",
      description: "Happy Paws Grooming",
      // Bare-leaf hint on purpose: colon paths auto-create silently, so this
      // exercises the uncategorized-fallback question.
      debit_account: "grooming",
      credit_account: "thb:asset:bank:kasibank",
      amount: 850.0,
      row_index: 2,
      source_page: 0,
    },
  ];
}

describe("lifecycle against a local ledger (dist subprocess)", () => {
  it(
    "config --init bootstraps the config, data dir and db every later step reads",
    async () => {
      const res = await ok([
        "config",
        "--init",
        "--data-dir",
        sandbox.dataDir,
        "--db",
        sandbox.dbPath,
        "--user-name",
        "Integration Tester",
        "--currency",
        "THB",
        "--locale",
        "th-TH",
      ]);
      expect(parseOne(res.stdout).created).toMatchObject({
        db: sandbox.dbPath,
        data_dir: sandbox.dataDir,
      });
    },
    20000,
  );

  it(
    "bare config reads back what --init persisted",
    async () => {
      const cfg = parseOne((await ok(["config"])).stdout);
      expect(cfg).toMatchObject({
        userName: "Integration Tester",
        displayCurrency: "THB",
        dbPath: sandbox.dbPath,
      });
    },
    20000,
  );

  it(
    "ingest list finds exactly the staged locked statement and reports it encrypted",
    async () => {
      // Staging is setup; `ingest list` finding the file is the assertion.
      statementPath = join(sandbox.dataDir, "corgi-bank", "card-statement-2026-05.pdf");
      mkdirSync(dirname(statementPath), { recursive: true });
      writeFileSync(
        statementPath,
        await encryptedPdf(FIXTURE_PASSWORD, Array<PageKind>(FIXTURE_PAGES).fill("text")),
      );

      const rows = parseNdjson((await ok(["ingest", "list"])).stdout).filter((r) => r.type === "file");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ encrypted: true, path: statementPath });
    },
    20000,
  );

  it(
    "ingest prepare extracts the locked statement's text layer with --password",
    async () => {
      const res = await ok(["ingest", "prepare", statementPath, "--password", FIXTURE_PASSWORD]);
      const result = parseOne(res.stdout);
      // page_count is pinned to the generated fixture, not to prepare's paging.
      expect(result).toMatchObject({ page_count: FIXTURE_PAGES, kind: "text" });
      expect(result.file_id).toMatch(/^sf-/);
      expect(result.document).toBe(join(sandbox.cacheDir, result.file_id, "document.txt"));
      expect(existsSync(result.document)).toBe(true);
      fileId = result.file_id;
    },
    60000,
  );

  it(
    "ingest commit posts three rows, links the dog-food merchant, and falls back on the bare-leaf hint",
    async () => {
      const objs = parseNdjson(
        (await ok(["ingest", "commit", "--file", fileId], ndjson(lifecycleItems()))).stdout,
      );
      const results = objs.filter((o) => o.type === "result");
      const summary = objs.find((o) => o.type === "summary");

      expect(results).toHaveLength(3);
      expect(
        results.filter((r) => !r.ok),
        "rows that failed to commit",
      ).toEqual([]);
      const [salary, dogfood, grooming] = results;

      const groomingDebit = (grooming.sides as CommitSide[]).find((s) => s.side === "debit");
      expect(groomingDebit, `grooming sides: ${JSON.stringify(grooming.sides)}`).toMatchObject({
        resolved: "thb:expense:uncategorized",
        how: "uncategorized_fallback",
      });

      expect(dogfood.merchant).toMatchObject({ how: "linked" });
      expect(typeof dogfood.merchant.merchant_id).toBe("string");

      expect(summary, "ingest commit must end with a summary row").toBeDefined();
      expect(summary).toMatchObject({ posted: 3, duplicates: 0, failed: 0 });
      expect(summary.raised_questions).toBeGreaterThan(0);

      salaryId = salary.transaction_id;
      groomingId = grooming.transaction_id;
    },
    30000,
  );

  it(
    "re-piping the same three rows is a no-op that reports the sides the stored rows hold",
    async () => {
      const objs = parseNdjson(
        (await ok(["ingest", "commit", "--file", fileId], ndjson(lifecycleItems()))).stdout,
      );
      const results = objs.filter((o) => o.type === "result");

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.duplicate)).toEqual([true, true, true]);
      expect(objs.find((o) => o.type === "summary")).toMatchObject({ duplicates: 3, posted: 0 });

      // A duplicate reports its stored sides, not a re-resolution of the input.
      const stale = results.flatMap((r) =>
        ((r.sides ?? []) as CommitSide[]).filter((s) => s.how !== "as_committed"),
      );
      expect(stale, "duplicate rows must report their committed sides").toEqual([]);

      expect(await transactionCount()).toBe(3);
    },
    30000,
  );

  it(
    "questions list surfaces the fallback question and answer closes it",
    async () => {
      // The trailing summary row is not a question; only real rows count.
      const rows = parseNdjson((await ok(["questions", "list"])).stdout).filter(
        (r) => r.type !== "summary",
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);

      const answered = parseNdjson(
        (await ok(["questions", "answer", rows[0].id, "--answer", "confirmed"])).stdout,
      );
      expect(answered).toEqual([expect.objectContaining({ id: rows[0].id })]);
    },
    30000,
  );

  it(
    "ingest done flips the file to ingested and purges its cache dir",
    async () => {
      const cacheSubdir = join(sandbox.cacheDir, fileId);
      const result = parseOne((await ok(["ingest", "done", fileId, "--agent", "integration"])).stdout);
      expect(result).toMatchObject({ status: "ingested", cache_removed: [cacheSubdir] });
      expect(existsSync(cacheSubdir)).toBe(false);

      const ingested = parseNdjson(
        (await ok(["files", "list", "--status", "ingested"])).stdout,
      ).filter((r) => r.type !== "summary");
      expect(ingested).toHaveLength(1);
    },
    30000,
  );

  it(
    "transactions update rewrites a description that transactions show then reflects",
    async () => {
      const updated = parseOne(
        (await ok(["transactions", "update", groomingId, "--description", "updated by integration"]))
          .stdout,
      );
      expect(updated).toMatchObject({ updated: true });

      const detail = parseOne((await ok(["transactions", "show", groomingId])).stdout);
      expect(detail).toMatchObject({ description: "updated by integration" });
    },
    30000,
  );

  // Auto-merge only matches rows carrying both a merchant_id and a source_file_id; a manual
  // add has neither, so its auto-merge coverage rides on a second file-sourced duplicate row.
  it(
    "transactions add creates a manual row, and dedupe --auto-merge collapses one file-sourced duplicate",
    async () => {
      const manual = parseOne(
        (
          await ok([
            "transactions",
            "add",
            "--debit-account",
            "thb:expense:pet:food",
            "--credit-account",
            "thb:asset:bank:kasibank",
            "--amount",
            "850",
            "--date",
            "2026-06-12",
            "--description",
            "dup for automerge",
          ])
        ).stdout,
      );
      expect(manual).toMatchObject({ duplicate: false });
      expect(manual.transaction_id).toMatch(/^tx:/);
      manualDupId = manual.transaction_id;

      const dup = {
        date: "2026-06-02",
        description: "Pet Paradise Dog Food (duplicate posting)",
        debit_account: "thb:expense:pet:food",
        credit_account: "thb:asset:bank:kasibank",
        amount: 1290.0,
        row_index: 101,
        source_page: 0,
        raw_descriptor: "PET PARADISE DOG FOOD",
        merchant: { canonical_name: "Pet Paradise", alias: "PET PARADISE DOG FOOD" },
      };
      const dupCommit = parseNdjson(
        (await ok(["ingest", "commit", "--file", fileId], JSON.stringify(dup))).stdout,
      );
      expect(dupCommit.find((o) => o.type === "result")).toMatchObject({ ok: true, duplicate: false });

      const before = await transactionCount();

      const merge = parseNdjson((await ok(["transactions", "dedupe", "--auto-merge"])).stdout);
      expect(merge.find((o) => o.type === "summary")).toMatchObject({ auto_merged: 1 });

      expect(await transactionCount()).toBe(before - 1);
    },
    45000,
  );

  it(
    "accounts adjust books the balancing transaction that lands the account on its closing balance",
    async () => {
      const adjust = parseOne(
        (
          await ok([
            "accounts",
            "adjust",
            "thb:asset:bank:kasibank",
            "--to",
            "50000",
            "--reason",
            "statement closing balance",
          ])
        ).stdout,
      );
      expect(adjust.transaction_id).toMatch(/^tx:/);

      const account = parseOne((await ok(["accounts", "show", "thb:asset:bank:kasibank"])).stdout);
      expect(account.balance).toBe(50000);

      // Every aggregate is a currency-keyed decimal map; this ledger has no liability
      // account, so that map has no keys.
      const status = parseOne((await ok(["status"])).stdout);
      expect(status.net_worth).toEqual({
        assets: { THB: 50000 },
        liabilities: {},
        net_worth: { THB: 50000 },
      });
    },
    30000,
  );

  it(
    "accounts create then merge folds an empty account away, and delete removes a fresh one",
    async () => {
      const create = parseOne(
        (
          await ok([
            "accounts",
            "create",
            "--id",
            "thb:expense:pet:treats",
            "--name",
            "Treats",
            "--type",
            "expense",
            "--parent",
            "thb:expense:pet",
          ])
        ).stdout,
      );
      expect(create).toMatchObject({ created: true });

      const merge = parseOne(
        (
          await ok([
            "accounts",
            "merge",
            "--from",
            "thb:expense:pet:treats",
            "--to",
            "thb:expense:pet:food",
            "--yes",
          ])
        ).stdout,
      );
      expect(typeof merge.moved).toBe("number");
      expect(merge).toMatchObject({ deleted_self_transactions: 0, moved_merchant_defaults: 0 });

      // mergeAccounts deletes the source account, so delete needs a fresh second one.
      await ok([
        "accounts",
        "create",
        "--id",
        "thb:expense:pet:toys",
        "--name",
        "Toys",
        "--type",
        "expense",
        "--parent",
        "thb:expense:pet",
      ]);
      expect(
        parseOne((await ok(["accounts", "delete", "thb:expense:pet:toys", "--yes"])).stdout),
      ).toMatchObject({ deleted: true });
    },
    45000,
  );

  it(
    "transactions delete drops exactly one row from the ledger",
    async () => {
      const before = await transactionCount();
      expect(
        parseOne((await ok(["transactions", "delete", salaryId, "--yes"])).stdout),
      ).toMatchObject({ deleted: true, unvoided: 0 });
      expect(await transactionCount()).toBe(before - 1);
    },
    30000,
  );

  it(
    "files drop removes exactly the rows files show counted, and the manual row ends up live",
    async () => {
      const detail = parseOne((await ok(["files", "show", fileId])).stdout);
      expect(typeof detail.transaction_count).toBe("number");
      const owned: number = detail.transaction_count;

      // Void-inclusive totals: which side of the auto-merge got voided is an id-tiebreak detail.
      const allBefore = await allTransactionCount();

      const drop = parseOne((await ok(["files", "drop", fileId, "--yes"])).stdout);
      expect(drop.removed_transactions, "files drop must remove what files show counted").toBe(owned);
      expect(typeof drop.unvoided, "files drop must report un-voided mirrors").toBe("number");
      expect(await allTransactionCount()).toBe(allBefore - owned);

      // The manual dup has no source_file_id, so the cascade spares it; whichever way the
      // auto-merge collapsed, it must be live afterwards, either as the surviving head or un-voided.
      const survivor = parseOne(
        (await ok(["transactions", "show", manualDupId])).stdout,
      );
      expect(survivor.void_of, `manual row ${manualDupId} must be live after the drop`).toBeNull();
    },
    45000,
  );

  it(
    "setup --dir installs one skill pack with its SKILL.md and VERSION",
    async () => {
      const skillBase = join(sandbox.root, "agent-skill");
      const result = parseOne((await ok(["setup", "--dir", skillBase])).stdout);
      const skillDir = join(skillBase, "openledger");
      expect(result.installed).toHaveLength(1);
      expect(result.installed[0]).toMatchObject({ path: skillDir });
      expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
      expect(existsSync(join(skillDir, "VERSION"))).toBe(true);
    },
    20000,
  );

  it(
    "status still answers after every mutation above",
    async () => {
      const status = parseOne((await ok(["status"])).stdout);
      expect(status.questions.open).toBeGreaterThanOrEqual(0);
    },
    20000,
  );
});
