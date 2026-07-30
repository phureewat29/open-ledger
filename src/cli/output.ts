import chalk from "chalk";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { visibleLength, ANSI_RE } from "./format.js";
import { ValidationError } from "../lib/validate.js";
import { errorMessage } from "../lib/result.js";

/**
 * emit()/emitSummary() no-op outside --json, so a stray call from a command's
 * human layout can't corrupt it. A single-result command should use
 * emitObject() instead, which renders in every mode.
 */

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

class CliError extends Error {
  readonly code: ExitCode;
  readonly hint?: string;
  readonly details?: unknown;
  constructor(
    code: ExitCode,
    message: string,
    opts?: { hint?: string; details?: unknown },
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.hint = opts?.hint;
    this.details = opts?.details;
  }
}

/** Never returns, so callers can use it as a value guard. */
export function fail(
  code: ExitCode,
  message: string,
  opts?: { hint?: string; details?: unknown },
): never {
  throw new CliError(code, message, opts);
}

export interface OutputMode {
  /** --json was set anywhere in the command chain. */
  json: boolean;
  /** color is suppressed (--no-color, NO_COLOR env, non-TTY, or --json). */
  noColor: boolean;
  tty: boolean;
  color: boolean;
}

/**
 * ORs flags across the whole ancestor chain: commander leaves a global flag
 * on whichever level declared/consumed it, so walking up finds it regardless.
 */
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

/** The mode resolved for the running action (lazily defaulted for direct calls). */
export function currentMode(): OutputMode {
  if (!current) current = resolveMode(undefined);
  return current;
}

/**
 * libsql attaches `_metadata: { duration }` to every `.get()` row, so any
 * command that spreads a row into its payload would publish it. Stripped once
 * here at the boundary rather than at 39 query sites. Top level only: `.all()`
 * rows carry no `_metadata`, so nested arrays never need it.
 */
function stripMetadata<T>(value: T): T {
  if (value === null || typeof value !== "object" || !("_metadata" in value)) return value;
  const rest = { ...(value as Record<string, unknown>) };
  delete rest._metadata;
  return rest as T;
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

/** Empty string when stdin is a TTY (no pipe). */
async function readStdinToEnd(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads batch rows from `--input <file>` or stdin: the CLI's only stdin
 * read, kept because batches outgrow argv. Auto-detects a JSON array (first
 * non-ws char is `[`) vs NDJSON; row validation is the caller's job.
 */
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

const NOT_READY_PATTERNS = [
  "failed to open database",
  "corrupt database",
  "not a database",
  "file is encrypted",
  "not configured",
  "not an openledger database",
];

function isNotReadyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  return NOT_READY_PATTERNS.some((p) => msg.includes(p));
}

function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof ValidationError) {
    return new CliError("USAGE", err.message, {
      hint: "append --help to the command for its flags and usage",
    });
  }
  if (isNotReadyError(err)) {
    return new CliError("NOT_READY", (err as Error).message, {
      hint: "run `oled config --init` to configure the harness",
    });
  }
  return new CliError("GENERIC", errorMessage(err));
}

/** Domain errors are thrown as plain `Error`s, so they're matched by message, not type. */
export function mapNotFoundError(err: unknown, extraNotFound?: RegExp): never {
  const message = errorMessage(err);
  if (/not found/i.test(message) || (extraNotFound && extraNotFound.test(message))) {
    fail("NOT_FOUND", message);
  }
  fail("INVALID", message);
}

function reportError(err: unknown): number {
  const cliErr = toCliError(err);
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

/**
 * At the parse boundary commander aborts before any action runs, so nothing
 * resolved the mode and `--json` may still be unparsed, so argv is the only
 * signal left.
 */
export function jsonRequested(): boolean {
  return process.argv.includes("--json");
}

export function reportParseError(err: unknown): void {
  current = { json: jsonRequested(), noColor: true, tty: !!process.stdout.isTTY, color: false };
  process.exitCode = reportError(err);
}

/**
 * The command is commander's last positional arg. Sets `process.exitCode` rather
 * than calling `process.exit` so buffered stdout/stderr flush before the process ends.
 */
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
