import type { PhaseId, RunEvent, ToolObservation } from "./events.js";

/**
 * Where the model and the OpenLedger contract collided, and whether the contract's
 * own error copy got the model unstuck. Nothing here is pass/fail: it is the
 * diagnostic feed for changing the CLI, so every item keeps enough context to
 * read as "the model tried X, oled said Y, the model then did Z".
 */

export type FrictionType =
  | "unknown_flag"
  | "unknown_command"
  | "usage_error"
  | "input_required"
  | "not_found"
  | "invalid"
  | "command_error"
  | "bad_tool_args"
  | "unknown_tool"
  | "refused_shell"
  | "bad_date_format"
  | "missed_hint"
  /** Fits nothing above. Reported as itself, so the gap in this list is visible. */
  | "unknown";

/**
 * What the model did next at the same subcommand. `same_turn` is the absence of
 * an answer rather than an outcome: every other attempt was dispatched in the
 * same turn, before this result existed, so none of them can say whether the
 * error copy taught anything.
 */
export type RecoveryOutcome = "recovered" | "repeated" | "changed" | "abandoned" | "same_turn";

export interface NextAttempt {
  command: string;
  args: string;
  ok: boolean;
  message: string;
  /** true when this attempt did what the previous failure's hint asked. */
  followedHint: boolean;
}

export interface FrictionItem {
  type: FrictionType;
  phase: PhaseId;
  /** The turn that dispatched the call, so concurrent siblings are visible. */
  turn: number;
  tool: string;
  subcommand: string;
  args: string;
  command: string;
  exitCode: number | null;
  message: string;
  /** oled's hint, verbatim. */
  hint: string | null;
  /** The next attempt at this subcommand in a LATER turn; null when there was none. */
  next: NextAttempt | null;
  /** null when the call succeeded and the friction is misuse rather than failure. */
  recovery: RecoveryOutcome | null;
}

export interface TypeCount {
  type: FrictionType;
  count: number;
}

export interface Recovery {
  rows: RecoveryRow[];
  /** Every failure the walk looked at. */
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
export interface RecoveryRow {
  type: FrictionType;
  encountered: number;
  recovered: number;
  repeated: number;
  changed: number;
  abandoned: number;
  sameTurn: number;
}

/** The actionable unit for changing the CLI: one row per subcommand touched. */
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

export interface HintEfficacy {
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

const EXIT_FRICTION: Record<number, FrictionType> = {
  2: "usage_error",
  4: "input_required",
  5: "not_found",
  6: "invalid",
};

const UNKNOWN_OPTION = /unknown option/i;
const UNKNOWN_COMMAND = /unknown command/i;
const DATE_FLAG = /--(?:from|to)(?:=|\s+)"?([^\s"]+)"?/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HINT_FLAG = /--[a-z][a-z0-9-]*/g;
const HINT_STDIN = /\bstdin\b/i;
const HELP_FLAGS = ["--help", "-h"];

interface Attempt {
  phase: PhaseId;
  turn: number;
  observation: ToolObservation;
}

function toolCalls(events: RunEvent[]): Attempt[] {
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
 * What a hint asks for. The root CLI appends "append --help to the command" to
 * every usage error, which names no flag the call was missing: it is advice to go
 * read, so a help call and a working call both answer it, and nothing answers it
 * wrongly. `flags` is therefore empty for those, and only a hint naming a real
 * flag can be missed.
 */
interface HintAsk {
  flags: string[];
  advisory: boolean;
  /** The hint offers stdin as a route, so a batch sent there follows it. */
  stdin: boolean;
}

function hintAsk(hint: string | null): HintAsk {
  const named = hintFlags(hint);
  const advisory = named.length > 0 && named.every((flag) => HELP_FLAGS.includes(flag));
  return {
    flags: advisory ? [] : named,
    advisory,
    stdin: hint !== null && HINT_STDIN.test(hint),
  };
}

/** A hint that asks for nothing decidable is neither followed nor ignored. */
function isActionable(ask: HintAsk): boolean {
  return ask.advisory || ask.flags.length > 0;
}

function follows(ask: HintAsk, o: ToolObservation): boolean {
  if (ask.advisory) return isHelpCall(o.args) || o.ok;
  if (ask.stdin && (o.rows ?? 0) > 0) return true;
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
 * One type per call, most specific first: a refusal outranks everything because
 * nothing ran, a misuse outranks the exit code because it says why the call was
 * wrong, and `missed_hint` outranks the exit code it would otherwise repeat.
 *
 * The last two arms are the floor. `command_error` is a command that ran and
 * failed on an exit code this list does not name; `unknown` is a failure with no
 * exit code, no refusal and no stderr this reader recognizes. Reporting it as
 * `unknown` says the taxonomy is short a type, which is worth knowing. Filing it
 * under the nearest neighbour would hide that.
 */
function classify(o: ToolObservation, missed: boolean): FrictionType | null {
  if (o.rejected) return o.rejected;
  if (badDateValue(o.args)) return "bad_date_format";
  if (o.ok) return null;
  if (missed) return "missed_hint";
  if (UNKNOWN_OPTION.test(o.message)) return "unknown_flag";
  if (UNKNOWN_COMMAND.test(o.message)) return "unknown_command";
  if (o.exitCode === null) return "unknown";
  return EXIT_FRICTION[o.exitCode] ?? "command_error";
}

/** The last failing attempt at a subcommand: what its hint asked for, and when. */
interface Outstanding {
  turn: number;
  ask: HintAsk;
}

/**
 * A hint can only be missed by a call the model sent after reading it. A sibling
 * dispatched in the same turn was already in flight, so it cannot have ignored
 * anything.
 */
function missedHint(call: Attempt, outstanding: Outstanding | undefined): boolean {
  if (!outstanding || outstanding.ask.flags.length === 0) return false;
  if (outstanding.turn >= call.turn) return false;
  return !follows(outstanding.ask, call.observation);
}

/**
 * The other attempts at this call's subcommand, split by whether the model could
 * have read this result first. Turns rise with the event order, so a later turn
 * is always a later call.
 */
interface Followups {
  /** Attempts in a later turn: the only ones that can show a reaction. */
  later: Attempt[];
  /** true when another attempt shared this turn, so no reaction was possible. */
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

/**
 * A hint the model never got a later turn to act on is neither followed nor
 * ignored: `judged` is the only population "followed" can be read against.
 */
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

export function analyzeFriction(events: RunEvent[]): FrictionAnalysis {
  const calls = toolCalls(events);
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
 * Commands the model sent more than once. Two kinds are excluded. Calls carrying
 * a batch on stdin have an argv that is identical by design
 * (`ingest commit --file <sf:id>`) while the rows differ, so counting them here
 * would report five distinct batches as four repeats; re-sending the same batch
 * shows up in `redundantCommits`, which reads what oled actually posted. Help
 * calls are the contract working: the skill sends the model to `--help`, and
 * reading the same page twice is not flailing.
 */
export function repeatedCommands(events: RunEvent[]): number {
  const seen = new Map<string, number>();
  for (const call of toolCalls(events)) {
    if (call.observation.rows !== null) continue;
    if (isHelpCall(call.observation.args)) continue;
    seen.set(call.observation.command, (seen.get(call.observation.command) ?? 0) + 1);
  }
  return [...seen.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

/** Calls that asked for `--help`, whatever the subcommand. */
export function helpCalls(events: RunEvent[]): number {
  return toolCalls(events).filter((call) => isHelpCall(call.observation.args)).length;
}

/** Commits that posted nothing because every row already existed. */
export function redundantCommits(events: RunEvent[]): number {
  return toolCalls(events).filter((call) => {
    const commit = call.observation.commit;
    return commit !== null && commit.posted === 0 && commit.duplicates > 0;
  }).length;
}
