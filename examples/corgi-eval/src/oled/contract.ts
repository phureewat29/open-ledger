/**
 * oled's side of the contract: the exit codes its reporter uses, the error copy
 * the host reads back, and the flags the host appends to every call. Friction
 * and diagnosis both read these rows: holding them in one module is what stops
 * the two tables from drifting apart.
 */

/** Mirrors `EXIT` in oled's `src/cli/output.ts`. */
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

export type ExitName = keyof typeof EXIT;

/** Every code but OK, so a table over failures is exhaustive by construction. */
export type FailedExit = Exclude<ExitName, "OK">;

/** A code keyed by name, for a table that is written by name and read by code. */
export function byExitCode<T>(table: Record<FailedExit, T>): Map<number, T> {
  const out = new Map<number, T>();
  for (const [name, value] of Object.entries(table)) out.set(EXIT[name as FailedExit], value);
  return out;
}

/** PARTIAL did some of the work: like OK, its output is there to be read. */
export function carriesOutput(exitCode: number | null): boolean {
  return exitCode === EXIT.OK || exitCode === EXIT.PARTIAL;
}

/**
 * Appended to every call, so the model never has to ask for them, which is
 * also why hint scoring cannot judge a hint that names one.
 */
export const HOST_APPENDED_FLAGS = ["--json"];

/** What oled's error copy says the model got wrong. */
export type ErrorShape = "unknown_flag" | "unknown_command" | "flag_value";

export interface ErrorMatch {
  shape: ErrorShape;
  /** Verbatim, as the model asked for it. */
  asked: string;
}

interface ErrorRule {
  shape: ErrorShape;
  pattern: RegExp;
  asked: (match: RegExpExecArray) => string;
}

/**
 * Matched against oled's own message, not the arguments: a false reading is
 * worse than a missed one. Lenient about the punctuation around the name, so
 * one row reads commander's plain text and the reporter's JSON line.
 */
const ERROR_RULES: ErrorRule[] = [
  {
    shape: "unknown_flag",
    pattern: /unknown option[:\s]+'?(--[a-z0-9-]+)/i,
    asked: (match) => match[1] ?? "",
  },
  {
    shape: "unknown_command",
    pattern: /unknown command[:\s]+'?([a-z0-9:_-]+)/i,
    asked: (match) => match[1] ?? "",
  },
  {
    // Both forms the CLI writes: `(got "x")` and `, got "x"`. A flag left
    // without a value lands here too, having swallowed the next token.
    shape: "flag_value",
    pattern: /(--[a-z0-9-]+) must be .*?[(,]\s*got "([^"]+)"/i,
    asked: (match) => `${match[1]} ${match[2]}`,
  },
];

/** oled's `--json` errors arrive as a JSON line, so the quotes inside are escaped. */
export function plainMessage(message: string): string {
  return message.replace(/\\"/g, '"');
}

export function errorShapeOf(message: string): ErrorMatch | null {
  const text = plainMessage(message);
  for (const rule of ERROR_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const asked = rule.asked(match);
    if (asked) return { shape: rule.shape, asked };
  }
  return null;
}
