import chalk from "chalk";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { visibleLength, ANSI_RE } from "./format.js";
import { ValidationError } from "../lib/validate.js";
import { errorMessage } from "../lib/result.js";

/**
 * Shared output + error layer for the deterministic CLI harness.
 *
 * Output modes (resolved once per action, from flags + stdout TTY):
 *   --json           → NDJSON: emit() per record, emitSummary() to close a
 *                      stream; single-result commands call emit() once.
 *   TTY, no --json   → aligned human tables (chalk).
 *   piped, no --json → tab-separated plain text, zero ANSI.
 *
 * runAction() resolves and caches the mode before the action runs. emit/
 * emitSummary read it and no-op outside --json, so a stray call from a
 * command rendering its own human layout can't corrupt that output.
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

type ExitCode = keyof typeof EXIT;

export class CliError extends Error {
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

/** Throw a CliError. Never returns, so callers can use it as a value guard. */
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
  /** stdout is a TTY. */
  tty: boolean;
  /** apply chalk: TTY && !json && color not suppressed. */
  color: boolean;
}

/**
 * ORs the boolean flags across the whole ancestor chain: commander leaves a
 * global flag on whichever command level declared/consumed it, so walking up
 * finds it regardless of where in the chain it was passed.
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

/** Resolve, cache, and return the mode for a command (called by runAction). */
function getOutputMode(cmd?: Command): OutputMode {
  current = resolveMode(cmd);
  return current;
}

/** The mode resolved for the running action (lazily defaulted for direct calls). */
export function currentMode(): OutputMode {
  if (!current) current = resolveMode(undefined);
  return current;
}

function writeLine(stream: NodeJS.WriteStream, obj: unknown): void {
  stream.write(JSON.stringify(obj) + "\n");
}

/** One NDJSON object — a single result, or one record in a streamed list. No-op outside --json. */
export function emit(obj: unknown): void {
  if (currentMode().json) writeLine(process.stdout, obj);
}

/** Terminal `{"type":"summary",...}` for a streaming command. No-op outside --json. */
export function emitSummary(fields: Record<string, unknown> = {}): void {
  if (currentMode().json) writeLine(process.stdout, { type: "summary", ...fields });
}

export interface Column<T = unknown> {
  header: string;
  value: (row: T) => string;
  align?: "left" | "right";
}

/**
 * Render a list of rows in whatever the current mode is:
 *   --json → one NDJSON object per raw row (full fidelity; columns are ignored)
 *   TTY    → aligned table (chalk headers when color is enabled)
 *   piped  → tab-separated cells, one row per line, no ANSI
 */
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

/** JSON → one NDJSON object; human/plain → tab-separated key/value lines
 *  (ANSI-free, so it stays stable when piped). */
export function emitObject(obj: Record<string, unknown>): void {
  if (currentMode().json) {
    emit(obj);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
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

/** Guard a destructive command on an explicit --yes. */
export function requireYes(opts: { yes?: boolean }, what: string): void {
  if (!opts.yes) {
    fail("INPUT_REQUIRED", `${what} needs confirmation`, {
      hint: "re-run with --yes to proceed",
    });
  }
}

/** Read all of stdin (empty string when stdin is a TTY / no pipe). */
export async function readStdinToEnd(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read a secret from stdin, trimming a single trailing newline (CRLF-aware). */
export async function readSecretFromStdin(): Promise<string> {
  const raw = await readStdinToEnd();
  return raw.replace(/\r?\n$/, "");
}

/**
 * Reads a batch of JSON rows from stdin or a file, auto-detecting a JSON
 * array (first non-ws char is `[`) vs NDJSON. Parse failures raise CliError
 * USAGE with the offending 1-based line number. `inputPath` lets agents pass
 * a file instead of piping through a shell. Row validation is the caller's job.
 */
export async function readStdinBatch(inputPath?: string): Promise<unknown[]> {
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
    fail("USAGE", inputPath ? `no transaction data in ${inputPath}` : "no transaction data on stdin");

  if (firstNonWs[0] === "[") {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) fail("USAGE", "stdin JSON must be an array of transactions");
      return parsed;
    } catch (err) {
      if (err instanceof CliError) throw err;
      fail("USAGE", `invalid JSON array on stdin: ${(err as Error).message}`);
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
      fail("USAGE", `invalid JSON on line ${i + 1}: ${(err as Error).message}`, {
        details: { line: i + 1 },
      });
    }
  }
  return out;
}

/** Narrow an unknown batch item (from `readStdinBatch`) to a plain JSON
 *  object, or null if it isn't one. Shared by every batch-loop command
 *  (`ingest commit`, `accounts create --input`, …). */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const NOT_READY_PATTERNS = [
  "failed to open database",
  "wrong encryption key",
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

/** Normalise any thrown value into a CliError (mapping DB-open failures to NOT_READY,
 *  and src/lib/validate.ts's ValidationError to USAGE). */
function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof ValidationError) return new CliError("USAGE", err.message);
  if (isNotReadyError(err)) {
    return new CliError("NOT_READY", (err as Error).message, {
      hint: "run `oled config --generate-key` to configure the harness",
    });
  }
  return new CliError("GENERIC", errorMessage(err));
}

/** Shared not-found/invalid mapper for domain errors thrown as plain `Error`s:
 *  a "not found" message (or one matching `extraNotFound`) maps to NOT_FOUND,
 *  everything else maps to INVALID. */
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
 * Wraps a commander `.action()` handler: resolves the output mode from the
 * command (commander's last positional arg), then maps a thrown error to its
 * exit code. Sets `process.exitCode` rather than calling `process.exit` so
 * buffered stdout/stderr flush before the process ends.
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
