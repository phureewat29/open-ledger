import type { Command } from "commander";
import chalk from "chalk";
import { config, getConfigPath, getDataDir, keyFingerprint } from "../../config.js";
import { existsSync } from "fs";
import { formatAmount } from "../currency.js";
import { banner, visibleLength, ANSI_RE, formatInt } from "../format.js";
import { currentMode, emit, runAction } from "../output.js";
import { tryExecute } from "../../lib/result.js";
import { openDb } from "../db.js";

interface Counts {
  accounts: number;
  transactions: number;
  merchants: number;
  notes: number;
}

interface StatusReport {
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
    encrypted: boolean;
    key_fingerprint: string | null;
    error: string | null;
  };
  counts: Counts | null;
  files: { ingested: number; pending: number; failed: number } | null;
  questions: { open: number; deferred: number } | null;
  net_worth: { assets: number; liabilities: number; net_worth: number } | null;
}

async function buildReport(): Promise<StatusReport> {
  const report: StatusReport = {
    type: "status",
    configured: existsSync(getConfigPath()) || existsSync(config.dbPath),
    config_path: getConfigPath(),
    data_dir: getDataDir(),
    locale: config.displayLocale,
    currency: config.displayCurrency,
    user_name: config.userName,
    db: {
      path: config.dbPath,
      reachable: false,
      encrypted: !!config.dbEncryptionKey,
      key_fingerprint: config.dbEncryptionKey ? keyFingerprint(config.dbEncryptionKey) : null,
      error: null,
    },
    counts: null,
    files: null,
    questions: null,
    net_worth: null,
  };

  // Deferred so non-db commands skip the libsql cost at startup.
  const { getNetWorth } = await import("../../accounts/balances.js");
  const { countAccounts } = await import("../../accounts/accounts.js");
  const { countTransactions } = await import("../../db/queries/transactions.js");
  const { countFiles } = await import("../../db/queries/files.js");
  const { countQuestions } = await import("../../db/queries/questions.js");
  const { countMerchants } = await import("../../db/queries/merchants.js");
  const { countNotes } = await import("../../db/queries/notes.js");

  // The only reachability probe is opening the db: an unconfigured/wrong-key/
  // unreadable db degrades to not-ready here. Counts run AFTER, outside the
  // probe, so a bug in a query surfaces as a real error (via runAction) rather
  // than masquerading as an unreachable database.
  const opened = await tryExecute(() => openDb());
  if (!opened.ok) {
    report.db.error = opened.error;
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

// Free-text / path fields in a StatusReport that can leak the user's name or
// home directory. Counts, booleans, and net-worth numbers are left verbatim.
const STATUS_REDACT_FIELDS = ["config_path", "data_dir", "path", "error", "user_name"] as const;

export async function showStatus(opts: { redact?: boolean } = {}): Promise<void> {
  let report = await buildReport();
  if (opts.redact) {
    const { applyRedaction } = await import("../../privacy/redactor.js");
    report = applyRedaction(report, true, STATUS_REDACT_FIELDS);
  }
  const mode = currentMode();
  if (mode.json) {
    emit(report);
    return;
  }
  if (mode.tty) {
    renderTty(report, mode.color);
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
    ["db_encrypted", r.db.encrypted],
    ["db_key_fingerprint", r.db.key_fingerprint ?? "not set"],
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

function renderTty(r: StatusReport, color: boolean): void {
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
      r.db.reachable
        ? `ready${r.db.encrypted ? dim(" (encrypted)") : ""}`
        : dim(r.db.error ? `not ready — ${r.db.error}` : "not ready"),
    ],
    ["Key", r.db.key_fingerprint ? dim(r.db.key_fingerprint) : dim("not set")],
  ]);

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
