import * as z from "zod";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { tryExecute, type Result } from "../core/result.js";
import { artifactsOf, type ArtifactScan, type OpenLedgerArtifacts } from "../oled/artifacts.js";
import type { OpenLedgerRunner } from "../oled/command.js";
import { carriesOutput, EXIT, HOST_APPENDED_FLAGS } from "../oled/contract.js";
import { parseNdjson } from "../oled/ndjson.js";
import type {
  CommitCounters,
  OperationalNote,
  RejectionType,
  ToolObservation,
} from "../report/events.js";

/**
 * A tool never throws: bad args and refusals come back as a normal ToolResult,
 * and the scorecard classifies outcomes from the observation, not thrown errors.
 */

/** What the host took from the call on the model's behalf, and what it wants said about it. */
interface HostArtifacts {
  artifacts: OpenLedgerArtifacts | null;
  notes: OperationalNote[];
}

interface ToolResult extends HostArtifacts {
  content: string;
  observation: ToolObservation;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  invoke(rawArgs: string): Promise<ToolResult>;
}

// Large enough for a full `--json` ledger listing; small enough that one runaway list can't own the whole context window.
const MAX_TOOL_CONTENT = 60_000;

const MAX_ARGS_ECHO = 400;

// Enough of each reply for the transcript to be readable without the sandbox.
const MAX_RESULT_ECHO = 2_000;

// Shell operators would let one tool call become several commands.
const SHELL_METACHARACTERS = /[|&;<>`$]/;

// oled dispatches on at most `noun verb`.
const MAX_SUBCOMMAND_WORDS = 2;

// The one subcommand that reads a batch of rows from stdin.
const COMMIT_SUBCOMMAND = "ingest commit";

const OLED_ARGS = z.object({
  args: z.string().min(1),
  stdin: z.string().optional(),
});

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _unused, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} characters]`;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function numberAt(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : 0;
}

// A parse error commander answered itself prints `hint: …` instead, so both are read.
const TEXT_HINT = /^hint:\s*(.+)$/m;

/** oled writes `{"error":{…,"hint":"…"}}` on stderr in --json mode. */
function hintOf(stderr: string): string | null {
  for (const row of parseNdjson(stderr)) {
    const error = row.error;
    if (!error || typeof error !== "object") continue;
    const hint = (error as { hint?: unknown }).hint;
    if (typeof hint === "string" && hint) return hint;
  }
  return TEXT_HINT.exec(stderr)?.[1]?.trim() ?? null;
}

/** The line a multi-row command closes with, and the only one that speaks for the whole run. */
function summaryRow(stdout: string): Record<string, unknown> | null {
  return parseNdjson(stdout).find((row) => row.type === "summary") ?? null;
}

/** `posted` appears only in the commit summary, which is what distinguishes it. */
function commitCountersOf(stdout: string): CommitCounters | null {
  const row = summaryRow(stdout);
  if (!row || typeof row.posted !== "number") return null;
  return {
    posted: row.posted,
    duplicates: numberAt(row, "duplicates"),
    failed: numberAt(row, "failed"),
    questionsRaised: numberAt(row, "raised_questions"),
  };
}

/**
 * PARTIAL means the command did some of the work, so the line that says how much
 * is the summary: row 0 is one result among many and reads as the whole failure.
 */
function messageOf(exitCode: number, stdout: string, stderr: string): string {
  if (exitCode === EXIT.PARTIAL) {
    const summary = summaryRow(stdout);
    if (summary) return JSON.stringify(summary);
  }
  return firstLine(stderr) || firstLine(stdout);
}

/** `absent` stays silent: most commands prepare nothing. `unreadable` never does: that silence was the bug. */
function hostArtifacts(scan: ArtifactScan, command: string): HostArtifacts {
  if (scan.ok) return { artifacts: scan.value, notes: [] };
  if (scan.reason === "absent") return { artifacts: null, notes: [] };
  return {
    artifacts: null,
    notes: [{ operation: "artifacts_unreadable", detail: `${command}: ${scan.detail}` }],
  };
}

function subcommandOf(argv: string[], fallback: string): string {
  const words: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-") || words.length === MAX_SUBCOMMAND_WORDS) break;
    words.push(token);
  }
  return words.join(" ") || fallback;
}

function toolResult(
  content: string,
  observation: Omit<ToolObservation, "result">,
  found: HostArtifacts = { artifacts: null, notes: [] },
): ToolResult {
  return {
    ...found,
    content,
    observation: { ...observation, result: truncate(content, MAX_RESULT_ECHO) },
  };
}

/** A refused call ran nothing, so it sent no stdin and has no exit code of its own. */
function refuse(
  type: RejectionType,
  spec: { tool: string; subcommand: string; args: string; command: string },
  message: string,
): ToolResult {
  return toolResult(message, {
    ...spec,
    ok: false,
    exitCode: null,
    rejected: type,
    message,
    hint: null,
    stdin: false,
    rows: null,
    commit: null,
  });
}

function parseArgs<T extends z.ZodType>(schema: T, rawArgs: string): Result<z.infer<T>> {
  const json = tryExecute(() => JSON.parse(rawArgs || "{}") as unknown);
  if (!json.ok) {
    return { ok: false, error: `arguments were not valid JSON: ${rawArgs.slice(0, 200)}` };
  }
  const parsed = schema.safeParse(json.value);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, value: parsed.data as z.infer<T> };
}

function tokenize(input: string): Result<string[]> {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (const char of input) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (quote !== null) return { ok: false, error: "unterminated quote in args" };
  if (started) tokens.push(current);
  if (tokens.length === 0) return { ok: false, error: "args was empty" };
  return { ok: true, value: tokens };
}

/** Tolerates a leading `oled` and guarantees --json, so NDJSON is never optional. */
function normalizeArgv(tokens: string[]): string[] {
  const argv = tokens[0] === "oled" ? tokens.slice(1) : tokens;
  const missing = HOST_APPENDED_FLAGS.filter((flag) => !argv.includes(flag));
  return [...argv, ...missing];
}

/** The noun oled dispatches on, before any flag or its value can be mistaken for one. */
function nounOf(argv: string[]): string {
  return argv.find((token) => !token.startsWith("-")) ?? "";
}

/**
 * Commands whose effect lands outside the sandbox. The refusal says which
 * machine it would have touched, so the model can tell it apart from a command
 * that does not exist.
 */
const DENIED_NOUNS: Record<string, string> = {
  open: "refused: `oled open` opens a file-manager window on the machine running this eval, which nobody is watching. Read what oled knows through its own commands instead.",
};

interface RunSpec {
  tool: string;
  args: string;
  argv: string[];
  rows: number | null;
  stdin?: string;
}

/** The failure arm carries the refusal itself: the model reads it as the answer. */
type StagedRun = { ok: true; value: RunSpec } | { ok: false; refusal: ToolResult };

async function runArgv(runner: OpenLedgerRunner, spec: RunSpec): Promise<ToolResult> {
  const command = `oled ${spec.argv.join(" ")}`;
  const base = {
    tool: spec.tool,
    subcommand: subcommandOf(spec.argv, spec.tool),
    args: spec.args,
    command,
    stdin: spec.stdin !== undefined,
    rows: spec.rows,
  };
  const result = await runner.run(
    spec.argv,
    spec.stdin === undefined ? {} : { stdin: spec.stdin },
  );
  if (!result.ok) {
    return toolResult(JSON.stringify({ exit_code: null, stdout: "", stderr: result.message }), {
      ...base,
      ok: false,
      exitCode: null,
      rejected: null,
      message: `${result.reason}: ${result.message}`,
      hint: null,
      commit: null,
    });
  }

  // Artifacts come from the untruncated stdout, so the host's copy doesn't depend on how much fit in the model's copy.
  const ran = result.value;
  return toolResult(
    truncate(
      JSON.stringify({ exit_code: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr }),
      MAX_TOOL_CONTENT,
    ),
    {
      ...base,
      ok: ran.exitCode === EXIT.OK,
      exitCode: ran.exitCode,
      rejected: null,
      message: messageOf(ran.exitCode, ran.stdout, ran.stderr),
      hint: hintOf(ran.stderr),
      commit: commitCountersOf(ran.stdout),
    },
    // PARTIAL as well as OK: a prepare that lost pages to OCR still names a usable document.
    carriesOutput(ran.exitCode)
      ? hostArtifacts(artifactsOf(ran.stdout), command)
      : { artifacts: null, notes: [] },
  );
}

const REFUSED_SHELL =
  "refused: args cannot contain | & ; < > ` or $. Run one oled command per call and send a batch through the `stdin` field instead of a pipe.";

// Docs write placeholders as <pattern>; a model copying one verbatim needs a different correction than a pipe.
const PLACEHOLDER = /<[a-z][a-z0-9:_-]*>/i;

const REFUSED_PLACEHOLDER =
  "refused: args contain a <placeholder>. Replace every <...> from the docs with a real value from a previous command's output.";

function countRows(ndjson: string): number {
  return ndjson.split("\n").filter((line) => line.trim().length > 0).length;
}

/** Null outside `ingest commit`: the only subcommand that reads stdin at all. */
function batchRows(argv: string[], stdin: string | undefined): number | null {
  if (stdin === undefined) return null;
  if (subcommandOf(argv, "") !== COMMIT_SUBCOMMAND) return null;
  return countRows(stdin);
}

function prepareRun(rawArgs: string): StagedRun {
  const spec = {
    tool: "oled",
    subcommand: "oled",
    args: truncate(rawArgs, MAX_ARGS_ECHO),
    command: "oled",
  };
  const parsed = parseArgs(OLED_ARGS, rawArgs);
  if (!parsed.ok) return { ok: false, refusal: refuse("bad_tool_args", spec, parsed.error) };

  const args = truncate(parsed.value.args, MAX_ARGS_ECHO);
  const called = { ...spec, args, command: `oled ${args}` };
  // Before the shell guard: `<...>` is made of metacharacters, so testing shell
  // first would file every copied placeholder as an attempt to use a shell.
  if (PLACEHOLDER.test(parsed.value.args)) {
    return { ok: false, refusal: refuse("refused_placeholder", called, REFUSED_PLACEHOLDER) };
  }
  if (SHELL_METACHARACTERS.test(parsed.value.args)) {
    return { ok: false, refusal: refuse("refused_shell", called, REFUSED_SHELL) };
  }

  const tokens = tokenize(parsed.value.args);
  if (!tokens.ok) return { ok: false, refusal: refuse("bad_tool_args", called, tokens.error) };

  const argv = normalizeArgv(tokens.value);
  const noun = nounOf(argv);
  const denied = DENIED_NOUNS[noun];
  if (denied) {
    return {
      ok: false,
      refusal: refuse("refused_command", { ...called, subcommand: noun }, denied),
    };
  }

  return {
    ok: true,
    value: {
      tool: "oled",
      args,
      argv,
      rows: batchRows(argv, parsed.value.stdin),
      ...(parsed.value.stdin === undefined ? {} : { stdin: parsed.value.stdin }),
    },
  };
}

function createOledTool(oled: OpenLedgerRunner): Tool {
  return {
    name: "oled",
    description:
      "Run one oled command. `args` is the argument string after `oled` (--json is added for you). Optional `stdin` is piped to the command's standard input. No shell operators.",
    parameters: jsonSchema(OLED_ARGS),
    async invoke(rawArgs) {
      const prepared = prepareRun(rawArgs);
      if (!prepared.ok) return prepared.refusal;
      return runArgv(oled, prepared.value);
    },
  };
}

export function createTools(oled: OpenLedgerRunner): Tool[] {
  return [createOledTool(oled)];
}

export function toolSpecs(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export function findTool(tools: Tool[], name: string): Tool | null {
  return tools.find((tool) => tool.name === name) ?? null;
}

/** An unknown name never reaches a tool, so the runner reports it as one. */
export function unknownToolResult(name: string, available: string[]): ToolResult {
  const message = `unknown tool: ${name}. Available: ${available.join(", ")}`;
  return refuse(
    "unknown_tool",
    { tool: name, subcommand: name, args: "", command: name },
    message,
  );
}
