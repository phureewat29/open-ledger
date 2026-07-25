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
export function padLabel(label: string, width: number, opts: { bold?: boolean } = {}): string {
  const padded = label.padEnd(width);
  return opts.bold ? chalk.bold(padded) : padded;
}

/**
 * Print flat key/value rows for human output: aligned two-column in a TTY
 * (labels bold when `bold`), tab-separated when piped. Never emits JSON — the
 * caller owns the `--json` path.
 */
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
    chalk.cyan("<°(((><  ") +
    chalk.bold("Plasalid") +
    chalk.dim("  ·  The Harness Layer for Personal Finance")
  );
}

const DISCLAIMER =
  "Plasalid is an assistant, it only summarizes financial statements — verify amounts against your statements before relying on them.";

const SCENARIO = [
  "Drop bank statements in a folder; your AI posts each row to a local encrypted ledger.",
  "Ask for net worth, spending, subscriptions, or debt payoff. Answers come from the ledger, not guesses.",
  "Every entry is double-entry and stays on your machine.",
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
    row("plasalid", "<command> [OPTIONS]"),
    row("plasalid", "Show harness status (default)"),
  ];

  return [
    "",
    banner(),
    "",
    section("Usage", usageLines),
    "",
    section("What it does", SCENARIO),
    "",
    section("Commands", commands.map((c) => row(c.name, c.desc))),
    "",
    section("Options", options.map((o) => row(o.name, o.desc))),
    "",
    chalk.dim(DISCLAIMER),
  ].join("\n");
}
