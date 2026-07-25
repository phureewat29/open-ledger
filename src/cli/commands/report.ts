import type { Command } from "commander";
import { printKeyValues } from "../format.js";
import { openDb } from "../db.js";
import { currentMode, emit, fail, runAction } from "../output.js";
import { ISO_DATE_RE } from "../../lib/date.js";

interface ShowReportOpts {
  from?: string;
  to?: string;
}

async function showReport(opts: ShowReportOpts): Promise<void> {
  if (!opts.from || !opts.to) fail("USAGE", "--from and --to are required");
  if (!ISO_DATE_RE.test(opts.from)) {
    fail("USAGE", `--from must be an ISO date (YYYY-MM-DD), got "${opts.from}"`);
  }
  if (!ISO_DATE_RE.test(opts.to)) {
    fail("USAGE", `--to must be an ISO date (YYYY-MM-DD), got "${opts.to}"`);
  }

  const { getPeriodTotals } = await import("../../accounts/balances.js");
  const db = await openDb();
  const totals = getPeriodTotals(db, opts.from, opts.to);
  const result = {
    from: opts.from,
    to: opts.to,
    income: totals.income,
    expenses: totals.expenses,
    net: totals.income - totals.expenses,
  };
  const mode = currentMode();
  if (mode.json) {
    emit(result);
    return;
  }
  printKeyValues(
    mode,
    [
      ["from", result.from],
      ["to", result.to],
      ["income", result.income],
      ["expenses", result.expenses],
      ["net", result.net],
    ],
    { bold: mode.color },
  );
}

export function registerReport(program: Command): void {
  program
    .command("report")
    .description("Income, expenses, and net")
    .option("--from <date>", "start date")
    .option("--to <date>", "end date")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: sums income, expenses, and net over a date range. For net worth use plasalid status.",
        "Typical flow: both dates are required and ISO (YYYY-MM-DD).",
        "Example: plasalid report --from 2025-01-01 --to 2025-03-31 --json",
      ].join("\n"),
    )
    .action(runAction(showReport));
}
