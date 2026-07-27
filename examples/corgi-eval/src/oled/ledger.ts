import * as z from "zod";
import type { Result } from "../core/result.js";
import type { OpenLedgerRunner } from "./command.js";
import { parseNdjson } from "./ndjson.js";

/**
 * Reads the ledger back through the same CLI the model uses, so the scorecard
 * judges what oled actually holds rather than what the model claimed.
 */

/** The three groups a card statement's own totals are printed as. */
export type MoneyGroup = "charges" | "refunds" | "payments";

export interface LedgerGroup {
  count: number;
  /** Absolute total, so a refund and a payment are positive here, as on the statement. */
  total: number;
}

export type LedgerMoney = Record<MoneyGroup, LedgerGroup>;

/** Rows the statement's three groups account for, which is what its row count covers. */
export function groupedRows(money: LedgerMoney): number {
  return money.charges.count + money.refunds.count + money.payments.count;
}

export interface LedgerProbe {
  filesIngested: number;
  /** Files `ingest list` still shows as pending, i.e. never closed with `ingest done`. */
  filesPending: number;
  /** Every transaction in the ledger, whatever produced it. */
  postedRows: number;
  /** Rows oled links to a statement file, from each file's own count. */
  linkedRows: number;
  uncategorizedRows: number;
  questionsOpen: number;
  questionsDeferred: number;
  netWorth: number;
  /**
   * Every live row the three directions match, ledger-wide and not only the
   * linked ones: money the statement does not contain has to corrupt a total,
   * wherever it was posted from.
   */
  money: LedgerMoney;
}

const STATUS = z.object({
  db: z.object({ reachable: z.boolean(), error: z.string().nullable() }),
  counts: z.object({ transactions: z.number() }).nullable(),
  questions: z.object({ open: z.number(), deferred: z.number() }).nullable(),
  net_worth: z.object({ net_worth: z.number() }).nullable(),
});

const ROW = z.object({
  debit_account_id: z.string(),
  credit_account_id: z.string(),
  amount: z.number(),
  void_of: z.string().nullable().optional(),
});

/** `files show <sf:id>`: oled's own count of the rows linked to one file. */
const FILE_DETAIL = z.object({ transaction_count: z.number() });

type Row = z.infer<typeof ROW>;
type StatusReport = z.infer<typeof STATUS>;

const LIST_LIMIT = 500;
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
  return accountId.split(":")[0] ?? "";
}

function isUncategorized(row: Row): boolean {
  return (
    row.debit_account_id.startsWith(UNCATEGORIZED) ||
    row.credit_account_id.startsWith(UNCATEGORIZED)
  );
}

/**
 * Direction, not sign, is what a statement row became: a card charge grows an
 * expense against the card, a refund reverses it, a payment settles the card
 * from an asset. Anything else belongs to no group — a carried-forward opening
 * balance runs through equity, which is why the statement's own totals never
 * cover it.
 */
function groupOf(row: Row): MoneyGroup | null {
  const debit = rootOf(row.debit_account_id);
  const credit = rootOf(row.credit_account_id);
  if (debit === "expense" && credit === "liability") return "charges";
  if (debit === "liability" && credit === "expense") return "refunds";
  if (debit === "liability" && credit === "asset") return "payments";
  return null;
}

/** One classification, read twice: the group's row count and its money. */
function tallyMoney(rows: Row[]): LedgerMoney {
  const count: Record<MoneyGroup, number> = { charges: 0, refunds: 0, payments: 0 };
  const minor: Record<MoneyGroup, number> = { charges: 0, refunds: 0, payments: 0 };
  for (const row of rows) {
    const group = groupOf(row);
    if (group === null) continue;
    count[group] += 1;
    minor[group] += Math.round(row.amount * 100);
  }
  return {
    charges: { count: count.charges, total: minor.charges / 100 },
    refunds: { count: count.refunds, total: minor.refunds / 100 },
    payments: { count: count.payments, total: minor.payments / 100 },
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

function summaryOf(records: Record<string, unknown>[]): Record<string, unknown> {
  return records.find((r) => r.type === "summary") ?? {};
}

function countOf(summary: Record<string, unknown>, key: string): number {
  const value = summary[key];
  return typeof value === "number" ? value : 0;
}

/** Files oled has on record; a statement it has never prepared has no id yet. */
function fileIds(records: Record<string, unknown>[]): string[] {
  const ids: string[] = [];
  for (const record of records) {
    const id = record.file_id;
    if (typeof id === "string" && id) ids.push(id);
  }
  return ids;
}

/**
 * `files show` per file rather than a count over the row listing: it is
 * oled's own per-file count, so it stays right when the listing hits its
 * ceiling.
 */
async function countLinkedRows(runner: OpenLedgerRunner, ids: string[]): Promise<Result<number>> {
  let linked = 0;
  for (const id of ids) {
    const label = `oled files show ${id}`;
    const shown = await readJson(runner, label, ["files", "show", id, "--json"]);
    if (!shown.ok) return shown;

    const parsed = FILE_DETAIL.safeParse(shown.value[0]);
    if (!parsed.success) {
      return { ok: false, error: `${label} was unreadable: ${z.prettifyError(parsed.error)}` };
    }
    linked += parsed.data.transaction_count;
  }
  return { ok: true, value: linked };
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

/**
 * `ingest list` rather than `status` for the file counts: only the per-file view
 * distinguishes a file closed with `ingest done` from one still pending.
 */
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

  const files = await readJson(runner, "oled ingest list", ["ingest", "list", "--json"]);
  if (!files.ok) return files;

  const linked = await countLinkedRows(runner, fileIds(files.value));
  if (!linked.ok) return linked;

  const rows = liveRows(listed.value);
  const fileSummary = summaryOf(files.value);
  return {
    ok: true,
    value: {
      filesIngested: countOf(fileSummary, "ingested"),
      filesPending: countOf(fileSummary, "pending"),
      postedRows: report.value.counts?.transactions ?? 0,
      linkedRows: linked.value,
      uncategorizedRows: rows.filter(isUncategorized).length,
      questionsOpen: report.value.questions?.open ?? 0,
      questionsDeferred: report.value.questions?.deferred ?? 0,
      netWorth: report.value.net_worth?.net_worth ?? 0,
      money: tallyMoney(rows),
    },
  };
}
