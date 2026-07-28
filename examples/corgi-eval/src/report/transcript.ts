import type { Phase } from "../scenario.js";
import type { PhaseId, RunEvent } from "./events.js";

/**
 * What the user asked and what they got back, per phase. The turn-by-turn
 * detail is not repeated here: `events` already holds every reply and every
 * tool call, and storing them twice let the two copies disagree.
 */

export interface PhaseTranscript {
  phase: PhaseId;
  title: string;
  prompt: string;
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
        reply: "",
      };
      phases.push(current);
      continue;
    }
    if (current && event.type === "phase_end") current.reply = event.reply;
  }

  return phases;
}
