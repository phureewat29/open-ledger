import type { WorkspacePaths } from "./workspace.js";
import { runDemo, type DemoOptions } from "./orchestrate.js";
import { parseMarkdown, renderPlain } from "./markdown.js";

const DIVIDER = "-".repeat(60);
const HEARTBEAT_MS = 15_000;

/** The single seam between the orchestration and its output: runDemo knows
 *  nothing about how progress is rendered. */
export interface Reporter {
  step(label: string, ok: boolean, detail?: string): void;
  turnStart(turn: number, total: number, prompt: string): void;
  turnActivity(line: string): void;
  turnAnswer(text: string): void;
  /** Last (up to) 3 stderr lines from a turn that otherwise succeeded. */
  turnStderr(lines: string[]): void;
  turnDone(ok: boolean, durationMs: number | undefined, oledCalls: number): void;
  info(line: string): void;
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function formatSeconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

export function makePlainReporter(): Reporter {
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let turnStartedAt = 0;
  let turn = 0;

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }
  function scheduleHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      console.log(`... thinking (${formatSeconds(Date.now() - turnStartedAt)})`);
      scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  return {
    step(label, ok, detail) {
      // A step that follows the turns must not butt against the last divider.
      if (turn > 0) console.log("");
      console.log(`${ok ? "[ ok ]" : "[fail]"} ${label}${detail ? `  ${detail}` : ""}`);
    },
    turnStart(n, total, prompt) {
      turn = n;
      console.log("");
      console.log(DIVIDER);
      console.log(`turn ${n}/${total}: ${prompt}`);
      turnStartedAt = Date.now();
      scheduleHeartbeat();
    },
    turnActivity(line) {
      scheduleHeartbeat();
      console.log(line);
    },
    turnAnswer(text) {
      // No heartbeat rearm - turnDone clears it right after.
      console.log("");
      console.log("answer:");
      console.log(renderPlain(parseMarkdown(text)));
    },
    turnStderr(lines) {
      for (const line of lines) console.log(`stderr: ${line}`);
    },
    turnDone(ok, durationMs, oledCalls) {
      clearHeartbeat();
      console.log(DIVIDER);
      let head = `turn ${turn} ${ok ? "done" : "failed"}`;
      if (typeof durationMs === "number") head += ` in ${formatSeconds(durationMs)}`;
      console.log(`${head} · ${pluralize(oledCalls, "oled call")}`);
    },
    info(line) {
      console.log(line);
    },
  };
}

export async function runPlain(
  opts: DemoOptions,
  onWorkspaceReady: (paths: WorkspacePaths) => void,
  keepWorkspace: boolean,
): Promise<number> {
  console.log("corgi-claude demo");
  const reporter = makePlainReporter();
  const outcome = await runDemo(opts, reporter, onWorkspaceReady);
  if (outcome.paths && keepWorkspace) {
    reporter.info(`workspace kept at ${outcome.paths.root}`);
  }
  console.log(outcome.pass ? "PASS" : "FAIL");
  return outcome.pass ? 0 : 1;
}
