import chalk from "chalk";
import type { OutputMode } from "./output.js";

// eslint-disable-next-line no-control-regex
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

export function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Left-pad a key/value label to `width`, optionally bold (padding first so the ANSI codes don't count toward the width). */
function padLabel(label: string, width: number, opts: { bold?: boolean } = {}): string {
  const padded = label.padEnd(width);
  return opts.bold ? chalk.bold(padded) : padded;
}

/** Human output only (TTY: aligned two-column, piped: tab-separated); never emits JSON, the caller owns --json. */
export function printKeyValues(
  mode: OutputMode,
  rows: [string, string | number][],
  opts: { bold?: boolean } = {},
): void {
  if (!mode.tty) {
    process.stdout.write(rows.map(([k, v]) => `${k}\t${v}`).join("\n") + "\n");
    return;
  }
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    process.stdout.write(`${padLabel(k, width, { bold: !!opts.bold })}  ${v}\n`);
  }
}

export function banner(): string {
  return (
    chalk.bold("OpenLedger") +
    chalk.dim("  ·  The Harness Layer for Personal Finance")
  );
}

const DISCLAIMER =
  "OpenLedger is a tool, it only summarizes financial statements: verify amounts against your statements before relying on them.";

const SCENARIO = [
  "Place financial statements in a folder; your AI posts each row to a local ledger.",
  "Ask for net worth, spending, subscriptions, or debt payoff. Answers always come from the ledger.",
  "Every entry is double-entry and data stays safely on your machine.",
];

const CONTRACT = [
  "Exit codes: 0 ok · 1 error · 2 usage · 3 not ready · 4 input required · 5 not found · 6 invalid · 7 partial.",
  'Under --json every stdout line is one JSON object, and list reads end with a {"type":"summary"} row.',
  "Errors are one stderr JSON object with a hint; read output masks PII as [USER]/[CARD], masks are not data.",
];

function section(label: string, lines: string[]): string {
  return [chalk.bold.yellow(label), ...lines.map((l) => `  ${l}`)].join("\n");
}

export function helpScreen(
  commands: { name: string; desc: string }[],
  extraOptions: { name: string; desc: string }[] = [],
): string {
  const options: { name: string; desc: string }[] = [
    ...extraOptions,
    { name: "--version", desc: "Show the version and exit" },
    { name: "--help", desc: "Show this help screen" },
  ];
  const nameWidth = Math.max(
    ...commands.map((c) => c.name.length),
    ...options.map((o) => o.name.length),
  );
  const row = (name: string, desc: string) =>
    `${chalk.cyan(name.padEnd(nameWidth))}    ${chalk.dim(desc)}`;

  const usageLines = [
    row("oled", "<command> [OPTIONS]"),
  ];

  return [
    "",
    banner(),
    "",
    section("About", SCENARIO),
    "",
    section("Usage", usageLines),
    "",
    section("Commands", commands.map((c) => row(c.name, c.desc))),
    "",
    section("Options", options.map((o) => row(o.name, o.desc))),
    "",
    section("Contract", CONTRACT),
    "",
    chalk.dim(DISCLAIMER),
    "",
  ].join("\n");
}
