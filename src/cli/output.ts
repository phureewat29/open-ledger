import chalk from "chalk";
import { omit } from "es-toolkit";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { visibleLength, ANSI_RE } from "./format.js";
import { ValidationError } from "../lib/validate.js";
import { errorMessage } from "../lib/result.js";
import { DBNotReadyError } from "../db/errors.js";
import type { AccountFailure } from "../accounts/accounts.js";

/** emit()/emitSummary() no-op outside --json; use emitObject() for a single result instead. */

export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  NOT_READY: 3,
  INPUT_REQUIRED: 4,
  NOT_FOUND: 5,
  INVALID: 6,
  PARTIAL: 7,
} as const;

export type ExitCode = keyof typeof EXIT;

// Not exported: fail() is the only construction site for CLIError.
class CLIError extends Error {
  readonly code: ExitCode;
  readonly hint?: string;
  readonly details?: unknown;
  constructor(
    code: ExitCode,
    message: string,
    opts?: { hint?: string; details?: unknown },
  ) {
    super(message);
    this.name = "CLIError";
    this.code = code;
    this.hint = opts?.hint;
    this.details = opts?.details;
  }
}

export function fail(
  code: ExitCode,
  message: string,
  opts?: { hint?: string; details?: unknown },
): never {
  throw new CLIError(code, message, opts);
}

export interface OutputMode {
  /** --json was set anywhere in the command chain. */
  json: boolean;
  /** color is suppressed (--no-color, NO_COLOR env, non-TTY, or --json). */
  noColor: boolean;
  tty: boolean;
  color: boolean;
}

// ORs flags across the ancestor chain: commander leaves a global flag wherever it was consumed.
function resolveMode(cmd?: Command): OutputMode {
  let json = false;
  let noColorFlag = false;
  let c: Command | undefined = cmd;
  while (c) {
    const o = c.opts();
    if (o.json) json = true;
    if (o.color === false) noColorFlag = true;
    c = c.parent ?? undefined;
  }
  const tty = !!process.stdout.isTTY;
  const envNoColor = !!process.env.NO_COLOR;
  const noColor = json || noColorFlag || envNoColor || !tty;
  return { json, noColor, tty, color: !noColor };
}

let current: OutputMode | null = null;

function getOutputMode(cmd?: Command): OutputMode {
  current = resolveMode(cmd);
  return current;
}

export function currentMode(): OutputMode {
  if (!current) current = resolveMode(undefined);
  return current;
}

// libsql attaches `_metadata: { duration }` to every `.get()` row; stripped once here.
// `.all()` rows carry no `_metadata`, so nested arrays don't need it.
function stripMetadata<T>(value: T): T {
  if (value === null || typeof value !== "object" || !("_metadata" in value)) return value;
  return omit(value as Record<string, unknown>, ["_metadata"]) as T;
}

function writeLine(stream: NodeJS.WriteStream, obj: unknown): void {
  stream.write(JSON.stringify(stripMetadata(obj)) + "\n");
}

export function emit(obj: unknown): void {
  if (currentMode().json) writeLine(process.stdout, obj);
}

/** Terminal `{"type":"summary",...}` for a streaming command. */
export function emitSummary(fields: Record<string, unknown> = {}): void {
  if (currentMode().json) writeLine(process.stdout, { type: "summary", ...fields });
}

/** The summary a capped list ends with; the fields a pager loops on. */
export function emitCappedSummary(
  total: number,
  returned: number,
  limit: number,
  offset: number,
): void {
  emitSummary({ total, returned, has_more: offset + returned < total, limit, offset });
}

export interface Column<T = unknown> {
  header: string;
  value: (row: T) => string;
  align?: "left" | "right";
}

export function emitList<T>(rows: T[], columns: Column<T>[]): void {
  const m = currentMode();
  if (m.json) {
    for (const row of rows) writeLine(process.stdout, row);
    return;
  }
  if (m.tty) {
    renderTable(rows, columns, m.color);
    return;
  }
  renderPlain(rows, columns);
}

/** Human/plain output is tab-separated key/value lines, ANSI-free so it stays stable when piped. */
export function emitObject(obj: Record<string, unknown>): void {
  const row = stripMetadata(obj);
  if (currentMode().json) {
    emit(row);
    return;
  }
  for (const [k, v] of Object.entries(row)) {
    const s = v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
    process.stdout.write(`${k}\t${s}\n`);
  }
}

function renderPlain<T>(rows: T[], columns: Column<T>[]): void {
  const lines = rows.map((row) =>
    columns.map((c) => c.value(row).replace(ANSI_RE, "")).join("\t"),
  );
  if (lines.length) process.stdout.write(lines.join("\n") + "\n");
}

function renderTable<T>(rows: T[], columns: Column<T>[], color: boolean): void {
  const cells = rows.map((row) => columns.map((c) => c.value(row)));
  const widths = columns.map((c, i) =>
    Math.max(visibleLength(c.header), ...cells.map((r) => visibleLength(r[i]))),
  );
  const pad = (s: string, width: number, align: Column<T>["align"]): string => {
    const gap = " ".repeat(Math.max(0, width - visibleLength(s)));
    return align === "right" ? gap + s : s + gap;
  };
  const header = columns
    .map((c, i) => pad(color ? chalk.bold(c.header) : c.header, widths[i], c.align))
    .join("  ")
    .trimEnd();
  const out = [header];
  for (const r of cells) {
    out.push(columns.map((c, i) => pad(r[i], widths[i], c.align)).join("  ").trimEnd());
  }
  process.stdout.write(out.join("\n") + "\n");
}

export function requireYes(opts: { yes?: boolean }, what: string): void {
  if (!opts.yes) {
    fail("INPUT_REQUIRED", `${what} needs confirmation`, {
      hint: "re-run with --yes to proceed",
    });
  }
}

// Redaction is on unless --no-redact set opts.redact === false; it's undefined for a
// direct call, so `!!opts.redact` reads backwards.
export function redactionEnabled(opts: { redact?: boolean }): boolean {
  return opts.redact !== false;
}

/** Empty string when stdin is a TTY (no pipe). */
async function readStdinToEnd(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Reads `--input <file>` or stdin, auto-detecting a JSON array (leading `[`) vs NDJSON.
// Row validation is the caller's job.
export async function readStdinBatch(inputPath?: string): Promise<unknown[]> {
  const from = inputPath ?? "stdin";
  let source: string;
  if (inputPath) {
    try {
      source = readFileSync(inputPath, "utf8");
    } catch (err) {
      fail("NOT_FOUND", `cannot read --input file: ${(err as Error).message}`, {
        hint: "pass a readable NDJSON (or JSON array) file path",
      });
    }
  } else {
    source = await readStdinToEnd();
  }
  const raw = source.replace(/^\uFEFF/, "");
  const firstNonWs = raw.match(/\S/);
  if (!firstNonWs)
    fail("USAGE", `${from}: no rows`, {
      hint: "pass NDJSON rows via --input <file> or pipe them on stdin",
    });

  if (firstNonWs[0] === "[") {
    try {
      return JSON.parse(raw) as unknown[];
    } catch (err) {
      fail("USAGE", `${from}: invalid JSON array: ${(err as Error).message}`);
    }
  }

  const out: unknown[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      fail("USAGE", `${from}: invalid JSON on line ${i + 1}: ${(err as Error).message}`, {
        details: { line: i + 1 },
      });
    }
  }
  return out;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function toCLIError(err: unknown): CLIError {
  if (err instanceof CLIError) return err;
  if (err instanceof ValidationError) {
    return new CLIError("USAGE", err.message, {
      hint: "append --help to the command for its flags and usage",
    });
  }
  if (err instanceof DBNotReadyError) {
    return new CLIError("NOT_READY", err.message, {
      hint: "run `oled config --init` to configure the harness",
    });
  }
  return new CLIError("GENERIC", errorMessage(err));
}

// Record<Union, ExitCode> fails the build if a reason case is unhandled.
export const REASON_EXIT: Record<AccountFailure, ExitCode> = {
  account_exists: "INVALID",
  parent_not_found: "NOT_FOUND",
  invalid_hierarchy: "INVALID",
};

export function failReason(
  failure: { reason: AccountFailure; message: string },
  hint?: string,
): never {
  fail(REASON_EXIT[failure.reason], failure.message, hint === undefined ? undefined : { hint });
}

// Matches error message text, for throw sites that use a plain `Error` instead of a typed reason.
export function mapNotFoundError(err: unknown): never {
  const message = errorMessage(err);
  if (/not found|does not exist/i.test(message)) {
    fail("NOT_FOUND", message);
  }
  fail("INVALID", message);
}

function reportError(err: unknown): number {
  const cliErr = toCLIError(err);
  if (currentMode().json) {
    const payload: Record<string, unknown> = {
      code: `E_${cliErr.code}`,
      message: cliErr.message,
    };
    if (cliErr.hint !== undefined) payload.hint = cliErr.hint;
    if (cliErr.details !== undefined) payload.details = cliErr.details;
    process.stderr.write(JSON.stringify({ error: payload }) + "\n");
  } else {
    process.stderr.write(`error: ${cliErr.message}\n`);
    if (cliErr.hint) process.stderr.write(`hint: ${cliErr.hint}\n`);
  }
  return EXIT[cliErr.code];
}

// Commander aborts at parse before any action runs, so `--json` may still be unparsed here; argv is the only signal left.
export function jsonRequested(): boolean {
  return process.argv.includes("--json");
}

export function reportParseError(err: unknown): void {
  current = { json: jsonRequested(), noColor: true, tty: !!process.stdout.isTTY, color: false };
  process.exitCode = reportError(err);
}

// Sets process.exitCode rather than calling process.exit so buffered stdout/stderr flush before exit.
export function runAction<A extends unknown[]>(
  fn: (...args: A) => unknown | Promise<unknown>,
): (...args: A) => Promise<void> {
  return async (...args: A): Promise<void> => {
    const last = args[args.length - 1];
    getOutputMode(last instanceof Command ? last : undefined);
    try {
      await fn(...args);
    } catch (err) {
      process.exitCode = reportError(err);
    }
  };
}
