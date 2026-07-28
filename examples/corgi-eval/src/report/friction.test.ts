import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent, ToolObservation } from "./events.js";
import { analyzeFriction, toolCalls } from "./friction.js";

function toolCall(turn: number, over: Partial<ToolObservation>): RunEvent {
  return {
    type: "tool_call",
    phase: "ingest",
    turn,
    tool: "oled",
    subcommand: "status",
    args: "status",
    command: "oled status --json",
    ok: false,
    exitCode: 1,
    rejected: null,
    message: "",
    hint: null,
    stdin: false,
    rows: null,
    commit: null,
    result: "",
    ...over,
  };
}

function typesOf(events: RunEvent[]): string[] {
  return analyzeFriction(toolCalls(events)).items.map((item) => item.type);
}

/** Every code oled's reporter can exit with, and the class it is filed under. */
const EXIT_CLASSES: [number, string][] = [
  [1, "command_error"],
  [2, "usage_error"],
  [3, "not_ready"],
  [4, "input_required"],
  [5, "not_found"],
  [6, "invalid"],
  [7, "partial"],
];

test("every exit code has a class of its own", () => {
  for (const [exitCode, expected] of EXIT_CLASSES) {
    assert.deepEqual(typesOf([toolCall(1, { exitCode })]), [expected], `exit ${exitCode}`);
  }
});

test("a call that exited 0 is no friction at all", () => {
  assert.deepEqual(typesOf([toolCall(1, { ok: true, exitCode: 0 })]), []);
});

/** Verbatim first stderr lines from the real CLI, JSON escaping and all. */
const REAL_ERRORS: [string, string][] = [
  [
    '{"error":{"code":"E_USAGE","message":"unknown option \'--nope\'","hint":"run `oled status --help` for its flags and usage"}}',
    "unknown_flag",
  ],
  [
    '{"error":{"code":"E_USAGE","message":"unknown command \'resolve\'","hint":"run `oled questions --help` for its flags and usage"}}',
    "unknown_command",
  ],
  [
    '{"error":{"code":"E_USAGE","message":"--limit must be a number, got \\"abc\\"","hint":"append --help to the command for its flags and usage"}}',
    "flag_value",
  ],
  // The one parse error that stays plain text: commander swallowed the --json.
  ['error: --limit must be a number, got "--json"', "flag_value"],
  [
    '{"error":{"code":"E_USAGE","message":"missing required argument \'pathOrId\'","hint":"run `oled ingest prepare --help` for its flags and usage"}}',
    "usage_error",
  ],
];

test("oled's own copy outranks the exit code it arrived with", () => {
  for (const [message, expected] of REAL_ERRORS) {
    assert.deepEqual(typesOf([toolCall(1, { message, exitCode: 2 })]), [expected], message);
  }
});

test("a hint naming only a host-appended flag decides nothing", () => {
  const { hints } = analyzeFriction(
    toolCalls([
      toolCall(1, { exitCode: 2, hint: "re-run with --json to read the output" }),
      toolCall(2, { ok: true, exitCode: 0 }),
    ]),
  );
  assert.equal(hints.emitted, 1);
  assert.equal(hints.actionable, 0);
  assert.equal(hints.followed, 0);
});

/** The first is `vault add`'s verbatim copy; the second is the wording it replaced. */
const STDIN_HINTS = [
  "the password is read from stdin, e.g. `printf %s 'secret' | oled vault add <pattern>`",
  "pipe the password in, e.g. `printf %s 'secret' | oled vault add <pattern>`",
];

test("a hint offering stdin is followed by a call that sends stdin", () => {
  for (const hint of STDIN_HINTS) {
    const { hints } = analyzeFriction(
      toolCalls([
        toolCall(1, { subcommand: "vault add", exitCode: 4, hint }),
        toolCall(2, { subcommand: "vault add", ok: true, exitCode: 0, stdin: true }),
      ]),
    );
    assert.equal(hints.actionable, 1, hint);
    assert.equal(hints.judged, 1, hint);
    assert.equal(hints.followed, 1, hint);
    assert.equal(hints.recovered, 1, hint);
  }
});
