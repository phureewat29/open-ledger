import type { Command } from "commander";
import chalk from "chalk";
import { config, getConfigPath, getDataDir } from "../../config.js";
import { existsSync } from "fs";
import { homedir } from "os";
import { sep } from "path";
import { formatAmount } from "../currency.js";
import { banner, visibleLength, ANSI_RE, formatInt } from "../format.js";
import { currentMode, emit, runAction } from "../output.js";
import { tryExecute } from "../../lib/result.js";
import { openDb } from "../db.js";

/** Rewrites a leading home-directory prefix to "~/"; any other string passes through
 *  unchanged, so calling it on non-path values (e.g. error prose) is a safe no-op. */
function homeRelative(p: string): string {
  const prefix = homedir() + sep;
  return p.startsWith(prefix) ? "~" + sep + p.slice(prefix.length) : p;
}

interface Counts {
  accounts: number;
  transactions: number;
  merchants: number;
  notes: number;
}

export interface StatusReport {
  type: "status";
  configured: boolean;
  config_path: string;
  data_dir: string;
  locale: string;
  currency: string;
  user_name: string;
  db: {
    path: string;
    reachable: boolean;
    error: string | null;
  };
  counts: Counts | null;
  files: { ingested: number; pending: number; failed: number } | null;
  questions: { open: number; deferred: number } | null;
  net_worth: { assets: number; liabilities: number; net_worth: number } | null;
}

/** `status` never creates the ledger, so a missing db file is reported, not opened. */
const NO_LEDGER = "no ledger yet";

async function buildReport(): Promise<StatusReport> {
  const report: StatusReport = {
    type: "status",
    // A converge has run, which is what `oled config --init` does; a db file on
    // its own says nothing about configuration.
    configured: existsSync(getConfigPath()),
    config_path: homeRelative(getConfigPath()),
    data_dir: homeRelative(getDataDir()),
    locale: config.displayLocale,
    currency: config.displayCurrency,
    user_name: config.userName,
    db: {
      path: homeRelative(config.dbPath),
      reachable: false,
      error: null,
    },
    counts: null,
    files: null,
    questions: null,
    net_worth: null,
  };

  // Orienting must not create a ledger: openDb() would migrate an empty file
  // into existence, so a missing db is reported instead of opened.
  if (!existsSync(config.dbPath)) {
    report.db.error = NO_LEDGER;
    return report;
  }

  // Deferred so non-db commands skip the libsql cost at startup.
  const { getNetWorth } = await import("../../accounts/balances.js");
  const { countAccounts } = await import("../../db/queries/accounts.js");
  const { countTransactions } = await import("../../db/queries/transactions.js");
  const { countFiles } = await import("../../db/queries/files.js");
  const { countQuestions } = await import("../../db/queries/questions.js");
  const { countMerchants } = await import("../../db/queries/merchants.js");
  const { countNotes } = await import("../../db/queries/notes.js");

  // Opening the db is the only reachability check; a failing count query must not read as not-ready.
  const opened = await tryExecute(() => openDb());
  if (!opened.ok) {
    report.db.error = homeRelative(opened.error);
    return report;
  }
  const db = opened.value;
  report.db.reachable = true;

  report.counts = {
    accounts: countAccounts(db),
    transactions: countTransactions(db),
    merchants: countMerchants(db),
    notes: countNotes(db),
  };
  report.files = countFiles(db);
  const open = countQuestions(db);
  const total = countQuestions(db, { includeDeferred: true });
  report.questions = { open, deferred: Math.max(0, total - open) };
  report.net_worth = getNetWorth(db);

  return report;
}

// Paths are home-relativized facts, not free text: only error prose and the
// user name can still carry PII by the time redaction runs.
const STATUS_REDACT_FIELDS = ["error", "user_name"] as const;

/** Redaction is on unless `--no-redact` explicitly turned it off, so bare `oled`
 *  (which has no such flag) masks the same fields `oled status` does. */
export async function showStatus(opts: { redact?: boolean } = {}): Promise<void> {
  let report = await buildReport();
  // Decided before redaction: the redacted report's paths and error prose are
  // display strings, not facts to branch on.
  const ledgerMissing = !report.db.reachable && !existsSync(config.dbPath);
  if (opts.redact !== false) {
    const { applyRedaction } = await import("../../privacy/redactor.js");
    report = applyRedaction(report, true, STATUS_REDACT_FIELDS);
  }
  const mode = currentMode();
  if (mode.json) {
    emit(report);
    return;
  }
  if (mode.tty) {
    renderTty(report, mode.color, ledgerMissing);
    return;
  }
  renderPlain(report);
}

function renderPlain(r: StatusReport): void {
  const lines: [string, string | number | boolean][] = [
    ["configured", r.configured],
    ["config_path", r.config_path],
    ["data_dir", r.data_dir],
    ["locale", r.locale],
    ["currency", r.currency],
    ["user_name", r.user_name],
    ["db_path", r.db.path],
    ["db_reachable", r.db.reachable],
  ];
  if (r.db.error) lines.push(["db_error", r.db.error]);
  if (r.counts) {
    lines.push(
      ["accounts", r.counts.accounts],
      ["transactions", r.counts.transactions],
      ["merchants", r.counts.merchants],
      ["notes", r.counts.notes],
    );
  }
  if (r.files) {
    lines.push(
      ["files_ingested", r.files.ingested],
      ["files_pending", r.files.pending],
      ["files_failed", r.files.failed],
    );
  }
  if (r.questions) {
    lines.push(
      ["questions_open", r.questions.open],
      ["questions_deferred", r.questions.deferred],
    );
  }
  if (r.net_worth) {
    lines.push(
      ["net_worth", r.net_worth.net_worth],
      ["assets", r.net_worth.assets],
      ["liabilities", r.net_worth.liabilities],
    );
  }
  process.stdout.write(lines.map(([k, v]) => `${k}\t${v}`).join("\n") + "\n");
}

const LABEL_WIDTH = 18;

/** Exported for the display test: this renderer runs only on a real TTY, so no
 *  subprocess suite can ever execute it. */
export function renderTty(r: StatusReport, color: boolean, ledgerMissing = false): void {
  const dim = (s: string) => (color ? chalk.dim(s) : s);
  const bold = (s: string) => (color ? chalk.bold.yellow(s) : s);

  const section = (title: string, rows: [string, string][]): void => {
    process.stdout.write(bold(title) + "\n");
    const valueWidth = Math.max(0, ...rows.map(([, v]) => visibleLength(v)));
    for (const [label, value] of rows) {
      const pad = " ".repeat(Math.max(0, valueWidth - visibleLength(value)));
      process.stdout.write(`  ${label.padEnd(LABEL_WIDTH)}${pad}${value}\n`);
    }
    process.stdout.write("\n");
  };

  process.stdout.write("\n" + (color ? banner() : stripBanner()) + "\n\n");

  section("System", [
    ["Configured", r.configured ? "yes" : dim("no")],
    ["User", dim(r.user_name)],
    ["Locale", dim(r.locale)],
    ["Currency", dim(r.currency)],
    ["Data dir", dim(r.data_dir)],
    [
      "Database",
      r.db.reachable ? "ready" : dim(r.db.error ? `not ready: ${r.db.error}` : "not ready"),
    ],
  ]);

  // status always exits 0, so an unreachable db needs a pointer to whatever
  // resolves it: creating the ledger, or diagnosing one that will not open.
  if (!r.db.reachable) {
    const next = ledgerMissing
      ? "run `oled config --init` to create one"
      : "run `oled doctor` for details";
    process.stdout.write(dim(`  ${next}`) + "\n\n");
  }

  if (r.counts) {
    section("Ledger", [
      ["Accounts", formatInt(r.counts.accounts)],
      ["Transactions", formatInt(r.counts.transactions)],
      ["Merchants", formatInt(r.counts.merchants)],
      ["Notes", formatInt(r.counts.notes)],
    ]);
  }

  if (r.files || r.questions) {
    const rows: [string, string][] = [];
    if (r.files) {
      const extras: string[] = [];
      if (r.files.pending > 0) extras.push(`${r.files.pending} pending`);
      if (r.files.failed > 0) extras.push(`${r.files.failed} failed`);
      rows.push([
        "Files",
        `${formatInt(r.files.ingested)}${extras.length ? "  " + dim(`(${extras.join(", ")})`) : ""}`,
      ]);
    }
    if (r.questions) {
      rows.push([
        "Questions",
        `${formatInt(r.questions.open)} open${r.questions.deferred ? "  " + dim(`(${r.questions.deferred} deferred)`) : ""}`,
      ]);
    }
    section("Pipeline", rows);
  }

  if (r.net_worth) {
    section("Financial", [
      ["Net worth", formatAmount(r.net_worth.net_worth)],
      ["Assets", dim(formatAmount(r.net_worth.assets))],
      ["Liabilities", dim(formatAmount(r.net_worth.liabilities))],
    ]);
  }
}

function stripBanner(): string {
  return banner().replace(ANSI_RE, "");
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Status: config, database, ledger counts, net worth")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(showStatus));
}
