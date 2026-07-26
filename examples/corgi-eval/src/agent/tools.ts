import * as z from "zod";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { tryExecute, type Result } from "../core/result.js";
import { artifactsOf, type PlasalidArtifacts } from "../plasalid/artifacts.js";
import type { PlasalidRunner } from "../plasalid/command.js";
import { parseNdjson } from "../plasalid/ndjson.js";
import type { CommitCounters, RejectionType, ToolObservation } from "../report/events.js";

/**
 * The model's whole surface: the plasalid CLI, and nothing else. Anything the
 * model needs — reading a statement, committing a batch — it must get through a
 * real plasalid command, so the run scores the product's own surface rather than
 * a convenience this example invented. Bad arguments come back as a message the
 * model can act on: a tool never throws and never ends the run.
 *
 * A tool reports facts, never verdicts: the observation carries the subcommand,
 * the arguments, the exit code and plasalid's hint, and the scorecard classifies
 * from those. A refused call still hands back a ToolResult, because a refusal is
 * a result the model must read, not an error to propagate.
 */

export interface ToolResult {
  /** What the model sees. */
  content: string;
  /** What the report records. */
  observation: ToolObservation;
  /** Files the command reported producing, for the host to carry back. */
  artifacts: PlasalidArtifacts | null;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  invoke(rawArgs: string): Promise<ToolResult>;
}

// Large enough for a full `--json` listing of the posted ledger; small enough
// that one runaway list cannot own the whole context window.
const MAX_TOOL_CONTENT = 60_000;

const MAX_ARGS_ECHO = 400;

// Enough of each reply for the transcript to be readable without the sandbox.
const MAX_RESULT_ECHO = 2_000;

// Shell operators would let one tool call become several commands.
const SHELL_METACHARACTERS = /[|&;<>`$]/;

// plasalid dispatches on at most `noun verb`.
const MAX_SUBCOMMAND_WORDS = 2;

// The one subcommand that reads a batch of rows from stdin.
const COMMIT_SUBCOMMAND = "ingest commit";

const PLASALID_ARGS = z.object({
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

/** plasalid writes `{"error":{…,"hint":"…"}}` on stderr in --json mode. */
function hintOf(stderr: string): string | null {
  for (const row of parseNdjson(stderr)) {
    const error = row.error;
    if (!error || typeof error !== "object") continue;
    const hint = (error as { hint?: unknown }).hint;
    if (typeof hint === "string" && hint) return hint;
  }
  return null;
}

/** `posted` appears only in the commit summary, which is what distinguishes it. */
function commitCountersOf(stdout: string): CommitCounters | null {
  for (const row of parseNdjson(stdout)) {
    if (row.type !== "summary" || typeof row.posted !== "number") continue;
    return {
      posted: row.posted,
      duplicates: numberAt(row, "duplicates"),
      failed: numberAt(row, "failed"),
      questionsRaised: numberAt(row, "raised_questions"),
    };
  }
  return null;
}

function subcommandOf(argv: string[], fallback: string): string {
  const words: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-") || words.length === MAX_SUBCOMMAND_WORDS) break;
    words.push(token);
  }
  return words.join(" ") || fallback;
}

/** The single exit for every tool: the model's copy and the report's copy of it. */
function toolResult(
  content: string,
  observation: Omit<ToolObservation, "result">,
  artifacts: PlasalidArtifacts | null,
): ToolResult {
  return {
    content,
    observation: { ...observation, result: truncate(content, MAX_RESULT_ECHO) },
    artifacts,
  };
}

function refuse(
  type: RejectionType,
  spec: { tool: string; subcommand: string; args: string; command: string },
  message: string,
): ToolResult {
  return toolResult(
    message,
    {
      ...spec,
      ok: false,
      exitCode: null,
      rejected: type,
      message,
      hint: null,
      rows: null,
      commit: null,
    },
    null,
  );
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

/** Splits on whitespace outside quotes; quotes group a value and are dropped. */
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

/** Tolerates a leading `plasalid` and guarantees --json, so NDJSON is never optional. */
function normalizeArgv(tokens: string[]): string[] {
  const argv = tokens[0] === "plasalid" ? tokens.slice(1) : tokens;
  return argv.includes("--json") ? argv : [...argv, "--json"];
}

interface RunSpec {
  tool: string;
  args: string;
  argv: string[];
  rows: number | null;
  stdin?: string;
}

/** The failure arm carries the refusal itself: the model reads it as the answer. */
type StagedRun = { ok: true; value: RunSpec } | { ok: false; refusal: ToolResult };

async function runArgv(runner: PlasalidRunner, spec: RunSpec): Promise<ToolResult> {
  const command = `plasalid ${spec.argv.join(" ")}`;
  const base = {
    tool: spec.tool,
    subcommand: subcommandOf(spec.argv, spec.tool),
    args: spec.args,
    command,
    rows: spec.rows,
  };
  const result = await runner.run(
    spec.argv,
    spec.stdin === undefined ? {} : { stdin: spec.stdin },
  );
  if (!result.ok) {
    return toolResult(
      JSON.stringify({ exit_code: null, stdout: "", stderr: result.message }),
      {
        ...base,
        ok: false,
        exitCode: null,
        rejected: null,
        message: `${result.reason}: ${result.message}`,
        hint: null,
        commit: null,
      },
      null,
    );
  }

  // Artifacts come from the untruncated stdout: what the host carries back must
  // not depend on how much of the reply fit in the model's copy.
  const ran = result.value;
  return toolResult(
    truncate(
      JSON.stringify({ exit_code: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr }),
      MAX_TOOL_CONTENT,
    ),
    {
      ...base,
      ok: ran.exitCode === 0,
      exitCode: ran.exitCode,
      rejected: null,
      message: firstLine(ran.stderr) || firstLine(ran.stdout),
      hint: hintOf(ran.stderr),
      commit: commitCountersOf(ran.stdout),
    },
    ran.exitCode === 0 ? artifactsOf(ran.stdout) : null,
  );
}

const REFUSED_SHELL =
  "refused: args cannot contain | & ; < > ` or $. Run one plasalid command per call and send a batch through the `stdin` field instead of a pipe.";

function countRows(ndjson: string): number {
  return ndjson.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * A batch reaches `ingest commit` as NDJSON on stdin, so its line count is how
 * many rows the model sent — the one figure the commit summary cannot supply, and
 * what a posted count has to be read against. Null for every other command,
 * because stdin carries a password there, not rows.
 */
function batchRows(argv: string[], stdin: string | undefined): number | null {
  if (stdin === undefined) return null;
  if (subcommandOf(argv, "") !== COMMIT_SUBCOMMAND) return null;
  return countRows(stdin);
}

function prepareRun(rawArgs: string): StagedRun {
  const spec = {
    tool: "plasalid",
    subcommand: "plasalid",
    args: truncate(rawArgs, MAX_ARGS_ECHO),
    command: "plasalid",
  };
  const parsed = parseArgs(PLASALID_ARGS, rawArgs);
  if (!parsed.ok) return { ok: false, refusal: refuse("bad_tool_args", spec, parsed.error) };

  const args = truncate(parsed.value.args, MAX_ARGS_ECHO);
  const called = { ...spec, args, command: `plasalid ${args}` };
  if (SHELL_METACHARACTERS.test(parsed.value.args)) {
    return { ok: false, refusal: refuse("refused_shell", called, REFUSED_SHELL) };
  }

  const tokens = tokenize(parsed.value.args);
  if (!tokens.ok) return { ok: false, refusal: refuse("bad_tool_args", called, tokens.error) };

  const argv = normalizeArgv(tokens.value);
  return {
    ok: true,
    value: {
      tool: "plasalid",
      args,
      argv,
      rows: batchRows(argv, parsed.value.stdin),
      ...(parsed.value.stdin === undefined ? {} : { stdin: parsed.value.stdin }),
    },
  };
}

function createPlasalidTool(plasalid: PlasalidRunner): Tool {
  return {
    name: "plasalid",
    description:
      "Run one plasalid command. `args` is the argument string after `plasalid` (--json is added for you). Optional `stdin` is piped to the command's standard input. No shell operators.",
    parameters: jsonSchema(PLASALID_ARGS),
    async invoke(rawArgs) {
      const prepared = prepareRun(rawArgs);
      if (!prepared.ok) return prepared.refusal;
      return runArgv(plasalid, prepared.value);
    },
  };
}

export function createTools(plasalid: PlasalidRunner): Tool[] {
  return [createPlasalidTool(plasalid)];
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
