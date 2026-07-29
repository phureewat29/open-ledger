import { byExitCode, errorShapeOf, HOST_APPENDED_FLAGS } from "../oled/contract.js";
import type { PhaseId, RunEvent, ToolObservation } from "./events.js";

/**
 * Not pass/fail: a diagnostic feed for changing the CLI. Every item keeps
 * enough context to read as "the model tried X, oled said Y, then did Z".
 */

type FrictionType =
  | "unknown_flag"
  | "unknown_command"
  /** A flag that exists, given a value oled rejects — or left empty, swallowing the next token. */
  | "flag_value"
  | "usage_error"
  | "not_ready"
  | "input_required"
  | "not_found"
  | "invalid"
  /** The command did part of the work: a commit with failed rows, or a document missing OCR pages. */
  | "partial"
  | "command_error"
  | "bad_tool_args"
  | "unknown_tool"
  | "refused_shell"
  | "refused_placeholder"
  | "refused_command"
  | "bad_date_format"
  | "missed_hint"
  /** Matches nothing above; reported as itself so a taxonomy gap stays visible. */
  | "unknown";

/**
 * `same_turn` isn't an outcome but the absence of one: every other attempt at
 * this subcommand was dispatched before this result existed, so none of them
 * can show whether the error copy taught anything.
 */
type RecoveryOutcome = "recovered" | "repeated" | "changed" | "abandoned" | "same_turn";

interface NextAttempt {
  command: string;
  args: string;
  ok: boolean;
  message: string;
  followedHint: boolean;
}

export interface FrictionItem {
  type: FrictionType;
  phase: PhaseId;
  turn: number;
  tool: string;
  subcommand: string;
  args: string;
  command: string;
  exitCode: number | null;
  message: string;
  hint: string | null;
  /** In a LATER turn only; null when there was none. */
  next: NextAttempt | null;
  /** null when the call succeeded and the friction is misuse rather than failure. */
  recovery: RecoveryOutcome | null;
}

interface TypeCount {
  type: FrictionType;
  count: number;
}

interface Recovery {
  rows: RecoveryRow[];
  encountered: number;
  /** Failures with a later turn to answer them: the rate's denominator. */
  judged: number;
  /** Failures whose only other attempts shared their turn, so no answer was possible. */
  sameTurn: number;
  recovered: number;
  /** recovered / judged, null when nothing could be judged. */
  rate: number | null;
}

/** One row per friction type; the five outcome counts add up to `encountered`. */
interface RecoveryRow {
  type: FrictionType;
  encountered: number;
  recovered: number;
  repeated: number;
  changed: number;
  abandoned: number;
  sameTurn: number;
}

/** One row per subcommand touched — the unit for changing the CLI. */
export interface SubcommandRow {
  subcommand: string;
  calls: number;
  /** Of those, calls that asked for `--help`. Reported, never scored. */
  help: number;
  failures: number;
  types: TypeCount[];
  /** Failures where oled emitted a hint. */
  hinted: number;
  recovered: number;
  /** Failures the model had no later turn to answer; outside `recoveryRate`. */
  sameTurn: number;
  /** recovered / (failures - sameTurn). */
  recoveryRate: number | null;
}

interface HintEfficacy {
  /** Failures where oled emitted a hint. */
  emitted: number;
  /** Of those, hints whose "followed" is decidable: one naming a flag, or the help advice. */
  actionable: number;
  /** Of those, hints the model had a later turn to act on. */
  judged: number;
  followed: number;
  ignored: number;
  /** Followed hints whose next attempt at the same subcommand succeeded. */
  recovered: number;
  /** recovered / followed. */
  rate: number | null;
}

export interface FrictionAnalysis {
  total: number;
  items: FrictionItem[];
  types: TypeCount[];
  recovery: Recovery;
  subcommands: SubcommandRow[];
  hints: HintEfficacy;
}

/** One row per exit code oled can leave, so a new code fails to compile until it has a class. */
const FRICTION_BY_EXIT = byExitCode<FrictionType>({
  GENERIC: "command_error",
  USAGE: "usage_error",
  NOT_READY: "not_ready",
  INPUT_REQUIRED: "input_required",
  NOT_FOUND: "not_found",
  INVALID: "invalid",
  PARTIAL: "partial",
});

const DATE_FLAG = /--(?:from|to)(?:=|\s+)"?([^\s"]+)"?/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HINT_FLAG = /--[a-z][a-z0-9-]*/g;
/**
 * Offering the route: "on stdin", "pipe them". A flag named in the same hint
 * (`--input <file>`) is `flags`' job, and "pipeline" never matches.
 */
const HINT_STDIN = /(?<![-\w])stdin\b|\bpipe[ds]?\b/i;
const HELP_FLAGS = ["--help", "-h"];

export interface Attempt {
  phase: PhaseId;
  turn: number;
  observation: ToolObservation;
}

export function toolCalls(events: RunEvent[]): Attempt[] {
  const calls: Attempt[] = [];
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const { type: _type, phase, turn, ...observation } = event;
    calls.push({ phase, turn, observation });
  }
  return calls;
}

function hintFlags(hint: string | null): string[] {
  if (!hint) return [];
  return [...hint.matchAll(HINT_FLAG)].map((match) => match[0]);
}

function isHelpCall(args: string): boolean {
  return args.split(/\s+/).some((token) => HELP_FLAGS.includes(token));
}

/**
 * What a hint asks for. A generic "append --help" hint names no flag, so
 * it's advisory: a help call or a working call both satisfy it, and nothing
 * can miss it. A hint naming a real flag, or offering stdin, can be missed.
 */
interface HintAsk {
  flags: string[];
  advisory: boolean;
  /** The hint offers stdin as a route, so anything sent there follows it. */
  stdin: boolean;
}

/**
 * Host-appended flags are dropped before anything else: this harness puts
 * `--json` on every call, so a hint naming it is followed no matter what the
 * model does and can decide nothing.
 */
function hintAsk(hint: string | null): HintAsk {
  const named = hintFlags(hint).filter((flag) => !HOST_APPENDED_FLAGS.includes(flag));
  const advisory = named.length > 0 && named.every((flag) => HELP_FLAGS.includes(flag));
  return {
    flags: advisory ? [] : named,
    advisory,
    stdin: hint !== null && HINT_STDIN.test(hint),
  };
}

/** A hint that asks for nothing decidable is neither followed nor ignored. */
function isActionable(ask: HintAsk): boolean {
  return ask.advisory || ask.flags.length > 0 || ask.stdin;
}

function follows(ask: HintAsk, o: ToolObservation): boolean {
  if (ask.advisory) return isHelpCall(o.args) || o.ok;
  if (ask.stdin && o.stdin) return true;
  return ask.flags.some((flag) => o.args.includes(flag));
}

function badDateValue(args: string): boolean {
  for (const match of args.matchAll(DATE_FLAG)) {
    const value = match[1];
    if (value && !ISO_DATE.test(value)) return true;
  }
  return false;
}

/**
 * Ordered most specific first: a refusal outranks everything since nothing
 * ran, misuse outranks the exit code since it explains the call, and
 * `missed_hint` outranks the exit code it would otherwise repeat.
 */
function classify(o: ToolObservation, missed: boolean): FrictionType | null {
  if (o.rejected) return o.rejected;
  if (badDateValue(o.args)) return "bad_date_format";
  if (o.ok) return null;
  if (missed) return "missed_hint";
  const shape = errorShapeOf(o.message);
  if (shape) return shape.shape;
  if (o.exitCode === null) return "unknown";
  return FRICTION_BY_EXIT.get(o.exitCode) ?? "unknown";
}

/** The last failing attempt at a subcommand: what its hint asked for, and when. */
interface Outstanding {
  turn: number;
  ask: HintAsk;
}

/**
 * Only missable by a later call: a sibling dispatched in the same turn was
 * already in flight and can't have ignored anything.
 */
function missedHint(call: Attempt, outstanding: Outstanding | undefined): boolean {
  if (!outstanding) return false;
  if (outstanding.ask.flags.length === 0 && !outstanding.ask.stdin) return false;
  if (outstanding.turn >= call.turn) return false;
  return !follows(outstanding.ask, call.observation);
}

/**
 * Other attempts at this subcommand, split by whether the model could have
 * read this result first (turns rise with event order).
 */
interface Followups {
  later: Attempt[];
  concurrent: boolean;
}

function followups(calls: Attempt[], from: Attempt): Followups {
  const later: Attempt[] = [];
  let concurrent = false;
  for (const call of calls) {
    if (call.observation.subcommand !== from.observation.subcommand) continue;
    if (call.turn > from.turn) later.push(call);
    else if (call !== from && call.turn === from.turn) concurrent = true;
  }
  return { later, concurrent };
}

function nextAttempt(later: Attempt[], hint: string | null): NextAttempt | null {
  const first = later[0]?.observation;
  if (!first) return null;
  const ask = hintAsk(hint);
  return {
    command: first.command,
    args: first.args,
    ok: first.ok,
    message: first.message,
    followedHint: isActionable(ask) && follows(ask, first),
  };
}

function recoveryOf(o: ToolObservation, next: Followups): RecoveryOutcome | null {
  if (o.ok) return null;
  // A help lookup exits 0 but does no work; recovery means a real retry succeeded.
  if (next.later.some((call) => call.observation.ok && !isHelpCall(call.observation.args))) {
    return "recovered";
  }
  const first = next.later[0]?.observation;
  if (!first) return next.concurrent ? "same_turn" : "abandoned";
  return first.command === o.command ? "repeated" : "changed";
}

function countTypes(items: FrictionItem[]): TypeCount[] {
  const counts = new Map<FrictionType, number>();
  for (const item of items) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

function rate(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** One entry per RecoveryOutcome: a new outcome fails to compile until it is counted. */
const RECOVERY_FIELD: Record<RecoveryOutcome, keyof Omit<RecoveryRow, "type" | "encountered">> = {
  recovered: "recovered",
  repeated: "repeated",
  changed: "changed",
  abandoned: "abandoned",
  same_turn: "sameTurn",
};

/** A friction item that failed, with its outcome narrowed out of the nullable field. */
interface Failure {
  type: FrictionType;
  outcome: RecoveryOutcome;
}

function failuresOf(items: FrictionItem[]): Failure[] {
  const failures: Failure[] = [];
  for (const item of items) {
    if (item.recovery === null) continue;
    failures.push({ type: item.type, outcome: item.recovery });
  }
  return failures;
}

function buildRecovery(items: FrictionItem[]): Recovery {
  const failures = failuresOf(items);
  const rows = new Map<FrictionType, RecoveryRow>();
  for (const failure of failures) {
    const row =
      rows.get(failure.type) ??
      {
        type: failure.type,
        encountered: 0,
        recovered: 0,
        repeated: 0,
        changed: 0,
        abandoned: 0,
        sameTurn: 0,
      };
    row.encountered += 1;
    const counted = RECOVERY_FIELD[failure.outcome];
    row[counted] = row[counted] + 1;
    rows.set(failure.type, row);
  }
  const recovered = failures.filter((failure) => failure.outcome === "recovered").length;
  const sameTurn = failures.filter((failure) => failure.outcome === "same_turn").length;
  const judged = failures.length - sameTurn;
  return {
    rows: [...rows.values()].sort((a, b) => b.encountered - a.encountered),
    encountered: failures.length,
    judged,
    sameTurn,
    recovered,
    rate: rate(recovered, judged),
  };
}

function buildSubcommands(calls: Attempt[], items: FrictionItem[]): SubcommandRow[] {
  const rows = new Map<string, SubcommandRow>();
  const rowFor = (subcommand: string): SubcommandRow => {
    const existing = rows.get(subcommand);
    if (existing) return existing;
    const created: SubcommandRow = {
      subcommand,
      calls: 0,
      help: 0,
      failures: 0,
      types: [],
      hinted: 0,
      recovered: 0,
      sameTurn: 0,
      recoveryRate: null,
    };
    rows.set(subcommand, created);
    return created;
  };

  for (const call of calls) {
    const row = rowFor(call.observation.subcommand);
    row.calls += 1;
    if (isHelpCall(call.observation.args)) row.help += 1;
    if (call.observation.ok) continue;
    row.failures += 1;
    if (call.observation.hint) row.hinted += 1;
  }
  for (const item of items) {
    const row = rowFor(item.subcommand);
    if (item.recovery === "recovered") row.recovered += 1;
    if (item.recovery === "same_turn") row.sameTurn += 1;
  }
  for (const row of rows.values()) {
    row.types = countTypes(items.filter((item) => item.subcommand === row.subcommand));
    row.recoveryRate = rate(row.recovered, row.failures - row.sameTurn);
  }
  return [...rows.values()].sort(
    (a, b) => b.failures - a.failures || b.calls - a.calls || a.subcommand.localeCompare(b.subcommand),
  );
}

function buildHintEfficacy(calls: Attempt[]): HintEfficacy {
  let emitted = 0;
  let actionable = 0;
  let judged = 0;
  let followed = 0;
  let recovered = 0;

  for (const call of calls) {
    const o = call.observation;
    if (o.ok || !o.hint) continue;
    emitted += 1;
    const ask = hintAsk(o.hint);
    if (!isActionable(ask)) continue;
    actionable += 1;
    const next = followups(calls, call).later[0]?.observation;
    if (!next) continue;
    judged += 1;
    if (!follows(ask, next)) continue;
    followed += 1;
    if (next.ok) recovered += 1;
  }

  return {
    emitted,
    actionable,
    judged,
    followed,
    ignored: judged - followed,
    recovered,
    rate: rate(recovered, followed),
  };
}

export function analyzeFriction(calls: Attempt[]): FrictionAnalysis {
  const outstanding = new Map<string, Outstanding>();
  const items: FrictionItem[] = [];

  for (const call of calls) {
    const o = call.observation;
    const type = classify(o, missedHint(call, outstanding.get(o.subcommand)));
    outstanding.set(o.subcommand, {
      turn: call.turn,
      ask: hintAsk(o.ok ? null : o.hint),
    });
    if (!type) continue;
    const next = followups(calls, call);
    items.push({
      type,
      phase: call.phase,
      turn: call.turn,
      tool: o.tool,
      subcommand: o.subcommand,
      args: o.args,
      command: o.command,
      exitCode: o.exitCode,
      message: o.message,
      hint: o.hint,
      next: nextAttempt(next.later, o.hint),
      recovery: recoveryOf(o, next),
    });
  }

  return {
    total: items.length,
    items,
    types: countTypes(items),
    recovery: buildRecovery(items),
    subcommands: buildSubcommands(calls, items),
    hints: buildHintEfficacy(calls),
  };
}

/**
 * Excludes stdin-batch calls (`ingest commit --file <sf:id>` shares an
 * identical argv by design while its rows differ — see `redundantCommits`)
 * and help calls (the contract working as intended, not flailing).
 */
export function repeatedCommands(calls: Attempt[]): number {
  const seen = new Map<string, number>();
  for (const call of calls) {
    if (call.observation.rows !== null) continue;
    if (isHelpCall(call.observation.args)) continue;
    seen.set(call.observation.command, (seen.get(call.observation.command) ?? 0) + 1);
  }
  return [...seen.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

export function helpCalls(calls: Attempt[]): number {
  return calls.filter((call) => isHelpCall(call.observation.args)).length;
}

/** Commits that posted nothing because every row already existed. */
export function redundantCommits(calls: Attempt[]): number {
  return calls.filter((call) => {
    const commit = call.observation.commit;
    return commit !== null && commit.posted === 0 && commit.duplicates > 0;
  }).length;
}
