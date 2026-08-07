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
  failReason,
  mapNotFoundError,
  readStdinBatch,
  redactionEnabled,
  requireYes,
  runAction,
  type Column,
} from "../output.js";
import { openDb } from "../db.js";
import {
  createAccount as createAccountRow,
  mergeAccounts as mergeAccountRows,
  deleteAccount as deleteAccountRow,
  validateAccountId,
  type AccountRefusal,
} from "../../accounts/accounts.js";
import {
  getAccountBalances,
  getBalanceTree,
  getRollupBalance,
  adjustAccountBalance,
  type AccountBalanceMinor,
  type BalanceTreeNode,
} from "../../accounts/balances.js";
import {
  findAccountById,
  renameAccount,
  updateAccountMetadata,
  ACCOUNT_TYPES,
  type AccountType,
  type CreateAccountInput,
  type UpdateAccountMetadataPatch,
} from "../../db/queries/accounts.js";
import { findAccountsByFuzzyName, type FuzzyAccountMatch } from "../../accounts/matching.js";
import { ensureAccountAncestors } from "../../accounts/resolve.js";
import { failAccountNotFound, requireAccount } from "../accounts.js";
import { fromMinorUnits } from "../../lib/money.js";
import { formatFixed, toDecimalTotals } from "../currency.js";
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
  { header: "Balance", value: (a) => formatFixed(a.balance, a.currency), align: "right" },
  { header: "Debits", value: (a) => formatFixed(a.debits_posted, a.currency), align: "right" },
  { header: "Credits", value: (a) => formatFixed(a.credits_posted, a.currency), align: "right" },
  { header: "Currency", value: (a) => a.currency },
];

const MATCH_COLUMNS: Column<FuzzyAccountMatch>[] = [
  { header: "ID", value: (m) => m.account.id },
  { header: "Name", value: (m) => m.account.name },
  { header: "Type", value: (m) => m.account.type },
  { header: "Similarity", value: (m) => m.similarity.toFixed(3), align: "right" },
];

interface PresentedTreeNode {
  id: string;
  name: string;
  type: string;
  currency: string;
  balance: number;
  rollup: Record<string, number>;
  children: PresentedTreeNode[];
}

function presentTreeNode(node: BalanceTreeNode): PresentedTreeNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    currency: node.currency,
    balance: fromMinorUnits(node.balance_minor, node.currency),
    rollup: toDecimalTotals(node.rollup),
    children: node.children.map(presentTreeNode),
  };
}

/** One `<code> amount` pair per currency, in the key order `toDecimalTotals` fixed. */
function formatTotals(totals: Record<string, number>): string {
  return Object.entries(totals)
    .map(([currency, amount]) => `${currency} ${formatFixed(amount, currency)}`)
    .join(" ");
}

function renderTreeTty(nodes: PresentedTreeNode[], depth = 0): void {
  for (const n of nodes) {
    const indent = "  ".repeat(depth);
    process.stdout.write(
      `${indent}${n.name} (${n.id})  ${formatFixed(n.balance, n.currency)} [rollup ${formatTotals(n.rollup)}]\n`,
    );
    renderTreeTty(n.children, depth + 1);
  }
}

function flattenTree(nodes: PresentedTreeNode[], depth: number, out: string[]): void {
  for (const n of nodes) {
    out.push(
      [
        String(depth),
        n.id,
        n.name,
        n.type,
        n.currency,
        formatFixed(n.balance, n.currency),
        formatTotals(n.rollup),
      ].join("\t"),
    );
    flattenTree(n.children, depth + 1, out);
  }
}

function renderTreePlain(nodes: PresentedTreeNode[]): void {
  const out: string[] = [];
  flattenTree(nodes, 0, out);
  if (out.length) process.stdout.write(out.join("\n") + "\n");
}

// Fails an invalid --type with the same wording zod produces for `accounts create --type`.
function parseAccountTypeFilter(type: string | undefined): AccountType | undefined {
  if (type === undefined) return undefined;
  if (!ACCOUNT_TYPES.includes(type as AccountType)) {
    fail("USAGE", `--type must be one of ${ACCOUNT_TYPES.join(", ")}, got "${type}"`);
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
    redactionEnabled(opts),
    ACCOUNT_REDACT_FIELDS,
  );
  emitList(rows, ACCOUNT_COLUMNS);
  emitSummary({ total: rows.length, returned: rows.length });
}

interface TreeAccountsOpts {
  type?: string;
  redact?: boolean;
}

async function treeAccounts(opts: TreeAccountsOpts): Promise<void> {
  const db = await openDb();
  const type = parseAccountTypeFilter(opts.type);
  const roots = applyRedaction(
    getBalanceTree(db, type ? { type } : {}).map(presentTreeNode),
    redactionEnabled(opts),
    ACCOUNT_REDACT_FIELDS,
  );
  const mode = currentMode();
  if (mode.json) {
    // One object per root so every stdout line stays a single JSON object.
    for (const root of roots) emit(root);
    emitSummary({ roots: roots.length });
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
  const account = requireAccount(db, id);
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
        rollup: toDecimalTotals(getRollupBalance(db, id)),
        children,
      },
      redactionEnabled(opts),
      ACCOUNT_REDACT_FIELDS,
    ),
  );
}

const CREATE_ACCOUNT_SPEC = z.object({
  id: str(),
  name: str(),
  type: z.enum(ACCOUNT_TYPES),
  parent_id: str().optional(),
  subtype: str().optional(),
  bank_name: str().optional(),
  account_number_masked: str().optional(),
  due_day: int().optional(),
  statement_day: int().optional(),
  metadata: json<Record<string, unknown>>().optional(),
});

const CREATE_ACCOUNT_ALIASES = {
  parent_id: ["parent"],
  bank_name: ["bank"],
  account_number_masked: ["masked"],
};

interface CreatedAccount {
  readonly ok: true;
  id: string;
  created_parents: string[];
  account_number_masked?: string | null;
}

type CreateOneAccountOutcome = CreatedAccount | AccountRefusal;

// db.transaction rolls back only on throw, so a refusal must throw to undo any
// parent-ledger write that preceded it.
class RefusedCreate extends Error {
  constructor(readonly failure: AccountRefusal) {
    super(failure.message);
  }
}

// Auto-creates missing ancestors when no parent was given; the whole chain is one
// transaction, so a refused leaf can't leave an unwanted ledger open.
export function createOneAccount(
  db: Database.Database,
  parsed: z.infer<typeof CREATE_ACCOUNT_SPEC>,
): CreateOneAccountOutcome {
  const grammar = validateAccountId(parsed.id, parsed.type);
  if (!grammar.ok) return grammar;

  try {
    return db.transaction((): CreateOneAccountOutcome => {
      let parentId = parsed.parent_id ?? null;
      let createdParents: string[] = [];
      if (parsed.parent_id === undefined) {
        const ancestors = ensureAccountAncestors(db, parsed.id, parsed.type);
        if (!ancestors.ok) throw new RefusedCreate(ancestors);
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
        due_day: parsed.due_day ?? null,
        statement_day: parsed.statement_day ?? null,
        metadata: parsed.metadata ?? null,
      };
      const created = createAccountRow(db, input);
      if (!created.ok) throw new RefusedCreate(created);

      const result: CreatedAccount = { ok: true, id: input.id, created_parents: createdParents };
      // Echo the stored (post-normalization) value rather than re-deriving it.
      if (parsed.account_number_masked !== undefined) {
        result.account_number_masked = findAccountById(db, input.id)?.account_number_masked ?? null;
      }
      return result;
    })();
  } catch (err) {
    if (err instanceof RefusedCreate) return err.failure;
    throw err;
  }
}

function maskedResultField(result: CreatedAccount): Record<string, unknown> {
  return result.account_number_masked !== undefined
    ? { account_number_masked: result.account_number_masked }
    : {};
}

async function createSingleAccount(opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(CREATE_ACCOUNT_SPEC, opts, { aliases: CREATE_ACCOUNT_ALIASES });
  const db = await openDb();
  const outcome = createOneAccount(db, parsed);
  if (!outcome.ok) failReason(outcome);
  emitObject({
    id: outcome.id,
    created: true,
    created_parents: outcome.created_parents,
    ...maskedResultField(outcome),
  });
}

// json/color are global flags, not per-account options.
const NON_ACCOUNT_FLAG_KEYS = new Set(["input", "json", "color"]);

// One result row per item plus a summary row, exit PARTIAL(7) on any failure;
// `account_exists` counts as an idempotent success (`duplicate: true`).
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

    const one = createOneAccount(db, parsed.value);
    if (one.ok) {
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
      continue;
    }
    if (one.reason === "account_exists") {
      duplicates++;
      results.push({ type: "result", index, ok: true, id: parsed.value.id, duplicate: true });
      continue;
    }
    failed++;
    results.push({ type: "result", index, ok: false, message: one.message });
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
    // A cross-ledger merge's message matches neither not-found pattern, so it maps to INVALID.
    mapNotFoundError(err);
  }
  emitObject({
    from: parsed.from,
    to: parsed.to,
    moved: result.moved,
    deleted_self_transactions: result.deletedSelfTransactions,
    moved_merchant_defaults: result.movedMerchantDefaults,
  });
}

async function deleteAccount(id: string, opts: { yes?: boolean }): Promise<void> {
  const db = await openDb();
  requireAccount(db, id);
  requireYes(opts, "deleting this account");
  try {
    deleteAccountRow(db, id);
  } catch (err) {
    mapNotFoundError(err);
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
    mapNotFoundError(err);
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
  emitSummary({ returned: matches.length });
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

// Reward points aren't a ledger unit, so they ride in the metadata blob rather than a stored column.
function buildAccountPatch(
  parsed: Omit<z.infer<typeof UPDATE_ACCOUNT_SPEC>, "name">,
): UpdateAccountMetadataPatch {
  const { points_balance, metadata, ...rest } = parsed;
  const patch: UpdateAccountMetadataPatch = { ...rest };
  if (metadata !== undefined) patch.metadata = metadata;
  if (points_balance !== undefined) patch.metadata = { ...patch.metadata, points_balance };
  return patch;
}

async function updateAccount(id: string, opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(UPDATE_ACCOUNT_SPEC, opts, {
    aliases: UPDATE_ACCOUNT_ALIASES,
    atLeastOne:
      "at least one of --name, --due-day, --statement-day, --points, --masked, --bank, --metadata is required",
  });
  const { name, ...rest } = parsed;
  const patch = buildAccountPatch(rest);

  const db = await openDb();
  const result: Record<string, unknown> = { id };

  if (name !== undefined) {
    const changes = renameAccount(db, id, name);
    if (changes === 0) failAccountNotFound(db, id);
    result.name = name;
    result.renamed = true;
  }

  if (Object.keys(patch).length > 0) {
    let metaResult;
    try {
      metaResult = updateAccountMetadata(db, id, patch);
    } catch (err) {
      mapNotFoundError(err);
    }
    result.before = metaResult.before;
    result.after = metaResult.after;
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
        "Behavior: manages the chart of accounts. Ids are <currency>:<type>:<path> — the currency comes first and every id needs it: thb:asset:bank:kbank, usd:expense:food. Types are asset, liability, income, expense, equity; thb:asset is a ledger's type root.",
        "Typical flow: match to reuse an existing account before create; read balances with tree or show.",
        "One ledger per currency: an account's currency is its id prefix, and a transaction's two accounts must share it. A USD balance lives under usd:, never under thb:.",
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
    .option("--id <id>", "account id, currency-prefixed (e.g. thb:asset:bank:kbank)")
    .option("--name <name>", "account name")
    .option("--type <type>", "account type")
    .option("--parent <id>", "parent account id")
    .option("--subtype <s>", "account subtype")
    .option("--bank <name>", "bank name")
    .option("--masked <number>", "masked account number")
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
