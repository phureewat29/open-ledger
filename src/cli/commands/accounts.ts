import type { Command } from "commander";
import type Database from "libsql";
import {
  EXIT,
  asRecord,
  currentMode,
  emit,
  emitList,
  emitObject,
  emitSummary,
  fail,
  mapNotFoundError,
  readStdinBatch,
  requireYes,
  runAction,
  type Column,
} from "../output.js";
import { openDb } from "../db.js";
import { errorMessage } from "../../lib/result.js";
import {
  createAccount as createAccountRow,
  mergeAccounts as mergeAccountRows,
  deleteAccount as deleteAccountRow,
} from "../../accounts/accounts.js";
import {
  getAccountBalances,
  getRollupBalance,
  adjustAccountBalance,
  type AccountBalanceMinor,
} from "../../accounts/balances.js";
import {
  findAccountById,
  renameAccount,
  updateAccountMetadata,
  TOP_LEVEL_TYPES,
  type AccountType,
  type CreateAccountInput,
} from "../../db/queries/accounts.js";
import { findAccountsByFuzzyName, type FuzzyAccountMatch } from "../../accounts/matching.js";
import { ensureAccountAncestors } from "../../accounts/resolve.js";
import { fromMinorUnits } from "../../lib/money.js";
import { applyRedaction } from "../../privacy/redactor.js";
import * as z from "zod";
import { parseInput, safeParse, str, num, int, json } from "../../lib/validate.js";

// Only `name` is free text; id/parent_id/type/currency and balances are structured, left verbatim.
const ACCOUNT_REDACT_FIELDS = ["name"] as const;

type PresentedAccount = Omit<AccountBalanceMinor, "balance_minor">;

function presentAccount(a: AccountBalanceMinor): PresentedAccount {
  const { balance_minor: _bm, debits_posted, credits_posted, ...rest } = a;
  return {
    ...rest,
    debits_posted: fromMinorUnits(debits_posted, a.currency),
    credits_posted: fromMinorUnits(credits_posted, a.currency),
  };
}

const ACCOUNT_COLUMNS: Column<PresentedAccount>[] = [
  { header: "ID", value: (a) => a.id },
  { header: "Name", value: (a) => a.name },
  { header: "Type", value: (a) => a.type },
  { header: "Parent", value: (a) => a.parent_id ?? "" },
  { header: "Balance", value: (a) => a.balance.toFixed(2), align: "right" },
  { header: "Debits", value: (a) => a.debits_posted.toFixed(2), align: "right" },
  { header: "Credits", value: (a) => a.credits_posted.toFixed(2), align: "right" },
  { header: "Currency", value: (a) => a.currency },
];

const MATCH_COLUMNS: Column<FuzzyAccountMatch>[] = [
  { header: "ID", value: (m) => m.account.id },
  { header: "Name", value: (m) => m.account.name },
  { header: "Type", value: (m) => m.account.type },
  { header: "Similarity", value: (m) => m.similarity.toFixed(3), align: "right" },
];

interface AccountTreeNode {
  id: string;
  name: string;
  type: string;
  balance: number;
  rollup: number;
  children: AccountTreeNode[];
}

function buildAccountTree(
  db: Database.Database,
  type: AccountType | undefined,
): AccountTreeNode[] {
  const rows = getAccountBalances(db, type ? { type } : {});
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenMap = new Map<string, AccountBalanceMinor[]>();
  const roots: AccountBalanceMinor[] = [];
  for (const r of rows) {
    if (r.parent_id && byId.has(r.parent_id)) {
      const arr = childrenMap.get(r.parent_id) ?? [];
      arr.push(r);
      childrenMap.set(r.parent_id, arr);
    } else {
      roots.push(r);
    }
  }
  // Per-currency sums convert in sorted order to match getRollupBalance, so the two can't drift.
  const build = (row: AccountBalanceMinor): { node: AccountTreeNode; sums: Map<string, number> } => {
    const sums = new Map<string, number>();
    const children = (childrenMap.get(row.id) ?? []).map((childRow) => {
      const built = build(childRow);
      for (const [currency, minor] of built.sums) {
        sums.set(currency, (sums.get(currency) ?? 0) + minor);
      }
      return built.node;
    });
    sums.set(row.currency, (sums.get(row.currency) ?? 0) + row.balance_minor);

    let rollup = 0;
    for (const currency of [...sums.keys()].sort()) {
      rollup += fromMinorUnits(sums.get(currency)!, currency);
    }
    return {
      node: { id: row.id, name: row.name, type: row.type, balance: row.balance, rollup, children },
      sums,
    };
  };
  return roots.map((row) => build(row).node);
}

function renderTreeTty(nodes: AccountTreeNode[], depth = 0): void {
  for (const n of nodes) {
    const indent = "  ".repeat(depth);
    process.stdout.write(
      `${indent}${n.name} (${n.id})  ${n.balance.toFixed(2)} [rollup ${n.rollup.toFixed(2)}]\n`,
    );
    renderTreeTty(n.children, depth + 1);
  }
}

function flattenTree(nodes: AccountTreeNode[], depth: number, out: string[]): void {
  for (const n of nodes) {
    out.push(
      [String(depth), n.id, n.name, n.type, n.balance.toFixed(2), n.rollup.toFixed(2)].join("\t"),
    );
    flattenTree(n.children, depth + 1, out);
  }
}

function renderTreePlain(nodes: AccountTreeNode[]): void {
  const out: string[] = [];
  flattenTree(nodes, 0, out);
  if (out.length) process.stdout.write(out.join("\n") + "\n");
}

// Fails an invalid --type with the same wording zod produces for `accounts create --type`.
function parseAccountTypeFilter(type: string | undefined): AccountType | undefined {
  if (type === undefined) return undefined;
  if (!TOP_LEVEL_TYPES.includes(type as AccountType)) {
    fail("USAGE", `--type must be one of ${TOP_LEVEL_TYPES.join(", ")}, got "${type}"`);
  }
  return type as AccountType;
}

interface ListAccountsOpts {
  type?: string;
  redact?: boolean;
}

async function listAccounts(opts: ListAccountsOpts): Promise<void> {
  const db = await openDb();
  const type = parseAccountTypeFilter(opts.type);
  const rows = applyRedaction(
    getAccountBalances(db, type ? { type } : {}).map(presentAccount),
    !!opts.redact,
    ACCOUNT_REDACT_FIELDS,
  );
  emitList(rows, ACCOUNT_COLUMNS);
}

interface TreeAccountsOpts {
  type?: string;
  redact?: boolean;
}

async function treeAccounts(opts: TreeAccountsOpts): Promise<void> {
  const db = await openDb();
  const type = parseAccountTypeFilter(opts.type);
  const roots = applyRedaction(buildAccountTree(db, type), !!opts.redact, ACCOUNT_REDACT_FIELDS);
  const mode = currentMode();
  if (mode.json) {
    emit(roots);
    return;
  }
  if (mode.tty) {
    renderTreeTty(roots);
    return;
  }
  renderTreePlain(roots);
}

async function showAccount(id: string, opts: { redact?: boolean } = {}): Promise<void> {
  const db = await openDb();
  const account = findAccountById(db, id);
  if (!account) fail("NOT_FOUND", `account "${id}" not found`);
  const balances = getAccountBalances(db, { idOrParent: id });
  const self = balances.find((b) => b.id === id);
  const children = balances
    .filter((b) => b.parent_id === id)
    .map((b) => ({ id: b.id, name: b.name, type: b.type, balance: b.balance }));
  emitObject(
    applyRedaction(
      {
        ...account,
        balance: self?.balance ?? 0,
        debits_posted: self ? fromMinorUnits(self.debits_posted, self.currency) : 0,
        credits_posted: self ? fromMinorUnits(self.credits_posted, self.currency) : 0,
        rollup: getRollupBalance(db, id),
        children,
      },
      !!opts.redact,
      ACCOUNT_REDACT_FIELDS,
    ),
  );
}

const CREATE_ACCOUNT_SPEC = z.object({
  id: str(),
  name: str(),
  type: z.enum(TOP_LEVEL_TYPES as unknown as [AccountType, ...AccountType[]]),
  parent_id: str().optional(),
  subtype: str().optional(),
  bank_name: str().optional(),
  account_number_masked: str().optional(),
  currency: str().optional(),
  due_day: int().optional(),
  statement_day: int().optional(),
  metadata: json<Record<string, unknown>>().optional(),
});

const CREATE_ACCOUNT_ALIASES = {
  parent_id: ["parent"],
  bank_name: ["bank"],
  account_number_masked: ["masked"],
};

interface CreateOneAccountResult {
  id: string;
  created_parents: string[];
  account_number_masked?: string | null;
}

/** Auto-creates missing ancestors from the id's colon segments when no parent was
 *  given; skipped for an unrecognized type so `createAccountRow` reports a clean
 *  INVALID. Throws on failure, including the `ACCOUNT_EXISTS`-coded duplicate. */
function createOneAccount(
  db: Database.Database,
  parsed: z.infer<typeof CREATE_ACCOUNT_SPEC>,
): CreateOneAccountResult {
  let parentId = parsed.parent_id ?? null;
  let createdParents: string[] = [];
  if (parsed.parent_id === undefined && TOP_LEVEL_TYPES.includes(parsed.type)) {
    const ancestors = ensureAccountAncestors(db, parsed.id, parsed.type);
    if (ancestors.parentId !== null) {
      parentId = ancestors.parentId;
      createdParents = ancestors.createdParents;
    }
  }

  const input: CreateAccountInput = {
    id: parsed.id,
    name: parsed.name,
    type: parsed.type,
    parent_id: parentId,
    subtype: parsed.subtype ?? null,
    bank_name: parsed.bank_name ?? null,
    account_number_masked: parsed.account_number_masked ?? null,
    currency: parsed.currency,
    due_day: parsed.due_day ?? null,
    statement_day: parsed.statement_day ?? null,
    metadata: parsed.metadata ?? null,
  };
  createAccountRow(db, input);

  const result: CreateOneAccountResult = { id: input.id, created_parents: createdParents };
  // Echo the stored (post-normalization) value rather than re-deriving it.
  if (parsed.account_number_masked !== undefined) {
    result.account_number_masked = findAccountById(db, input.id)?.account_number_masked ?? null;
  }
  return result;
}

function maskedResultField(result: CreateOneAccountResult): Record<string, unknown> {
  return result.account_number_masked !== undefined
    ? { account_number_masked: result.account_number_masked }
    : {};
}

async function createSingleAccount(opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(CREATE_ACCOUNT_SPEC, opts, { aliases: CREATE_ACCOUNT_ALIASES });
  const db = await openDb();
  let result: CreateOneAccountResult;
  try {
    result = createOneAccount(db, parsed);
  } catch (err) {
    mapNotFoundError(err, /does not exist/i);
  }
  emitObject({
    id: result.id,
    created: true,
    created_parents: result.created_parents,
    ...maskedResultField(result),
  });
}

// json/color are global flags, not per-account options.
const NON_ACCOUNT_FLAG_KEYS = new Set(["input", "json", "color"]);

/** `ingest commit`'s batch shape: one result row per item, a summary row, exit
 *  PARTIAL(7) on any failure. `ACCOUNT_EXISTS` counts as an idempotent success
 *  (`duplicate: true`) so re-running a batch is a no-op. */
async function createAccountsBatch(inputPath: string | undefined): Promise<void> {
  const items = await readStdinBatch(inputPath);
  if (items.length === 0) fail("USAGE", "no account data provided");

  const db = await openDb();
  const results: Record<string, unknown>[] = [];
  let created = 0;
  let duplicates = 0;
  let failed = 0;

  for (let index = 0; index < items.length; index++) {
    const record = asRecord(items[index]);
    if (!record) {
      failed++;
      results.push({ type: "result", index, ok: false, message: "each account must be a JSON object." });
      continue;
    }

    const parsed = safeParse(CREATE_ACCOUNT_SPEC, record, { aliases: CREATE_ACCOUNT_ALIASES });
    if (!parsed.ok) {
      failed++;
      results.push({ type: "result", index, ok: false, message: parsed.error });
      continue;
    }

    try {
      const one = createOneAccount(db, parsed.value);
      created++;
      results.push({
        type: "result",
        index,
        ok: true,
        id: one.id,
        created: true,
        created_parents: one.created_parents,
        ...maskedResultField(one),
      });
    } catch (err: any) {
      if (err?.code === "ACCOUNT_EXISTS") {
        duplicates++;
        results.push({ type: "result", index, ok: true, id: parsed.value.id, duplicate: true });
        continue;
      }
      failed++;
      results.push({ type: "result", index, ok: false, message: errorMessage(err) });
    }
  }

  const mode = currentMode();
  if (mode.json) {
    for (const r of results) emit(r);
    emitSummary({ created, duplicates, failed });
  } else {
    for (const r of results) emitObject(r);
    process.stdout.write(`\n${created} created, ${duplicates} duplicate(s), ${failed} failed\n`);
  }

  if (failed > 0) process.exitCode = EXIT.PARTIAL;
}

async function createAccount(opts: Record<string, unknown>): Promise<void> {
  if (opts.input !== undefined) {
    if (Object.keys(opts).some((k) => opts[k] !== undefined && !NON_ACCOUNT_FLAG_KEYS.has(k))) {
      fail("USAGE", "--input and per-account flags are mutually exclusive");
    }
    await createAccountsBatch(opts.input as string);
    return;
  }
  await createSingleAccount(opts);
}

const MERGE_ACCOUNTS_SPEC = z.object({
  from: str(),
  to: str(),
});

interface MergeAccountsOpts {
  from?: string;
  to?: string;
  yes?: boolean;
}

async function mergeAccounts(opts: MergeAccountsOpts): Promise<void> {
  const parsed = parseInput(MERGE_ACCOUNTS_SPEC, opts as Record<string, unknown>);
  requireYes(opts, "merging accounts");
  const db = await openDb();
  let result;
  try {
    result = mergeAccountRows(db, parsed.from, parsed.to);
  } catch (err) {
    mapNotFoundError(err, /does not exist/i);
  }
  emitObject({
    from: parsed.from,
    to: parsed.to,
    moved: result.moved,
    deleted_self_transactions: result.deletedSelfTransactions,
  });
}

async function deleteAccount(id: string, opts: { yes?: boolean }): Promise<void> {
  const db = await openDb();
  if (!findAccountById(db, id)) fail("NOT_FOUND", `account "${id}" not found`);
  requireYes(opts, "deleting this account");
  try {
    deleteAccountRow(db, id);
  } catch (err) {
    mapNotFoundError(err, /does not exist/i);
  }
  emitObject({ id, deleted: true });
}

const ADJUST_ACCOUNT_SPEC = z.object({
  to: num(),
  reason: str(),
  date: str().optional(),
});

async function adjustAccount(id: string, opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(ADJUST_ACCOUNT_SPEC, opts);

  const db = await openDb();
  let result;
  try {
    result = adjustAccountBalance(db, {
      accountId: id,
      targetAmount: parsed.to,
      reason: parsed.reason,
      date: parsed.date,
    });
  } catch (err) {
    mapNotFoundError(err, /does not exist/i);
  }
  emitObject({ transaction_id: result.transactionId, delta: result.delta });
}

const MATCH_ACCOUNTS_SPEC = z.object({
  query: str(),
});

async function matchAccounts(opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(MATCH_ACCOUNTS_SPEC, opts);
  const db = await openDb();
  const matches = findAccountsByFuzzyName(db, parsed.query);
  emitList(matches, MATCH_COLUMNS);
}

const UPDATE_ACCOUNT_SPEC = z.object({
  name: str().optional(),
  due_day: int().optional().nullable(),
  statement_day: int().optional().nullable(),
  points_balance: int().optional().nullable(),
  account_number_masked: str().optional().nullable(),
  bank_name: str().optional().nullable(),
  metadata: json<Record<string, unknown>>().optional(),
});

const UPDATE_ACCOUNT_ALIASES = {
  points_balance: ["points"],
  account_number_masked: ["masked"],
  bank_name: ["bank"],
};

async function updateAccount(id: string, opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(UPDATE_ACCOUNT_SPEC, opts, {
    aliases: UPDATE_ACCOUNT_ALIASES,
    atLeastOne:
      "at least one of --name, --due-day, --statement-day, --points, --masked, --bank, --metadata is required",
  });
  const { name, ...patch } = parsed;

  const db = await openDb();
  const result: Record<string, unknown> = { id };

  if (name !== undefined) {
    const changes = renameAccount(db, id, name);
    if (changes === 0) fail("NOT_FOUND", `account "${id}" not found`);
    result.name = name;
    result.renamed = true;
  }

  if (Object.keys(patch).length > 0) {
    let metaResult;
    try {
      metaResult = updateAccountMetadata(db, id, patch);
    } catch (err) {
      mapNotFoundError(err, /does not exist/i);
    }
    Object.assign(result, metaResult);
  }

  emitObject(result);
}

export function registerAccounts(program: Command): void {
  const accounts = program
    .command("accounts")
    .description("Manage the chart of accounts")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: manages the chart of accounts, colon-paths under asset, liability, income, expense, equity.",
        "Typical flow: match to reuse an existing account before create; read balances with tree or show.",
        "Example: oled accounts match --query groceries --json",
      ].join("\n"),
    );

  accounts
    .command("list")
    .description("List accounts")
    .option("--type <type>", "filter by account type")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(listAccounts));

  accounts
    .command("tree")
    .description("Show accounts as a tree")
    .option("--type <type>", "filter by account type")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(treeAccounts));

  accounts
    .command("show <id>")
    .description("Show an account's details")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(showAccount));

  accounts
    .command("create")
    .description("Create a new account (single via flags, or batch via --input)")
    .option("--id <id>", "account id")
    .option("--name <name>", "account name")
    .option("--type <type>", "account type")
    .option("--parent <id>", "parent account id")
    .option("--subtype <s>", "account subtype")
    .option("--bank <name>", "bank name")
    .option("--masked <number>", "masked account number")
    .option("--currency <code>", "currency code")
    .option("--due-day <n>", "payment due day")
    .option("--statement-day <n>", "statement closing day")
    .option("--metadata <json>", "additional metadata as JSON")
    .option("--input <path>", "batch-create accounts from an NDJSON/JSON file instead of individual flags")
    .action(runAction(createAccount));

  accounts
    .command("merge")
    .description("Merge one account into another")
    .option("--from <id>", "account id to merge from")
    .option("--to <id>", "account id to merge into")
    .option("--yes", "skip confirmation")
    .action(runAction(mergeAccounts));

  accounts
    .command("delete <id>")
    .description("Delete an account")
    .option("--yes", "skip confirmation")
    .action(runAction(deleteAccount));

  accounts
    .command("adjust <id>")
    .description("Adjust an account balance")
    .option("--to <amount>", "target balance amount")
    .option("--reason <text>", "reason for the adjustment")
    .option("--date <date>", "adjustment date")
    .action(runAction(adjustAccount));

  accounts
    .command("match")
    .description("Match accounts against a query")
    .option("--query <text>", "search text")
    .action(runAction(matchAccounts));

  accounts
    .command("update <id>")
    .description("Update an account's name and/or metadata")
    .option("--name <name>", "new account name")
    .option("--due-day <n>", "payment due day")
    .option("--statement-day <n>", "statement closing day")
    .option("--points <n>", "reward points balance")
    .option("--masked <number>", "masked account number")
    .option("--bank <name>", "bank name")
    .option("--metadata <json>", "additional metadata as JSON")
    .action(runAction(updateAccount));
}
