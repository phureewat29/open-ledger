import type { Command } from "commander";
import chalk from "chalk";
import { uniq } from "es-toolkit";
import { getNetWorth } from "../../accounts/balances.js";
import type { ResolvedConfig } from "../../config.js";
import { countAccounts } from "../../db/queries/accounts.js";
import { countFiles } from "../../db/queries/files.js";
import { countMerchants } from "../../db/queries/merchants.js";
import { countNotes } from "../../db/queries/notes.js";
import { countQuestions } from "../../db/queries/questions.js";
import { countTransactions } from "../../db/queries/transactions.js";
import { countNewFiles } from "../../ingest/prepare.js";
import { applyRedaction } from "../../privacy/redactor.js";
import { existsSync } from "fs";
import { homedir } from "os";
import { sep } from "path";
import { formatAmount, toDecimalTotals } from "../currency.js";
import { banner, visibleLength, ANSI_RE, formatInt } from "../format.js";
import { currentMode, emit, redactionEnabled, runAction } from "../output.js";
import { tryExecute } from "../../lib/result.js";
import { lenientConfig } from "./config.js";
import { openDb } from "../db.js";

// Error prose passes through unchanged, so this is safe on any field.
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
  /** Always present: `new` counts unregistered data-dir files, the "is there work waiting?" answer. */
  files: { new: number; ingested: number; pending: number; failed: number };
  questions: { open: number; deferred: number } | null;
  // Keys are currencies with an asset/liability account (report's are currencies
  // with legs in range), so an untouched ledger still reports {"THB":0}.
  net_worth: {
    assets: Record<string, number>;
    liabilities: Record<string, number>;
    net_worth: Record<string, number>;
  } | null;
}

/** `status` never creates the ledger, so a missing db file is reported, not opened. */
const NO_LEDGER = "no ledger yet";

async function buildReport(cfg: ResolvedConfig): Promise<StatusReport> {
  const report: StatusReport = {
    type: "status",
    // `configured` means a converge has run (`oled config --init`); a db file alone doesn't imply that.
    configured: cfg.exists,
    // Home-relative so no output carries the OS account name; `--config` expands
    // `~` back, so what status prints is still usable as input.
    config_path: homeRelative(cfg.configPath),
    data_dir: homeRelative(cfg.dataDir),
    locale: cfg.displayLocale,
    currency: cfg.displayCurrency,
    user_name: cfg.userName,
    db: {
      path: homeRelative(cfg.dbPath),
      reachable: false,
      error: null,
    },
    counts: null,
    files: { new: 0, ingested: 0, pending: 0, failed: 0 },
    questions: null,
    net_worth: null,
  };

  // openDb() would migrate a missing file into existence, so check existsSync first.
  if (!existsSync(cfg.dbPath)) {
    report.db.error = NO_LEDGER;
    // Nothing is registered without a ledger, so every readable file is new.
    report.files.new = countNewFiles(null, cfg.dataDir);
    return report;
  }

  // Opening the db is the only reachability check; a failing count query must not read as not-ready.
  const opened = await tryExecute(() => openDb(cfg.dbPath));
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
  report.files = { new: countNewFiles(db, cfg.dataDir), ...countFiles(db) };
  const open = countQuestions(db);
  const total = countQuestions(db, { includeDeferred: true });
  report.questions = { open, deferred: Math.max(0, total - open) };
  const worth = getNetWorth(db);
  report.net_worth = {
    assets: toDecimalTotals(worth.assets),
    liabilities: toDecimalTotals(worth.liabilities),
    net_worth: toDecimalTotals(worth.net_worth),
  };

  return report;
}

// Paths are home-relativized facts, not free text; only error prose and user_name can still carry PII.
const STATUS_REDACT_FIELDS = ["error", "user_name"] as const;

// Redaction defaults on, so bare `oled` (no --no-redact flag) masks the same fields `status` does.
export async function showStatus(opts: { redact?: boolean }, command: Command): Promise<void> {
  const { config: cfg } = lenientConfig(command);
  let report = await buildReport(cfg);
  // Decided before redaction: paths and error prose are display strings, not facts to branch on.
  const ledgerMissing = !report.db.reachable && !existsSync(cfg.dbPath);
  if (redactionEnabled(opts)) {
    report = applyRedaction(report, true, STATUS_REDACT_FIELDS, {
      userName: cfg.userName,
      contextPath: cfg.contextPath,
    });
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
  lines.push(
    ["files_new", r.files.new],
    ["files_ingested", r.files.ingested],
    ["files_pending", r.files.pending],
    ["files_failed", r.files.failed],
  );
  if (r.questions) {
    lines.push(
      ["questions_open", r.questions.open],
      ["questions_deferred", r.questions.deferred],
    );
  }
  if (r.net_worth) {
    // One key per currency, never a scalar: different currencies must not be added together.
    for (const [label, totals] of Object.entries(r.net_worth)) {
      for (const [currency, amount] of Object.entries(totals)) {
        lines.push([`${label}.${currency}`, amount]);
      }
    }
  }
  process.stdout.write(lines.map(([k, v]) => `${k}\t${v}`).join("\n") + "\n");
}

const LABEL_WIDTH = 18;

// Exported for the display test: this renderer only runs on a real TTY, so no subprocess suite executes it.
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

  // status always exits 0, so an unreachable db needs its own pointer to what resolves it.
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

  const fileExtras: string[] = [];
  if (r.files.new > 0) fileExtras.push(`${r.files.new} new`);
  if (r.files.pending > 0) fileExtras.push(`${r.files.pending} pending`);
  if (r.files.failed > 0) fileExtras.push(`${r.files.failed} failed`);

  const pipeline: [string, string][] = [
    [
      "Files",
      `${formatInt(r.files.ingested)}${fileExtras.length ? "  " + dim(`(${fileExtras.join(", ")})`) : ""}`,
    ],
  ];
  if (r.questions) {
    pipeline.push([
      "Questions",
      `${formatInt(r.questions.open)} open${r.questions.deferred ? "  " + dim(`(${r.questions.deferred} deferred)`) : ""}`,
    ]);
  }
  section("Pipeline", pipeline);

  const financial = r.net_worth ? financialRows(r.net_worth, dim, r.locale) : [];
  if (financial.length) section("Financial", financial);
}

// Ledgers in ISO order; each amount formats in its own currency, not the display currency.
function financialRows(
  worth: NonNullable<StatusReport["net_worth"]>,
  dim: (s: string) => string,
  locale: string,
): [string, string][] {
  const currencies = uniq([
    ...Object.keys(worth.net_worth),
    ...Object.keys(worth.assets),
    ...Object.keys(worth.liabilities),
  ]).sort();

  const rows: [string, string][] = [];
  for (const currency of currencies) {
    const amount = (totals: Record<string, number>): string =>
      formatAmount(totals[currency] ?? 0, currency, locale);
    rows.push(
      [`${currency} net worth`, amount(worth.net_worth)],
      [`${currency} assets`, dim(amount(worth.assets))],
      [`${currency} liabilities`, dim(amount(worth.liabilities))],
    );
  }
  return rows;
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
