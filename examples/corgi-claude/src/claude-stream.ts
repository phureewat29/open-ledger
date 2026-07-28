/**
 * Parses `claude -p --output-format stream-json --verbose` NDJSON stdout into
 * activity/skill/oled-call events. Event shapes observed against
 * claude_code_version 2.1.211: only the complete `assistant` and `result`
 * events are read, since a tool_use block already carries its input fully
 * parsed. Any other or malformed event is ignored rather than throwing.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { stringField, truncate } from "./workspace.js";

interface ClaudeTurnOptions {
  prompt: string;
  continueSession: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  allowedTools: string;
  /** SIGTERM past this many seconds, SIGKILL after a further 5s grace period. */
  turnTimeoutSec: number;
}

export type ClaudeStreamEvent =
  /** One tool invocation, already formatted as a "> ..." display line. */
  | { kind: "activity"; line: string }
  /** The agent invoked the Skill tool. */
  | { kind: "skill" }
  /** The agent ran a Bash tool_use whose command starts with `oled`. */
  | { kind: "oled-call" };

interface ClaudeTurnResult {
  ok: boolean;
  /** The authoritative final answer, sourced from the "result" event. */
  answer: string;
  /** From the "result" event's `duration_ms`, when present. */
  durationMs?: number;
  /** Last (up to) 3 non-blank stderr lines, only populated when the turn
   *  succeeded but still wrote something to stderr. */
  stderrTail?: string[];
}

const ACTIVITY_LINE_MAX = 120;

function lastLines(s: string, n: number): string[] {
  const lines = s
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  return lines.slice(-n);
}

/** Bash is handled inline in the "assistant" case below. Any tool other than
 *  Read/Write still gets a bare "> ToolName" line rather than being dropped. */
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

interface StreamParserResult {
  answer: string;
  durationMs?: number;
}

/** Split out of `runClaudeTurn` so it can be driven by a synthetic line feed
 *  in verify.ts without spawning a real `claude` process. */
interface StreamParser {
  /** Feed one raw stdout line (may be blank/partial/non-JSON; handled defensively). */
  handleLine(rawLine: string): void;
  getResult(): StreamParserResult;
}

export function createStreamParser(onEvent: (event: ClaudeStreamEvent) => void): StreamParser {
  let finalAnswer = "";
  let durationMs: number | undefined;

  function handleAssistantContent(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if ((block as { type?: unknown }).type !== "tool_use") continue;

      const b = block as { name?: unknown; input?: unknown };
      if (b.name === "Bash") {
        // Derive once; used for both the activity line and the oled-call signal.
        const command = stringField(b.input, "command");
        onEvent({ kind: "activity", line: `> ${truncate(command, ACTIVITY_LINE_MAX)}` });
        if (command.trim().startsWith("oled")) onEvent({ kind: "oled-call" });
        continue;
      }
      const activityLine = activityLineForNonBashToolUse(b.name, b.input);
      if (activityLine) onEvent({ kind: "activity", line: activityLine });
      if (b.name === "Skill") onEvent({ kind: "skill" });
    }
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

    if (e.type === "assistant") {
      handleAssistantContent((e.message as { content?: unknown } | undefined)?.content);
      return;
    }
    if (e.type === "result") {
      if (typeof e.result === "string") finalAnswer = e.result;
      if (typeof e.duration_ms === "number") durationMs = e.duration_ms;
    }
  }

  return {
    handleLine,
    getResult() {
      return { answer: finalAnswer, durationMs };
    },
  };
}

export function runClaudeTurn(
  opts: ClaudeTurnOptions,
  onEvent: (event: ClaudeStreamEvent) => void,
): Promise<ClaudeTurnResult> {
  return new Promise((resolvePromise) => {
    const args = ["-p"];
    if (opts.continueSession) args.push("--continue");
    args.push(opts.prompt, "--allowedTools", opts.allowedTools, "--output-format", "stream-json");
    args.push("--verbose");
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
      resolvePromise({ ok: false, answer: stderrBuf || err.message });
    });

    child.on("close", (code) => {
      closed = true;
      clearTimers();
      const { answer, durationMs } = parser.getResult();

      if (timedOut) {
        resolvePromise({ ok: false, answer: `turn timed out after ${turnTimeoutSec}s`, durationMs });
        return;
      }

      const ok = code === 0;
      const stderrTail = ok && stderrBuf.trim() ? lastLines(stderrBuf, 3) : undefined;
      resolvePromise({ ok, answer: answer || stderrBuf, durationMs, stderrTail });
    });
  });
}
