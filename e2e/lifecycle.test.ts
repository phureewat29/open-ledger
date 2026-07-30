import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createSandbox,
  makeRunCli,
  parseNdjson,
  parseOne,
  repoRoot,
  type CliResult,
  type CliRunner,
  type Sandbox,
} from "../fixtures/sandbox.js";

let sandbox: Sandbox;
let runCli: CliRunner;

// Threaded by the steps below, in the order the steps run.
let statementPath = "";
let fileId = "";
let salaryId = "";
let groomingId = "";
let manualDupId = "";

/**
 * Its own sandbox, never shared with the read sweep: this file mutates the
 * ledger from the first step onwards, and the sweep must not see those rows.
 */
beforeAll(() => {
  sandbox = createSandbox("oled-e2e-lifecycle-");
  runCli = makeRunCli(sandbox, "dist");
});

afterAll(() => {
  sandbox.cleanup();
});

/**
 * One ledger, one chain: a mid-chain failure would cascade into unrelated steps.
 * `it.skipIf` reads its condition at collection time and so cannot see this flag;
 * this runtime guard is what the script's `break` did.
 */
let stepFailed = false;

beforeEach((ctx) => ctx.skip(stepFailed, "an earlier lifecycle step failed"));

afterEach((ctx) => {
  if (ctx.task.result?.state === "fail") stepFailed = true;
});

/** Every step asserts the machine surface, so `--json` is appended here rather than in 40 argument arrays. */
function oled(args: string[], stdin?: string): Promise<CliResult> {
  return runCli([...args, "--json"], { stdin });
}

/** Exit 0 is the precondition of the next step, so it is asserted with the stderr that explains a failure. */
async function ok(args: string[], stdin?: string): Promise<CliResult> {
  const result = await oled(args, stdin);
  expect(result.code, `oled ${args.join(" ")} failed: ${result.stderr}`).toBe(0);
  return result;
}

/** The before/after quantity most steps below compare. */
async function transactionCount(): Promise<number> {
  return parseOne((await ok(["status"])).stdout).counts.transactions;
}

function ndjson(items: Record<string, unknown>[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n");
}

/** AES-256 password-protected, 6 pages with a real text layer; shared with the corgi-claude demo. */
const FIXTURE_STATEMENT = join(
  repoRoot,
  "examples",
  "corgi-claude",
  "fixtures",
  "card-statement-2026-05.pdf",
);
const FIXTURE_PASSWORD = "password";

interface CommitSide {
  side: string;
  requested: string;
  resolved: string;
  how: string;
}

/** Hand-crafted, not parsed from the fixture PDF (which only exercises
 *  discovery/prepare); re-piped verbatim by the idempotency step, so this hands
 *  back fresh objects rather than sharing one array. */
function lifecycleItems(): Record<string, unknown>[] {
  return [
    {
      date: "2026-06-01",
      description: "Salary Deposit",
      debit_account: "asset:bank:kasibank",
      credit_account: "income:salary",
      amount: 45000.0,
      row_index: 0,
      source_page: 0,
    },
    {
      date: "2026-06-02",
      description: "Pet Paradise Dog Food",
      debit_account: "expense:pet:food",
      credit_account: "asset:bank:kasibank",
      amount: 1290.0,
      row_index: 1,
      source_page: 0,
      raw_descriptor: "PET PARADISE DOG FOOD",
      merchant: { canonical_name: "Pet Paradise", alias: "PET PARADISE DOG FOOD" },
    },
    {
      date: "2026-06-12",
      description: "Happy Paws Grooming",
      // Bare-leaf hint on purpose — colon paths auto-create silently; this
      // row exercises the uncategorized-fallback question.
      debit_account: "grooming",
      credit_account: "asset:bank:kasibank",
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
    "config show reads back what --init persisted",
    async () => {
      const cfg = parseOne((await ok(["config", "show"])).stdout);
      expect(cfg).toMatchObject({
        userName: "Integration Tester",
        displayCurrency: "THB",
        dbPath: sandbox.dbPath,
      });
      expect(cfg).not.toHaveProperty("dbEncryptionKey");
    },
    20000,
  );

  it("the encrypted statement fixture lands in the sandbox data dir", () => {
    statementPath = join(sandbox.dataDir, "corgi-bank", "card-statement-2026-05.pdf");
    mkdirSync(dirname(statementPath), { recursive: true });
    copyFileSync(FIXTURE_STATEMENT, statementPath);
    expect(existsSync(statementPath)).toBe(true);
  });

  it(
    "ingest list finds exactly the staged statement and reports it encrypted",
    async () => {
      const rows = parseNdjson((await ok(["ingest", "list"])).stdout).filter((r) => r.type === "file");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ encrypted: true, path: statementPath });
      // `vault_candidates` belonged to the removed vault surface; its return would mean that removal regressed.
      expect(rows[0]).not.toHaveProperty("vault_candidates");
    },
    20000,
  );

  it(
    "ingest prepare exits INPUT_REQUIRED without a password, then extracts the text layer with one",
    async () => {
      const locked = await oled(["ingest", "prepare", statementPath]);
      expect(locked.code).toBe(4); // EXIT.INPUT_REQUIRED

      const res = await ok(["ingest", "prepare", statementPath, "--password", FIXTURE_PASSWORD]);
      const result = parseOne(res.stdout);
      // page_count is pinned to this 6-page fixture, not to prepare's paging.
      expect(result).toMatchObject({ page_count: 6, kind: "text" });
      expect(result.file_id).toMatch(/^sf:/);
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
        resolved: "expense:uncategorized",
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

      // Sides come from the stored rows now, not from re-resolving the input.
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
      const rows = parseNdjson((await ok(["questions", "list"])).stdout);
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

      expect(parseNdjson((await ok(["files", "list", "--status", "ingested"])).stdout)).toHaveLength(1);
    },
    30000,
  );

  it(
    "transactions update rewrites a description that transactions show then reflects",
    async () => {
      // groomingId comes from the commit step.
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

  /**
   * Auto-merge (src/ingest/dedup.ts) only matches rows carrying both a
   * merchant_id and a source_file_id, which a manual `transactions add` row has
   * neither of — so the manual add covers strict create only, and the auto-merge
   * assertion rides on a second file-sourced duplicate row.
   */
  it(
    "transactions add creates a manual row, and dedupe --auto-merge collapses one file-sourced duplicate",
    async () => {
      const manual = parseOne(
        (
          await ok([
            "transactions",
            "add",
            "--debit-account",
            "expense:pet:food",
            "--credit-account",
            "asset:bank:kasibank",
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
        debit_account: "expense:pet:food",
        credit_account: "asset:bank:kasibank",
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
            "asset:bank:kasibank",
            "--to",
            "50000",
            "--reason",
            "statement closing balance",
          ])
        ).stdout,
      );
      expect(adjust.transaction_id).toMatch(/^tx:/);

      const account = parseOne((await ok(["accounts", "show", "asset:bank:kasibank"])).stdout);
      expect(account.balance).toBe(50000);

      const status = parseOne((await ok(["status"])).stdout);
      expect(status.net_worth.assets).toBe(50000);
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
            "expense:pet:treats",
            "--name",
            "Treats",
            "--type",
            "expense",
            "--parent",
            "expense:pet",
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
            "expense:pet:treats",
            "--to",
            "expense:pet:food",
            "--yes",
          ])
        ).stdout,
      );
      expect(typeof merge.moved).toBe("number");
      expect(merge).toMatchObject({ deleted_self_transactions: 0 });

      // mergeAccounts deletes the source account, so delete needs a fresh second one.
      await ok([
        "accounts",
        "create",
        "--id",
        "expense:pet:toys",
        "--name",
        "Toys",
        "--type",
        "expense",
        "--parent",
        "expense:pet",
      ]);
      expect(
        parseOne((await ok(["accounts", "delete", "expense:pet:toys", "--yes"])).stdout),
      ).toMatchObject({ deleted: true });
    },
    45000,
  );

  it(
    "transactions delete drops exactly one row from the ledger",
    async () => {
      // salaryId comes from the commit step.
      const before = await transactionCount();
      expect(
        parseOne((await ok(["transactions", "delete", salaryId, "--yes"])).stdout),
      ).toMatchObject({ deleted: true });
      expect(await transactionCount()).toBe(before - 1);
    },
    30000,
  );

  it(
    "files drop removes exactly the rows files show counted, and spares the manual one",
    async () => {
      const detail = parseOne((await ok(["files", "show", fileId])).stdout);
      expect(typeof detail.transaction_count).toBe("number");
      const owned: number = detail.transaction_count;

      const before = await transactionCount();

      const drop = parseOne((await ok(["files", "drop", fileId, "--yes"])).stdout);
      expect(drop.removed_transactions, "files drop must remove what files show counted").toBe(owned);
      expect(await transactionCount()).toBe(before - owned);

      // The manual dup-for-automerge row has no source_file_id, so the cascade must spare it.
      const survivor = await oled(["transactions", "show", manualDupId]);
      expect(survivor.code, `manual row ${manualDupId} did not survive the drop`).toBe(0);
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
    "config --locale rewrites the display locale",
    async () => {
      await ok(["config", "--locale", "en-US"]);
      expect(parseOne((await ok(["config", "show"])).stdout)).toMatchObject({
        displayLocale: "en-US",
      });
    },
    20000,
  );

  it(
    "status still answers after every mutation above",
    async () => {
      const status = parseOne((await ok(["status"])).stdout);
      expect(status.questions.open).toEqual(expect.any(Number));
      expect(status.questions.open).toBeGreaterThanOrEqual(0);
    },
    20000,
  );
});
