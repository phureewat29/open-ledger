import type { Phase } from "../scenario.js";
import type { PhaseId, RunEvent } from "./events.js";

/**
 * The conversation, rebuilt from the event stream: what was asked, what the
 * model said, what it ran, and what came back. Persisted so a report can be read
 * end to end without the model or the sandbox.
 */

export interface TranscriptToolCall {
  tool: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  /** The tool's reply to the model, truncated at the source. */
  result: string;
}

export interface TranscriptTurn {
  reply: string;
  finishReason: string | null;
  toolCalls: TranscriptToolCall[];
}

export interface PhaseTranscript {
  phase: PhaseId;
  title: string;
  prompt: string;
  turns: TranscriptTurn[];
  /** The last non-empty reply of the phase: what the user would have read. */
  reply: string;
}

export function buildTranscript(events: RunEvent[], scenario: Phase[]): PhaseTranscript[] {
  const promptFor = (phase: PhaseId): string =>
    scenario.find((entry) => entry.id === phase)?.prompt ?? "";
  const phases: PhaseTranscript[] = [];
  let current: PhaseTranscript | null = null;

  for (const event of events) {
    if (event.type === "phase_start") {
      current = {
        phase: event.phase,
        title: event.title,
        prompt: promptFor(event.phase),
        turns: [],
        reply: "",
      };
      phases.push(current);
      continue;
    }
    if (!current) continue;
    if (event.type === "llm_call") {
      current.turns.push({
        reply: event.content,
        finishReason: event.finishReason,
        toolCalls: [],
      });
      continue;
    }
    if (event.type === "tool_call") {
      current.turns.at(-1)?.toolCalls.push({
        tool: event.tool,
        command: event.command,
        ok: event.ok,
        exitCode: event.exitCode,
        result: event.result,
      });
      continue;
    }
    if (event.type === "phase_end") current.reply = event.reply;
  }

  return phases;
}
