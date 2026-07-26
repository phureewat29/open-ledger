import type { PhaseExit, PhaseId, RunEvent, ToolObservation } from "./events.js";
import type { PhaseTally } from "./recorder.js";

/**
 * Why a run stopped where it did, read off the same event stream as everything
 * else. Nothing here scores: it answers the one question the scorecard cannot,
 * which is whether the harness left the model anything to succeed with. Three
 * runs scored zero rows before anyone noticed the model had no way to read a
 * statement, and every fact needed to see it was already in these events.
 */

/** What the model reached for that does not exist. */
export type MissingKind = "tool" | "command" | "flag" | "flag_value";

export interface MissingCapability {
  kind: MissingKind;
  /** Verbatim, as the model asked for it. */
  asked: string;
  count: number;
  phases: PhaseId[];
  /** The first call that asked for it. */
  command: string;
}

export interface SelfReportedBlocker {
  phase: PhaseId;
  /** Which reply of the phase said it, counting from 1. */
  reply: number;
  /** The model's own sentence, verbatim. */
  sentence: string;
}

export interface PhaseLedger {
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

export interface DiagnosisInput {
  events: RunEvent[];
  phases: PhaseTally[];
  snapshots: PhaseSnapshot[];
}

interface MissingRule {
  kind: MissingKind;
  pattern: RegExp;
  asked: (match: RegExpExecArray) => string;
}

/**
 * Read from what the harness or the CLI said back, never guessed from the
 * arguments: a rule fires only when the reply names the thing that is absent.
 * Anything subtler stays out, because a false gap is worse than a missed one.
 */
const MISSING_RULES: MissingRule[] = [
  { kind: "tool", pattern: /^unknown tool: (.+?)\./, asked: (match) => match[1] ?? "" },
  { kind: "flag", pattern: /unknown option '?(--[a-z0-9-]+)'?/i, asked: (match) => match[1] ?? "" },
  {
    kind: "command",
    pattern: /unknown command '?([a-z0-9:_-]+)'?/i,
    asked: (match) => match[1] ?? "",
  },
  {
    kind: "flag_value",
    pattern: /(--[a-z0-9-]+) must be[^(]*\(got "([^"]+)"\)/i,
    asked: (match) => `${match[1]} ${match[2]}`,
  },
];

/**
 * First-person inability in the present tense. A sentence about the ledger being
 * empty is not a blocker, and neither is a conditional: "if I couldn't map a
 * category" describes a rule the model was explaining, not a wall it hit.
 */
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

/** plasalid's `--json` errors arrive as a JSON line, so the quotes inside are escaped. */
function plainMessage(message: string): string {
  return message.replace(/\\"/g, '"');
}

function askedFor(observation: ToolObservation): { kind: MissingKind; asked: string } | null {
  if (observation.ok) return null;
  const message = plainMessage(observation.message);
  for (const rule of MISSING_RULES) {
    const match = rule.pattern.exec(message);
    if (!match) continue;
    const asked = rule.asked(match);
    if (asked) return { kind: rule.kind, asked };
  }
  return null;
}

function blockerSentences(content: string): string[] {
  const found: string[] = [];
  for (const sentence of content.split(/(?<=[.!?])\s+|\n+/)) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (!BLOCKER_PATTERNS.some((pattern) => pattern.test(trimmed))) continue;
    const kept = trimmed.slice(0, MAX_SENTENCE);
    if (!found.includes(kept)) found.push(kept);
  }
  return found;
}

function buildMissing(events: RunEvent[]): MissingCapability[] {
  const found = new Map<string, MissingCapability>();
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const asked = askedFor(event);
    if (!asked) continue;

    const key = `${asked.kind} ${asked.asked}`;
    const existing = found.get(key);
    if (!existing) {
      found.set(key, { ...asked, count: 1, phases: [event.phase], command: event.command });
      continue;
    }
    existing.count += 1;
    if (!existing.phases.includes(event.phase)) existing.phases.push(event.phase);
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.asked.localeCompare(b.asked));
}

function buildBlockers(events: RunEvent[]): SelfReportedBlocker[] {
  const blockers: SelfReportedBlocker[] = [];
  const replies = new Map<PhaseId, number>();
  for (const event of events) {
    if (event.type !== "llm_call") continue;
    const reply = (replies.get(event.phase) ?? 0) + 1;
    replies.set(event.phase, reply);
    for (const sentence of blockerSentences(event.content)) {
      blockers.push({ phase: event.phase, reply, sentence });
    }
  }
  return blockers;
}

function buildProgress(phases: PhaseTally[], snapshots: PhaseSnapshot[]): PhaseProgress[] {
  return phases.map((tally) => ({
    phase: tally.phase,
    title: tally.title,
    exit: tally.exit,
    ledger: snapshots.find((snapshot) => snapshot.phase === tally.phase)?.ledger ?? null,
  }));
}

/** One pass, first match wins: the earliest wall is the one worth reading first. */
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
