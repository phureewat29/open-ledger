/**
 * Spawns `claude -p --output-format stream-json --include-partial-messages
 * --verbose` and turns its NDJSON event stream into what the demo UI needs:
 * activity lines ("> plasalid ..." / "> Read ..." / "> Write ...") per
 * tool_use, coalesced live-streaming answer text, skill/plasalid-call usage
 * signals, and the turn's final answer/duration.
 *
 * Event shapes observed from a real run (claude_code_version 2.1.211):
 *
 *   {"type":"system","subtype":"init",...}                      — ignored
 *   {"type":"system","subtype":"status","status":"requesting"}  — ignored
 *   {"type":"stream_event","event":{"type":"message_start",...}}
 *   {"type":"stream_event","event":{"type":"content_block_start",...}}
 *   {"type":"stream_event","event":{"type":"content_block_delta",
 *      "delta":{"type":"text_delta","text":"O"}}}                — live text
 *   {"type":"stream_event","event":{"type":"content_block_delta",
 *      "delta":{"type":"input_json_delta","partial_json":"..."}}} — ignored
 *      (too fragile to reassemble; the complete "assistant" event below
 *      carries the parsed input instead)
 *   {"type":"stream_event","event":{"type":"content_block_stop"|"message_delta"|"message_stop"}}
 *   {"type":"assistant","message":{"content":[{"type":"thinking",...}|
 *      {"type":"tool_use","name":"Bash","input":{"command":"..."}}|
 *      {"type":"tool_use","name":"Read","input":{"file_path":"..."}}|
 *      {"type":"tool_use","name":"Skill","input":{"command":"<skill-name>"}}|
 *      {"type":"text","text":"..."}]}}                           — tool_use
 *      blocks carry the FULL parsed input, so activity lines are built from
 *      this event, not the partial input_json_delta fragments above.
 *   {"type":"user","message":{"content":[{"type":"tool_result",...}]}}  — ignored
 *   {"type":"result","subtype":"success","result":"<final answer text>",
 *      "duration_ms":84213,"total_cost_usd":0.1234,"usage":{...},...}
 *      — the turn's authoritative final answer and duration. `total_cost_usd`
 *      is present but not surfaced by this demo's UI.
 *
 * Anything else (and any field access below) is handled defensively: unknown
 * types are ignored, missing/mistyped fields degrade to empty/no-op rather
 * than throw - this is a best-effort live view; the turn's real outcome is
 * the exit code plus the "result" event's answer text.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ClaudeTurnOptions {
  prompt: string;
  /** Pass `--continue` so this turn resumes the demo's own session. */
  continueSession: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** e.g. "Bash(plasalid:*),Read,Write,Skill" */
  allowedTools: string;
  /** SIGTERM (then SIGKILL after 5s) the turn if it runs past this many
   *  seconds. Always supplied by the caller (see the demo's --turn-timeout). */
  turnTimeoutSec: number;
}

export type ClaudeStreamEvent =
  /** One tool invocation, already formatted as a "> ..." display line. */
  | { kind: "activity"; line: string }
  /** A coalesced chunk of the assistant's streaming answer text (live/optimistic). */
  | { kind: "delta"; text: string }
  /** The agent invoked the Skill tool (skillName is best-effort, may be null). */
  | { kind: "skill"; skillName: string | null }
  /** The agent ran a Bash tool_use whose command starts with `plasalid`. */
  | { kind: "plasalid-call" };

export interface ClaudeTurnResult {
  ok: boolean;
  exitCode: number | null;
  /** The authoritative final answer, sourced from the "result" event. */
  answer: string;
  /** From the "result" event's `duration_ms`, when present. */
  durationMs?: number;
  /** Set when the turn was killed for running past `turnTimeoutSec`. */
  timedOut?: boolean;
  /** Last (up to) 3 non-blank stderr lines, only populated when the turn
   *  succeeded but still wrote something to stderr. */
  stderrTail?: string[];
}

/** How long to buffer text_delta chunks before flushing a coalesced "delta"
 *  event - caps the UI update rate without waiting for the full answer. */
const DELTA_FLUSH_MS = 80;

const ACTIVITY_LINE_MAX = 120;

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 3))}...` : oneLine;
}

/** Last (up to) `n` non-blank lines of `s`, trimmed of trailing whitespace. */
function lastLines(s: string, n: number): string[] {
  const lines = s
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  return lines.slice(-n);
}

/** String field off a tool_use's parsed input, or "" if absent/wrong type. */
function stringField(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "";
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

/** Best-effort skill name from a Skill tool_use's input: the field name
 *  isn't documented, so try likely candidates and fall back to null. */
function skillNameFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  for (const key of ["command", "skill", "skill_name", "name"]) {
    const v = obj[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** Builds the "> ..." activity line for a non-Bash tool_use (Bash is
 *  handled inline in the "assistant" case below, so its command is derived
 *  once). Read/Write/Skill are expected; any other tool still gets a bare
 *  "> ToolName" line rather than being silently dropped. */
function activityLineForNonBashToolUse(name: unknown, input: unknown): string | null {
  if (name === "Read") {
    return `> Read ${stringField(input, "file_path")}`;
  }
  if (name === "Write") {
    return `> Write ${stringField(input, "file_path")}`;
  }
  if (typeof name === "string" && name) return `> ${name}`;
  return null;
}

export interface StreamParserResult {
  answer: string;
  durationMs?: number;
}

/** Incrementally parses one turn's NDJSON stdout lines into ClaudeStreamEvents.
 *  Pulled out of `runClaudeTurn` so it can be driven by a synthetic line feed
 *  in tests/dev scripts without spawning a real `claude` process. */
export interface StreamParser {
  /** Feed one raw stdout line (may be blank/partial/non-JSON; handled defensively). */
  handleLine(rawLine: string): void;
  /** Flush any buffered delta text immediately, emitting a final "delta" event if non-empty. */
  flush(): void;
  /** Cancel any pending internal timers. Safe to call more than once. */
  dispose(): void;
  /** Snapshot of the result fields accumulated so far. */
  getResult(): StreamParserResult;
}

export function createStreamParser(onEvent: (event: ClaudeStreamEvent) => void): StreamParser {
  let finalAnswer = "";
  let durationMs: number | undefined;
  let deltaBuffer = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushNow(): void {
    if (deltaBuffer.length === 0) return;
    const text = deltaBuffer;
    deltaBuffer = "";
    onEvent({ kind: "delta", text });
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushNow();
    }, DELTA_FLUSH_MS);
  }

  function handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    let evt: unknown;
    try {
      evt = JSON.parse(line);
    } catch {
      return; // partial/non-JSON line: ignore defensively
    }
    if (!evt || typeof evt !== "object") return;
    const e = evt as Record<string, unknown>;

    switch (e.type) {
      case "assistant": {
        const message = e.message as { content?: unknown } | undefined;
        const content = message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use") {
              const b = block as { name?: unknown; input?: unknown };
              if (b.name === "Bash") {
                // Derive the command string once, then feed it to BOTH the
                // activity line and the plasalid-call signal.
                const command = stringField(b.input, "command");
                onEvent({ kind: "activity", line: `> ${truncate(command, ACTIVITY_LINE_MAX)}` });
                if (command.trim().startsWith("plasalid")) onEvent({ kind: "plasalid-call" });
                continue;
              }
              const activityLine = activityLineForNonBashToolUse(b.name, b.input);
              if (activityLine) onEvent({ kind: "activity", line: activityLine });
              if (b.name === "Skill") {
                onEvent({ kind: "skill", skillName: skillNameFromInput(b.input) });
              }
            }
          }
        }
        break;
      }
      case "stream_event": {
        const inner = e.event as { type?: unknown; delta?: unknown } | undefined;
        if (inner?.type === "content_block_delta") {
          const delta = inner.delta as { type?: unknown; text?: unknown } | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
            deltaBuffer += delta.text;
            scheduleFlush();
          }
        }
        break;
      }
      case "result": {
        if (typeof e.result === "string") finalAnswer = e.result;
        if (typeof e.duration_ms === "number") durationMs = e.duration_ms;
        break;
      }
      default:
        // system/user/other events aren't needed for this demo's display.
        break;
    }
  }

  return {
    handleLine,
    flush() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushNow();
    },
    dispose() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    },
    getResult() {
      return { answer: finalAnswer, durationMs };
    },
  };
}

/**
 * Run one `claude -p` turn, streaming activity/delta/skill/plasalid-call
 * events to `onEvent` as they arrive, resolving once the process exits (or
 * is killed for timing out) with the turn's outcome.
 */
export function runClaudeTurn(
  opts: ClaudeTurnOptions,
  onEvent: (event: ClaudeStreamEvent) => void,
): Promise<ClaudeTurnResult> {
  return new Promise((resolvePromise) => {
    const args = ["-p"];
    if (opts.continueSession) args.push("--continue");
    args.push(opts.prompt, "--allowedTools", opts.allowedTools, "--output-format", "stream-json");
    args.push("--include-partial-messages", "--verbose");
    args.push("--model", "sonnet");

    // detached: own process group, so a timeout kills the whole tree (helpers
    // share our stdout pipe; killing just the parent means "close" never fires).
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stderrBuf = "";
    let closed = false;
    let timedOut = false;

    const parser = createStreamParser(onEvent);
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (raw) => parser.handleLine(raw));

    child.stderr.on("data", (chunk) => {
      stderrBuf += String(chunk);
    });

    /** Signal claude's whole process group; falls back to the single pid when
     *  the group is already gone. */
    function killTree(signal: NodeJS.Signals): void {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already dead
        }
      }
    }

    const turnTimeoutSec = opts.turnTimeoutSec;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => {
        if (!closed) killTree("SIGKILL");
      }, 5000);
    }, turnTimeoutSec * 1000);

    function clearTimers(): void {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    }

    child.on("error", (err) => {
      closed = true;
      clearTimers();
      parser.dispose();
      resolvePromise({ ok: false, exitCode: null, answer: stderrBuf || err.message });
    });

    child.on("close", (code) => {
      closed = true;
      clearTimers();
      parser.flush();
      parser.dispose();
      const { answer, durationMs } = parser.getResult();

      if (timedOut) {
        resolvePromise({
          ok: false,
          exitCode: code,
          answer: `turn timed out after ${turnTimeoutSec}s`,
          durationMs,
          timedOut: true,
        });
        return;
      }

      const ok = code === 0;
      const stderrTail = ok && stderrBuf.trim() ? lastLines(stderrBuf, 3) : undefined;
      resolvePromise({ ok, exitCode: code, answer: answer || stderrBuf, durationMs, stderrTail });
    });
  });
}
