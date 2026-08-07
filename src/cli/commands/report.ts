import type { Command } from "commander";
import { getPeriodTotals, subtractTotals } from "../../accounts/balances.js";
import { printKeyValues } from "../format.js";
import { openDb } from "../db.js";
import { requireConfig } from "./config.js";
import { currentMode, emit, fail, runAction } from "../output.js";
import { toDecimalTotals } from "../currency.js";
import { ISO_DATE_RE } from "../../lib/date.js";

interface ShowReportOpts {
  from?: string;
  to?: string;
}

async function showReport(opts: ShowReportOpts, command: Command): Promise<void> {
  if (!opts.from || !opts.to) fail("USAGE", "--from and --to are required");
  if (!ISO_DATE_RE.test(opts.from)) {
    fail("USAGE", `--from must be an ISO date (YYYY-MM-DD), got "${opts.from}"`);
  }
  if (!ISO_DATE_RE.test(opts.to)) {
    fail("USAGE", `--to must be an ISO date (YYYY-MM-DD), got "${opts.to}"`);
  }

  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  const totals = getPeriodTotals(db, opts.from, opts.to);
  // Net is taken in minor units per currency before anything becomes decimal; a THB
  // income and a USD expense share no common net.
  const result = {
    from: opts.from,
    to: opts.to,
    income: toDecimalTotals(totals.income),
    expenses: toDecimalTotals(totals.expenses),
    net: toDecimalTotals(subtractTotals(totals.income, totals.expenses)),
  };
  const mode = currentMode();
  if (mode.json) {
    emit(result);
    return;
  }
  const rows: [string, string | number][] = [
    ["from", result.from],
    ["to", result.to],
  ];
  for (const [label, amounts] of [
    ["income", result.income],
    ["expenses", result.expenses],
    ["net", result.net],
  ] as const) {
    for (const [currency, amount] of Object.entries(amounts)) {
      rows.push([`${label}.${currency}`, amount]);
    }
  }
  printKeyValues(mode, rows, { bold: mode.color });
}

export function registerReport(program: Command): void {
  program
    .command("report")
    .description("Income, expenses, and networth")
    .option("--from <date>", "start date")
    .option("--to <date>", "end date")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: sums income, expenses, and networth over a date range. For net worth use oled status.",
        "Typical flow: both dates are required and ISO (YYYY-MM-DD).",
        "Example: oled report --from 2025-01-01 --to 2025-03-31 --json",
      ].join("\n"),
    )
    .action(runAction(showReport));
}
