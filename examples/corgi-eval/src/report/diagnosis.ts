import { groupBy, orderBy, uniq } from "es-toolkit";
import { errorShapeOf, plainMessage, type ErrorShape } from "../oled/contract.js";
import type { PhaseExit, PhaseId, RunEvent, ToolObservation } from "./events.js";
import type { PhaseTally } from "./recorder.js";

// Diagnoses why a run stopped, without scoring: the question the scorecard doesn't answer.

export type MissingKind = "tool" | "command" | "flag";

interface MissingCapability {
  kind: MissingKind;
  /** Verbatim, as the model asked for it. */
  asked: string;
  count: number;
  phases: PhaseId[];
  /** The first call that asked for it. */
  command: string;
}

interface SelfReportedBlocker {
  phase: PhaseId;
  /** Which reply of the phase said it, counting from 1. */
  reply: number;
  /** The model's own sentence, verbatim. */
  sentence: string;
}

interface PhaseLedger {
  postedRows: number;
  filesIngested: number;
  questionsOpen: number;
}

/** The ledger read back after a phase; null when that read itself failed. */
export interface PhaseSnapshot {
  phase: PhaseId;
  ledger: PhaseLedger | null;
}

export interface PhaseProgress {
  phase: PhaseId;
  title: string;
  /** null when the phase never ended, which only happens if the endpoint failed. */
  exit: PhaseExit | null;
  ledger: PhaseLedger | null;
}

/** The earliest thing that plausibly stopped progress: a cascade follows the first wall. */
export interface Wall {
  kind: "unknown_tool" | "missing_capability" | "self_reported";
  phase: PhaseId;
  /** Position within the phase, counting tool calls for a call and replies for a reply. */
  index: number;
  detail: string;
}

export interface RunDiagnosis {
  firstWall: Wall | null;
  missing: MissingCapability[];
  blockers: SelfReportedBlocker[];
  progress: PhaseProgress[];
}

interface DiagnosisInput {
  events: RunEvent[];
  phases: PhaseTally[];
  snapshots: PhaseSnapshot[];
}

/**
 * Which of oled's error shapes names something the CLI does not have. A flag
 * given a bad or empty value is not one: the flag exists, so it is friction
 * over its value, and reporting it here read as a capability the CLI lacks.
 */
const MISSING_BY_SHAPE: Record<ErrorShape, MissingKind | null> = {
  unknown_flag: "flag",
  unknown_command: "command",
  flag_value: null,
};

// First-person inability, present tense: a conditional like "if I couldn't map a
// category" describes a rule the model was explaining, not a wall it hit.
const BLOCKER_PATTERNS = [
  /\bI (?:cannot|can't|can not)\b/i,
  /\bI(?:'m| am) unable to\b/i,
  /\bI (?:do not|don't) have\b/i,
  /\bI have no (?:way|tool|means|ability)\b/i,
  /\bthere (?:is|'s) no way (?:for me )?to\b/i,
  /\bwithout access to\b/i,
  /\bno (?:ability|capability|tool|way)\b[^.\n]{0,40}\b(?:read|see|view|open)\b/i,
];

const MAX_SENTENCE = 300;

/** The harness names the tool itself, so no message has to be read for that case. */
function askedFor(observation: ToolObservation): { kind: MissingKind; asked: string } | null {
  if (observation.ok) return null;
  if (observation.rejected === "unknown_tool") {
    return { kind: "tool", asked: observation.tool };
  }
  const shape = errorShapeOf(observation.message);
  if (!shape) return null;
  const kind = MISSING_BY_SHAPE[shape.shape];
  return kind === null ? null : { kind, asked: shape.asked };
}

function blockerSentences(content: string): string[] {
  const found: string[] = [];
  for (const sentence of content.split(/(?<=[.!?])\s+|\n+/)) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (!BLOCKER_PATTERNS.some((pattern) => pattern.test(trimmed))) continue;
    found.push(trimmed.slice(0, MAX_SENTENCE));
  }
  return uniq(found);
}

interface Ask {
  kind: MissingKind;
  asked: string;
  phase: PhaseId;
  command: string;
}

function buildMissing(events: RunEvent[]): MissingCapability[] {
  const asks: Ask[] = [];
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const asked = askedFor(event);
    if (asked) asks.push({ ...asked, phase: event.phase, command: event.command });
  }

  const groups = groupBy(asks, (ask) => `${ask.kind} ${ask.asked}`);
  const rows = Object.values(groups).map((group) => {
    const { kind, asked, command } = group[0]!;
    return { kind, asked, count: group.length, phases: uniq(group.map((ask) => ask.phase)), command };
  });
  return orderBy(rows, ["count", "asked"], ["desc", "asc"]);
}

function buildBlockers(events: RunEvent[]): SelfReportedBlocker[] {
  const llmCalls = events.filter((event) => event.type === "llm_call");
  const byPhase = groupBy(llmCalls, (event) => event.phase);
  return Object.values(byPhase).flatMap((calls) =>
    calls.flatMap((event, index) =>
      blockerSentences(event.content).map((sentence) => ({
        phase: event.phase,
        reply: index + 1,
        sentence,
      })),
    ),
  );
}

function buildProgress(phases: PhaseTally[], snapshots: PhaseSnapshot[]): PhaseProgress[] {
  return phases.map((tally) => ({
    phase: tally.phase,
    title: tally.title,
    exit: tally.exit,
    ledger: snapshots.find((snapshot) => snapshot.phase === tally.phase)?.ledger ?? null,
  }));
}

function findFirstWall(events: RunEvent[]): Wall | null {
  const calls = new Map<PhaseId, number>();
  const replies = new Map<PhaseId, number>();
  for (const event of events) {
    if (event.type === "tool_call") {
      const index = (calls.get(event.phase) ?? 0) + 1;
      calls.set(event.phase, index);
      if (event.rejected === "unknown_tool") {
        return {
          kind: "unknown_tool",
          phase: event.phase,
          index,
          detail: `called a tool that does not exist: ${plainMessage(event.message)}`,
        };
      }
      const asked = askedFor(event);
      if (asked) {
        return {
          kind: "missing_capability",
          phase: event.phase,
          index,
          detail: `asked for ${asked.asked}, which the CLI does not have (${event.command})`,
        };
      }
      continue;
    }
    if (event.type !== "llm_call") continue;

    const index = (replies.get(event.phase) ?? 0) + 1;
    replies.set(event.phase, index);
    const sentence = blockerSentences(event.content)[0];
    if (sentence) {
      return { kind: "self_reported", phase: event.phase, index, detail: sentence };
    }
  }
  return null;
}

export function buildDiagnosis(input: DiagnosisInput): RunDiagnosis {
  return {
    firstWall: findFirstWall(input.events),
    missing: buildMissing(input.events),
    blockers: buildBlockers(input.events),
    progress: buildProgress(input.phases, input.snapshots),
  };
}
