import * as z from "zod";
import type { Result } from "../core/result.js";
import type { OpenLedgerRunner } from "./command.js";
import { parseNdjson } from "./ndjson.js";

// Reads the ledger back through the same CLI the model uses, so the scorecard
// judges what oled holds, not what the model claimed.

/** The three groups a card statement's own totals are printed as. */
type MoneyGroup = "charges" | "refunds" | "payments";

interface LedgerGroup {
  count: number;
  /** Absolute total, so a refund and a payment are positive here, as on the statement. */
  total: number;
}

type LedgerMoney = Record<MoneyGroup, LedgerGroup>;

export function groupedRows(money: LedgerMoney): number {
  return money.charges.count + money.refunds.count + money.payments.count;
}

/** `transactions list` hit its limit: every reading taken from the listing is short. */
export interface ListTruncation {
  limit: number;
  total: number;
  returned: number;
}

export interface LedgerProbe {
  filesIngested: number;
  /** Files oled still holds as pending, i.e. never closed with `ingest done`. */
  filesPending: number;
  postedRows: number;
  /** Rows oled links to a statement file, from the listing's own `source_file_id`. */
  linkedRows: number;
  uncategorizedRows: number;
  questionsOpen: number;
  questionsDeferred: number;
  netWorth: number;
  /** null when the whole ledger fit in one listing, which is the expected case. */
  truncated: ListTruncation | null;
  /** Ledger-wide, not only linked rows: unlinked money would still corrupt a total. */
  money: LedgerMoney;
}

const STATUS = z.object({
  db: z.object({ reachable: z.boolean(), error: z.string().nullable() }),
  counts: z.object({ transactions: z.number() }).nullable(),
  files: z.object({ ingested: z.number(), pending: z.number() }).nullable(),
  questions: z.object({ open: z.number(), deferred: z.number() }).nullable(),
  net_worth: z.object({ net_worth: z.record(z.string(), z.number()) }).nullable(),
});

const ROW = z.object({
  debit_account_id: z.string(),
  credit_account_id: z.string(),
  amount: z.number(),
  source_file_id: z.string().nullable().optional(),
  void_of: z.string().nullable().optional(),
});

/** The summary `transactions list` closes with; `has_more` is how a capped read admits it. */
const LIST_SUMMARY = z.object({
  type: z.literal("summary"),
  total: z.number(),
  returned: z.number(),
  has_more: z.boolean(),
  limit: z.number(),
});

type Row = z.infer<typeof ROW>;
type StatusReport = z.infer<typeof STATUS>;

const LIST_LIMIT = 500;
/** Minus the currency head; full id is `<currency>:expense:uncategorized`. */
const UNCATEGORIZED = "expense:uncategorized";

async function readJson(
  runner: OpenLedgerRunner,
  label: string,
  argv: string[],
): Promise<Result<Record<string, unknown>[]>> {
  const result = await runner.run(argv);
  if (!result.ok) return { ok: false, error: `${label} did not run: ${result.message}` };

  const command = result.value;
  if (command.exitCode !== 0) {
    return {
      ok: false,
      error: `${label} exited ${command.exitCode}: ${command.stderr.trim() || command.stdout.trim()}`,
    };
  }
  return { ok: true, value: parseNdjson(command.stdout) };
}

function rootOf(accountId: string): string {
  return accountId.split(":")[1] ?? "";
}

function ledgerOf(accountId: string): string {
  return accountId.split(":")[0] ?? "";
}

/** Built from the account's own currency head, so it matches whichever ledger
 *  the row posted into. */
function uncategorizedRootFor(accountId: string): string {
  return `${ledgerOf(accountId)}:${UNCATEGORIZED}`;
}

function isUncategorized(row: Row): boolean {
  return (
    row.debit_account_id.startsWith(uncategorizedRootFor(row.debit_account_id)) ||
    row.credit_account_id.startsWith(uncategorizedRootFor(row.credit_account_id))
  );
}

/** Classifies by direction, not sign; an opening balance runs through equity,
 *  so it belongs to no group. */
function groupOf(row: Row): MoneyGroup | null {
  const debit = rootOf(row.debit_account_id);
  const credit = rootOf(row.credit_account_id);
  if (debit === "expense" && credit === "liability") return "charges";
  if (debit === "liability" && credit === "expense") return "refunds";
  if (debit === "liability" && credit === "asset") return "payments";
  return null;
}

/** Totals come back 0 across more than one ledger, same rule as `soleLedgerTotal`.
 *  Ledger membership is read off the debit account's id. */
export function tallyMoney(rows: Row[]): LedgerMoney {
  const count: Record<MoneyGroup, number> = { charges: 0, refunds: 0, payments: 0 };
  const minor: Record<MoneyGroup, number> = { charges: 0, refunds: 0, payments: 0 };
  const ledgers = new Set<string>();
  for (const row of rows) {
    const group = groupOf(row);
    if (group === null) continue;
    ledgers.add(ledgerOf(row.debit_account_id));
    count[group] += 1;
    minor[group] += Math.round(row.amount * 100);
  }
  const total = (group: MoneyGroup): number => (ledgers.size > 1 ? 0 : minor[group] / 100);
  return {
    charges: { count: count.charges, total: total("charges") },
    refunds: { count: count.refunds, total: total("refunds") },
    payments: { count: count.payments, total: total("payments") },
  };
}

function liveRows(records: Record<string, unknown>[]): Row[] {
  const rows: Row[] = [];
  for (const record of records) {
    const parsed = ROW.safeParse(record);
    if (!parsed.success) continue;
    if (parsed.data.void_of) continue;
    rows.push(parsed.data);
  }
  return rows;
}

/** Absent on an empty listing, and null unless the cap actually bit. */
function truncationOf(records: Record<string, unknown>[]): ListTruncation | null {
  for (const record of records) {
    const parsed = LIST_SUMMARY.safeParse(record);
    if (!parsed.success) continue;
    const { has_more: hasMore, limit, total, returned } = parsed.data;
    return hasMore ? { limit, total, returned } : null;
  }
  return null;
}

/** Multiple ledgers means no one number to score, so totals come back 0 rather
 *  than a sum across units. */
function soleLedgerTotal(totals: Record<string, number> | undefined): number {
  const [only, ...rest] = Object.values(totals ?? {});
  return only !== undefined && rest.length === 0 ? only : 0;
}

function readStatus(records: Record<string, unknown>[]): Result<StatusReport> {
  const parsed = STATUS.safeParse(records[0]);
  if (!parsed.success) {
    return {
      ok: false,
      error: `oled status output was unreadable: ${z.prettifyError(parsed.error)}`,
    };
  }
  if (!parsed.data.db.reachable) {
    return { ok: false, error: `database unreachable: ${parsed.data.db.error ?? "unknown reason"}` };
  }
  return { ok: true, value: parsed.data };
}

/** Two commands: `status` holds every count oled keeps, the listing holds the rows themselves. */
export async function probeLedger(runner: OpenLedgerRunner): Promise<Result<LedgerProbe>> {
  const status = await readJson(runner, "oled status", ["status", "--json"]);
  if (!status.ok) return status;

  const report = readStatus(status.value);
  if (!report.ok) return report;

  const listed = await readJson(runner, "oled transactions list", [
    "transactions",
    "list",
    "--limit",
    String(LIST_LIMIT),
    "--json",
  ]);
  if (!listed.ok) return listed;

  const rows = liveRows(listed.value);
  const { counts, files, questions, net_worth: netWorth } = report.value;
  return {
    ok: true,
    value: {
      filesIngested: files?.ingested ?? 0,
      filesPending: files?.pending ?? 0,
      postedRows: counts?.transactions ?? 0,
      linkedRows: rows.filter((row) => !!row.source_file_id).length,
      uncategorizedRows: rows.filter(isUncategorized).length,
      questionsOpen: questions?.open ?? 0,
      questionsDeferred: questions?.deferred ?? 0,
      netWorth: soleLedgerTotal(netWorth?.net_worth),
      truncated: truncationOf(listed.value),
      money: tallyMoney(rows),
    },
  };
}
