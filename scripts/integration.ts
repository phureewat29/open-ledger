/**
 * Two-stage integration test for the CLI harness (stage 1: read-only sweep;
 * stage 2: write-path lifecycle). Builds `dist/` itself, so `npx tsx
 * scripts/integration.ts` is runnable directly with no separate build step.
 */
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSandbox, registerProcessCleanup } from "../fixtures/sandbox.js";

const SCRIPT_DIR = dirname(fileURLToPath(new URL(import.meta.url)));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CLI_PATH = join(REPO_ROOT, "dist", "cli", "index.js");

// Live sandbox roots, so Ctrl-C mid-run still cleans up the active one.
const activeRoots = new Set<string>();
registerProcessCleanup(() => {
  for (const root of activeRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * Node only delivers signals like SIGINT between event loop turns, and
 * back-to-back synchronous `spawnSync` calls never yield one — this gives
 * registerProcessCleanup's handler a turn to run.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const ANSI_RE = /\x1b/;

interface Result {
  label: string;
  pass: boolean;
  detail: string;
}

function printTable(results: Result[]): void {
  const width = Math.max(...results.map((r) => r.label.length));
  for (const r of results) {
    const status = r.pass ? "PASS" : "FAIL";
    const line = `${status.padEnd(4)}  ${r.label.padEnd(width)}  ${r.detail}`;
    console.log(line.trimEnd());
  }
}

// Stage 1: read-surface sweep over an empty ledger

interface Case {
  label: string;
  args: string[];
  expectExit?: number;
}

const READ_CASES: Case[] = [
  { label: "status", args: ["status"] },
  { label: "doctor", args: ["doctor"] },
  { label: "config show", args: ["config", "show"] },
  { label: "ingest list", args: ["ingest", "list"] },
  { label: "files list", args: ["files", "list"] },
  { label: "vault list", args: ["vault", "list"] },
  { label: "transactions list", args: ["transactions", "list"] },
  { label: "transactions list --group", args: ["transactions", "list", "--group"] },
  { label: "transactions dedupe", args: ["transactions", "dedupe"] },
  { label: "accounts list", args: ["accounts", "list"] },
  { label: "accounts tree", args: ["accounts", "tree"] },
  { label: "merchants list", args: ["merchants", "list"] },
  { label: "questions list", args: ["questions", "list"] },
  {
    label: "report",
    args: ["report", "--from", "2026-01-01", "--to", "2026-01-31"],
  },
  { label: "notes list", args: ["notes", "list"] },
  { label: "datasets", args: ["datasets"] },
  {
    label: "datasets institutions --country th",
    args: ["datasets", "institutions", "--country", "th"],
  },
  {
    label: "transactions show tx:nonexistent",
    args: ["transactions", "show", "tx:nonexistent"],
    expectExit: 5,
  },
  {
    label: "transactions delete tx:nonexistent",
    args: ["transactions", "delete", "tx:nonexistent", "--yes"],
    expectExit: 5,
  },
  // Parse failures: commander's own plain text would fail the NDJSON check.
  { label: "unknown option", args: ["ingest", "list", "--nope"], expectExit: 2 },
  { label: "unknown command", args: ["bogus"], expectExit: 2 },
  { label: "unknown subcommand", args: ["ingest", "bogus"], expectExit: 2 },
  { label: "missing required argument", args: ["transactions", "show"], expectExit: 2 },
  // A verbless noun: commander's help screen on stderr would fail the same check.
  { label: "noun without a subcommand", args: ["vault"], expectExit: 2 },
];

function checkNdjson(text: string): string | null {
  const lines = text.split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      return `invalid JSON line: ${line.slice(0, 200)}`;
    }
  }
  return null;
}

function runCase(c: Case, env: NodeJS.ProcessEnv, cwd: string): Result {
  const expectExit = c.expectExit ?? 0;
  const res = spawnSync(process.execPath, [CLI_PATH, ...c.args, "--json"], {
    cwd,
    env,
    encoding: "utf8",
  });

  if (res.error) return { label: c.label, pass: false, detail: `spawn error: ${res.error.message}` };

  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  const problems: string[] = [];

  if (res.status !== expectExit) {
    problems.push(`exit ${res.status} (expected ${expectExit})`);
  }

  const stdoutErr = checkNdjson(stdout);
  if (stdoutErr) problems.push(`stdout: ${stdoutErr}`);

  if (stderr.trim().length > 0) {
    const stderrErr = checkNdjson(stderr);
    if (stderrErr) problems.push(`stderr: ${stderrErr}`);
  }

  if (ANSI_RE.test(stdout) || ANSI_RE.test(stderr)) {
    problems.push("ANSI escape bytes present");
  }

  return { label: c.label, pass: problems.length === 0, detail: problems.join("; ") };
}

// Stage 2: full write-path lifecycle

interface Ctx {
  env: NodeJS.ProcessEnv;
  root: string;
  dataDir: string;
  cacheDir: string;
  dbPath: string;
  // Captured across steps as the lifecycle progresses.
  statementPath: string;
  fileId: string;
  salaryId: string;
  dogfoodId: string;
  groomingId: string;
  manualDupId: string;
  questionIds: string[];
  last?: { args: string[]; stdout: string; stderr: string; code: number };
}

class AssertionFailure extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionFailure(msg);
}

function parseOne(stdout: string): any {
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert(lines.length === 1, `expected exactly 1 NDJSON line, got ${lines.length}: ${stdout.slice(0, 500)}`);
  return JSON.parse(lines[0]);
}

function parseNdjson(stdout: string): any[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Runs the built CLI (--json) for a stage-2 step, stashing the invocation
 *  in `ctx.last` so a thrown assertion can report the failing command. */
function sh(ctx: Ctx, args: string[], opts: { stdin?: string } = {}): { stdout: string; stderr: string; code: number } {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args, "--json"], {
    cwd: ctx.root,
    env: ctx.env,
    input: opts.stdin,
    encoding: "utf8",
  });
  const out = { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? -1 };
  ctx.last = { args, ...out };
  if (res.error) throw new AssertionFailure(`spawn error running "${args.join(" ")}": ${res.error.message}`);
  return out;
}

function shOk(ctx: Ctx, args: string[], opts: { stdin?: string } = {}): { stdout: string; stderr: string; code: number } {
  const r = sh(ctx, args, opts);
  assert(r.code === 0, `expected exit 0 for "${args.join(" ")}", got ${r.code}\nstderr: ${r.stderr}`);
  return r;
}

/** Hand-crafted, not parsed from the fixture PDF (which only exercises
 *  discovery/vault unlock/prepare); re-committed verbatim later to prove idempotency. */
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

function stepConfigInit(ctx: Ctx): void {
  const res = shOk(ctx, [
    "config",
    "--data-dir",
    ctx.dataDir,
    "--db",
    ctx.dbPath,
    "--generate-key",
    "--user-name",
    "Integration Tester",
    "--currency",
    "THB",
    "--locale",
    "th-TH",
  ]);
  const result = parseOne(res.stdout);
  assert(result.dbEncryptionKey?.set === true, `dbEncryptionKey.set is not true: ${JSON.stringify(result)}`);
  assert(!/[0-9a-f]{64}/i.test(res.stdout), "raw 64-hex encryption key leaked onto stdout");
}

function stepConfigShowEncrypted(ctx: Ctx): void {
  const res = shOk(ctx, ["config", "show"]);
  const cfg = parseOne(res.stdout);
  assert(cfg.dbEncryptionKey?.set === true, `config show did not reflect the generated key: ${JSON.stringify(cfg)}`);
}

/** AES-256 password-protected fixture; must stay in the repo for this test to run. */
const FIXTURE_STATEMENT = join(
  REPO_ROOT,
  "examples",
  "corgi-claude",
  "fixtures",
  "card-statement-2026-05.pdf",
);
const FIXTURE_PASSWORD = "password";

function stepPlaceStatement(ctx: Ctx): void {
  const outPath = join(ctx.dataDir, "corgi-bank", "card-statement-2026-05.pdf");
  mkdirSync(dirname(outPath), { recursive: true });
  copyFileSync(FIXTURE_STATEMENT, outPath);
  ctx.last = { args: ["(copy fixture statement)", outPath], stdout: "", stderr: "", code: 0 };
  assert(existsSync(outPath), `expected fixture statement at ${outPath}`);
  ctx.statementPath = outPath;
}

function stepVaultAddIngestList(ctx: Ctx): void {
  const add = shOk(ctx, ["vault", "add", "^card-statement"], {
    stdin: FIXTURE_PASSWORD,
  });
  const addResult = parseOne(add.stdout);
  assert(addResult.pattern === "^card-statement", `unexpected vault add result: ${JSON.stringify(addResult)}`);

  const list = shOk(ctx, ["ingest", "list"]);
  const objs = parseNdjson(list.stdout);
  const files = objs.filter((o) => o.type === "file");
  assert(files.length === 1, `expected exactly 1 ingest file, got ${files.length}`);
  const f = files[0];
  assert(f.encrypted === true, `expected the statement to be reported encrypted: ${JSON.stringify(f)}`);
  assert(f.vault_candidates === 1, `expected 1 vault candidate, got ${f.vault_candidates}`);
  assert(f.path === ctx.statementPath, `ingest list path mismatch: ${f.path} !== ${ctx.statementPath}`);
}

function stepIngestPrepare(ctx: Ctx): void {
  const res = shOk(ctx, ["ingest", "prepare", ctx.statementPath]);
  const result = parseOne(res.stdout);
  assert(typeof result.file_id === "string" && result.file_id.startsWith("sf:"), `bad file_id: ${JSON.stringify(result)}`);
  assert(result.page_count === 6, `expected page_count 6, got ${result.page_count}`);
  assert(result.kind === "text", `expected the text layer to be extracted, got kind ${result.kind}`);
  const cacheDirResolved = resolve(ctx.cacheDir);
  assert(
    typeof result.document === "string" && result.document.startsWith(cacheDirResolved),
    `expected the extracted text under ${cacheDirResolved}, got ${result.document}`,
  );
  assert(existsSync(result.document), `extracted document missing on disk: ${result.document}`);
  ctx.fileId = result.file_id;
}

function stepIngestCommit(ctx: Ctx): void {
  const ndjson = lifecycleItems()
    .map((i) => JSON.stringify(i))
    .join("\n");
  const res = shOk(ctx, ["ingest", "commit", "--file", ctx.fileId], { stdin: ndjson });
  const objs = parseNdjson(res.stdout);
  const results = objs.filter((o) => o.type === "result");
  const summary = objs.find((o) => o.type === "summary");
  assert(results.length === 3, `expected 3 commit results, got ${results.length}`);
  const [salary, dogfood, grooming] = results;
  assert(salary.ok === true, `salary row failed: ${JSON.stringify(salary)}`);
  assert(dogfood.ok === true, `dog food row failed: ${JSON.stringify(dogfood)}`);
  assert(grooming.ok === true, `grooming row failed: ${JSON.stringify(grooming)}`);
  const groomingDebit = grooming.sides?.find((s: { side: string }) => s.side === "debit");
  assert(
    groomingDebit?.how === "uncategorized_fallback" && groomingDebit?.resolved === "expense:uncategorized",
    `expected the bare-leaf grooming hint to fall back to expense:uncategorized: ${JSON.stringify(grooming.sides)}`,
  );
  assert(dogfood.merchant?.how === "linked", `expected dog food merchant linked: ${JSON.stringify(dogfood.merchant)}`);
  assert(typeof dogfood.merchant.merchant_id === "string", "expected a merchant_id on the dog food row");

  assert(summary, "missing ingest commit summary");
  assert(summary.posted === 3, `expected posted:3, got ${summary.posted}`);
  assert(summary.duplicates === 0, `expected duplicates:0, got ${summary.duplicates}`);
  assert(summary.failed === 0, `expected failed:0, got ${summary.failed}`);
  assert(summary.raised_questions > 0, `expected raised_questions > 0, got ${summary.raised_questions}`);

  ctx.salaryId = salary.transaction_id;
  ctx.dogfoodId = dogfood.transaction_id;
  ctx.groomingId = grooming.transaction_id;
}

function stepIngestReCommitDuplicate(ctx: Ctx): void {
  const ndjson = lifecycleItems()
    .map((i) => JSON.stringify(i))
    .join("\n");
  const res = shOk(ctx, ["ingest", "commit", "--file", ctx.fileId], { stdin: ndjson });
  const objs = parseNdjson(res.stdout);
  const results = objs.filter((o) => o.type === "result");
  const summary = objs.find((o) => o.type === "summary");
  assert(
    results.length === 3 && results.every((r) => r.duplicate === true),
    `re-piped rows were not all reported duplicate: ${JSON.stringify(results)}`,
  );
  assert(
    summary.duplicates === 3 && summary.posted === 0,
    `expected duplicates:3 posted:0, got ${JSON.stringify(summary)}`,
  );
  // Sides come from the stored rows now, not from re-resolving the input.
  assert(
    results.every((r) => r.sides === undefined || r.sides.every((s: { how: string }) => s.how === "as_committed")),
    `expected every duplicate side reported as_committed: ${JSON.stringify(results.map((r) => r.sides))}`,
  );

  const status = parseOne(shOk(ctx, ["status"]).stdout);
  assert(status.counts.transactions === 3, `expected 3 transactions after the no-op re-pipe, got ${status.counts.transactions}`);
}

function stepQuestions(ctx: Ctx): void {
  const list = shOk(ctx, ["questions", "list"]);
  const rows = parseNdjson(list.stdout);
  assert(rows.length >= 1, "expected at least 1 open question after ingest commit");
  ctx.questionIds = rows.map((r) => r.id);

  const answer = shOk(ctx, ["questions", "answer", ctx.questionIds[0], "--answer", "confirmed"]);
  const answered = parseNdjson(answer.stdout);
  assert(
    answered.length === 1 && answered[0].id === ctx.questionIds[0],
    `questions answer did not close the expected question: ${JSON.stringify(answered)}`,
  );
}

function stepIngestDone(ctx: Ctx): void {
  const res = shOk(ctx, ["ingest", "done", ctx.fileId, "--agent", "integration"]);
  const result = parseOne(res.stdout);
  assert(result.status === "ingested", `expected status ingested, got ${result.status}`);
  const cacheSubdir = join(ctx.cacheDir, ctx.fileId);
  assert(
    Array.isArray(result.cache_removed) && result.cache_removed.includes(cacheSubdir),
    `expected cache_removed to include ${cacheSubdir}: ${JSON.stringify(result.cache_removed)}`,
  );
  assert(!existsSync(cacheSubdir), `cache subdir still exists: ${cacheSubdir}`);

  const list = shOk(ctx, ["files", "list", "--status", "ingested"]);
  const rows = parseNdjson(list.stdout);
  assert(rows.length === 1, `expected 1 ingested file, got ${rows.length}`);
}

function stepTransactionsUpdateShow(ctx: Ctx): void {
  const res = shOk(ctx, ["transactions", "update", ctx.groomingId, "--description", "updated by integration"]);
  const result = parseOne(res.stdout);
  assert(result.updated === true, `transactions update did not report updated:true: ${JSON.stringify(result)}`);

  const show = shOk(ctx, ["transactions", "show", ctx.groomingId]);
  const detail = parseOne(show.stdout);
  assert(
    detail.description === "updated by integration",
    `transactions show did not reflect the update: ${JSON.stringify(detail)}`,
  );
}

/**
 * Auto-merge (src/ingest/dedup.ts) only matches rows with both merchant_id
 * AND source_file_id, which a manual `transactions add` row has neither of —
 * so the manual add below only covers "strict create"; the auto-merge
 * assertion instead posts a second file-sourced duplicate row.
 */
function stepTransactionsAddAutoMerge(ctx: Ctx): void {
  const manual = shOk(ctx, [
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
  ]);
  const manualResult = parseOne(manual.stdout);
  assert(
    typeof manualResult.transaction_id === "string" && manualResult.duplicate === false,
    `manual dup-for-automerge add failed: ${JSON.stringify(manualResult)}`,
  );
  ctx.manualDupId = manualResult.transaction_id;

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
  const dupCommit = shOk(ctx, ["ingest", "commit", "--file", ctx.fileId], { stdin: JSON.stringify(dup) });
  const dupObjs = parseNdjson(dupCommit.stdout);
  const dupResult = dupObjs.find((o) => o.type === "result");
  assert(
    dupResult?.ok === true && dupResult.duplicate === false,
    `expected the synthetic duplicate to post as a genuinely new row: ${JSON.stringify(dupResult)}`,
  );

  const before = parseOne(shOk(ctx, ["status"]).stdout).counts.transactions;

  const merge = shOk(ctx, ["transactions", "dedupe", "--auto-merge"]);
  const mergeObjs = parseNdjson(merge.stdout);
  const mergeSummary = mergeObjs.find((o) => o.type === "summary");
  assert(mergeSummary?.auto_merged === 1, `expected exactly 1 auto-merge, got ${JSON.stringify(mergeSummary)}`);

  const after = parseOne(shOk(ctx, ["status"]).stdout).counts.transactions;
  assert(
    after === before - 1,
    `expected transactions to drop by 1 after auto-merge (before ${before}, after ${after})`,
  );
}

function stepAccountsAdjust(ctx: Ctx): void {
  const res = shOk(ctx, [
    "accounts",
    "adjust",
    "asset:bank:kasibank",
    "--to",
    "50000",
    "--reason",
    "statement closing balance",
  ]);
  const result = parseOne(res.stdout);
  assert(typeof result.transaction_id === "string", `expected a balancing transaction_id: ${JSON.stringify(result)}`);

  const show = shOk(ctx, ["accounts", "show", "asset:bank:kasibank"]);
  const account = parseOne(show.stdout);
  assert(account.balance === 50000, `expected asset:bank:kasibank balance 50000, got ${account.balance}`);

  const status = parseOne(shOk(ctx, ["status"]).stdout);
  assert(status.net_worth.assets === 50000, `expected net_worth.assets 50000, got ${status.net_worth.assets}`);
}

function stepAccountsCreateMergeDelete(ctx: Ctx): void {
  const create = shOk(ctx, [
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
  ]);
  assert(parseOne(create.stdout).created === true, "accounts create did not report created:true");

  const merge = shOk(ctx, ["accounts", "merge", "--from", "expense:pet:treats", "--to", "expense:pet:food", "--yes"]);
  const mergeResult = parseOne(merge.stdout);
  assert(typeof mergeResult.moved === "number", `expected a numeric moved count: ${JSON.stringify(mergeResult)}`);
  assert(
    mergeResult.deleted_self_transactions === 0,
    `expected no self-transactions from an empty account merge: ${JSON.stringify(mergeResult)}`,
  );

  // mergeAccounts deletes the source account, so exercise delete on a fresh second one.
  shOk(ctx, [
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
  const del = shOk(ctx, ["accounts", "delete", "expense:pet:toys", "--yes"]);
  assert(parseOne(del.stdout).deleted === true, "accounts delete did not report deleted:true");
}

function stepTransactionsDelete(ctx: Ctx): void {
  const before = parseOne(shOk(ctx, ["status"]).stdout).counts.transactions;

  const res = shOk(ctx, ["transactions", "delete", ctx.salaryId, "--yes"]);
  assert(parseOne(res.stdout).deleted === true, "transactions delete did not report deleted:true");

  const after = parseOne(shOk(ctx, ["status"]).stdout).counts.transactions;
  assert(after === before - 1, `expected transactions to drop by 1 after transactions delete (before ${before}, after ${after})`);
}

function stepFilesShowDrop(ctx: Ctx): void {
  const show = shOk(ctx, ["files", "show", ctx.fileId]);
  const detail = parseOne(show.stdout);
  assert(typeof detail.transaction_count === "number", `expected a numeric transaction_count: ${JSON.stringify(detail)}`);
  const expectedTransactionCount = detail.transaction_count;

  const before = parseOne(shOk(ctx, ["status"]).stdout).counts.transactions;

  const drop = shOk(ctx, ["files", "drop", ctx.fileId, "--yes"]);
  const dropResult = parseOne(drop.stdout);
  assert(
    dropResult.removed_transactions === expectedTransactionCount,
    `removed_transactions ${dropResult.removed_transactions} != transaction_count ${expectedTransactionCount}`,
  );

  const after = parseOne(shOk(ctx, ["status"]).stdout).counts.transactions;
  assert(
    after === before - expectedTransactionCount,
    `expected transactions to drop by ${expectedTransactionCount} (before ${before}, after ${after})`,
  );
  // The manual dup-for-automerge transaction (no source_file_id) must survive the drop.
  assert(!!ctx.manualDupId, "expected a captured manual transaction id to still be tracked");
}

function stepSkillSetup(ctx: Ctx): void {
  const skillBase = join(ctx.root, "agent-skill");
  const res = shOk(ctx, ["setup", "--dir", skillBase]);
  const result = parseOne(res.stdout);
  assert(
    Array.isArray(result.installed) && result.installed.length === 1,
    `unexpected setup result: ${JSON.stringify(result)}`,
  );

  const skillDir = join(skillBase, "skills", "open-ledger");
  assert(existsSync(join(skillDir, "SKILL.md")), `missing SKILL.md under ${skillDir}`);
  assert(existsSync(join(skillDir, "VERSION")), `missing VERSION under ${skillDir}`);
}

function stepConfigLocale(ctx: Ctx): void {
  shOk(ctx, ["config", "--locale", "en-US"]);
  const show = shOk(ctx, ["config", "show"]);
  const cfg = parseOne(show.stdout);
  assert(cfg.displayLocale === "en-US", `expected displayLocale en-US, got ${cfg.displayLocale}`);
}

function stepClosingStatus(ctx: Ctx): void {
  const res = shOk(ctx, ["status"]);
  const status = parseOne(res.stdout);
  assert(
    typeof status.questions?.open === "number" && status.questions.open >= 0,
    `unexpected questions.open: ${JSON.stringify(status.questions)}`,
  );
}

const STAGE2_STEPS: { label: string; fn: (ctx: Ctx) => void }[] = [
  { label: "lifecycle: config --generate-key", fn: stepConfigInit },
  { label: "lifecycle: config show reflects encryption key", fn: stepConfigShowEncrypted },
  { label: "lifecycle: place encrypted statement fixture", fn: stepPlaceStatement },
  { label: "lifecycle: vault add + ingest list (encrypted)", fn: stepVaultAddIngestList },
  { label: "lifecycle: ingest prepare (vault unlock)", fn: stepIngestPrepare },
  { label: "lifecycle: ingest commit (salary/dogfood/grooming)", fn: stepIngestCommit },
  { label: "lifecycle: ingest re-commit is idempotent", fn: stepIngestReCommitDuplicate },
  { label: "lifecycle: questions list + answer", fn: stepQuestions },
  { label: "lifecycle: ingest done (cache cleanup)", fn: stepIngestDone },
  { label: "lifecycle: transactions update + show", fn: stepTransactionsUpdateShow },
  { label: "lifecycle: transactions add (strict) + dedupe --auto-merge", fn: stepTransactionsAddAutoMerge },
  { label: "lifecycle: accounts adjust (closing balance)", fn: stepAccountsAdjust },
  { label: "lifecycle: accounts create + merge + delete", fn: stepAccountsCreateMergeDelete },
  { label: "lifecycle: transactions delete", fn: stepTransactionsDelete },
  { label: "lifecycle: files show + drop", fn: stepFilesShowDrop },
  { label: "lifecycle: setup --dir", fn: stepSkillSetup },
  { label: "lifecycle: config --locale", fn: stepConfigLocale },
  { label: "lifecycle: closing status sanity", fn: stepClosingStatus },
];

/**
 * Own fresh env, not stage 1's: stage 1's read sweep already migrates a
 * plaintext db, and `config --generate-key` refuses to key an existing one.
 */
async function runStage2(): Promise<Result[]> {
  const sandbox = createSandbox("oled-integration-stage2-");
  activeRoots.add(sandbox.root);
  const ctx: Ctx = {
    env: sandbox.env,
    root: sandbox.root,
    dataDir: sandbox.dataDir,
    cacheDir: sandbox.cacheDir,
    dbPath: sandbox.dbPath,
    statementPath: "",
    fileId: "",
    salaryId: "",
    dogfoodId: "",
    groomingId: "",
    manualDupId: "",
    questionIds: [],
  };

  const results: Result[] = [];
  try {
    for (const step of STAGE2_STEPS) {
      try {
        step.fn(ctx);
        results.push({ label: step.label, pass: true, detail: "" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ label: step.label, pass: false, detail: msg });
        console.error(`\nintegration: STAGE 2 FAILURE in "${step.label}"`);
        if (ctx.last) {
          console.error(`command: oled ${ctx.last.args.join(" ")}`);
          console.error(`exit code: ${ctx.last.code}`);
          console.error(`stdout:\n${ctx.last.stdout}`);
          console.error(`stderr:\n${ctx.last.stderr}`);
        }
        // Stateful lifecycle — stop rather than cascade into unrelated failures.
        break;
      }
      await yieldToEventLoop();
    }
  } finally {
    sandbox.cleanup();
    activeRoots.delete(sandbox.root);
  }
  return results;
}

async function main(): Promise<void> {
  console.log("integration: building...");
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "inherit" });

  const sandbox = createSandbox("oled-integration-");
  activeRoots.add(sandbox.root);
  console.log(`integration: stage 1 temp env at ${sandbox.root}`);

  const stage1Results: Result[] = [];
  try {
    for (const c of READ_CASES) {
      stage1Results.push(runCase(c, sandbox.env, sandbox.root));
      await yieldToEventLoop();
    }
  } finally {
    sandbox.cleanup();
    activeRoots.delete(sandbox.root);
  }
  console.log("\nSTAGE 1: read-surface sweep\n");
  printTable(stage1Results);

  console.log("\nintegration: stage 2 running in its own isolated env...");
  const stage2Results = await runStage2();
  console.log("\nSTAGE 2: write-path lifecycle\n");
  printTable(stage2Results);

  const all = [...stage1Results, ...stage2Results];
  const failed = all.filter((r) => !r.pass);
  console.log("");
  if (failed.length > 0) {
    console.error(`integration: ${failed.length}/${all.length} case(s) failed`);
    process.exit(1);
  }
  console.log(`integration: all ${all.length} cases passed`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
