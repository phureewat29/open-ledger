import type { OperationalType, PhaseExit, PhaseId, RunEvent } from "./events.js";

/**
 * The only subscriber that keeps state. It tallies volume and keeps the raw
 * event stream, so the scorecard can re-derive every analysis from the recorded
 * run and the JSON report can be re-read offline.
 */

export interface PhaseTally {
  phase: PhaseId;
  title: string;
  llmCalls: number;
  toolCalls: number;
  failedToolCalls: number;
  reply: string;
  /** null until the phase ends, so a phase cut short by the endpoint stays visible. */
  exit: PhaseExit | null;
}

export interface RunMetrics {
  events: RunEvent[];
  phases: PhaseTally[];
  llmCalls: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** true when any call's token counts were estimated rather than reported. */
  tokensEstimated: boolean;
  contextTrims: number;
  /** One count per operational event, so a new kind cannot go unreported. */
  operational: Record<OperationalType, number>;
  /** Questions oled raised across every commit. */
  questionsRaised: number;
}

export interface Recorder {
  observe(event: RunEvent): void;
  snapshot(): RunMetrics;
}

interface Totals {
  tokensIn: number;
  tokensOut: number;
  tokensEstimated: boolean;
  contextTrims: number;
  operational: Record<OperationalType, number>;
  questionsRaised: number;
}

/** One entry per OperationalType: a new kind fails to compile until it is counted. */
const NO_OPERATIONS: Record<OperationalType, number> = {
  endpoint_retry: 0,
  stall_prod: 0,
  artifacts_attached: 0,
  artifacts_capped: 0,
  artifacts_unreadable: 0,
  artifacts_no_route: 0,
};

type Handler<K extends RunEvent["type"]> = (
  event: Extract<RunEvent, { type: K }>,
  tally: PhaseTally,
  totals: Totals,
) => void;

/** One entry per RunEvent member: a new event type fails to compile until handled. */
const HANDLERS: { [K in RunEvent["type"]]: Handler<K> } = {
  phase_start: (event, tally) => {
    tally.title = event.title;
  },
  phase_end: (event, tally) => {
    tally.reply = event.reply;
    tally.exit = event.exit;
  },
  llm_call: (event, tally, totals) => {
    tally.llmCalls += 1;
    totals.tokensIn += event.usage.promptTokens;
    totals.tokensOut += event.usage.completionTokens;
    totals.tokensEstimated = totals.tokensEstimated || event.usage.estimated;
  },
  tool_call: (event, tally, totals) => {
    tally.toolCalls += 1;
    if (!event.ok) tally.failedToolCalls += 1;
    totals.questionsRaised += event.commit?.questionsRaised ?? 0;
  },
  context_trim: (_event, _tally, totals) => {
    totals.contextTrims += 1;
  },
  operational: (event, _tally, totals) => {
    totals.operational[event.operation] += 1;
  },
};

export function createRecorder(): Recorder {
  const events: RunEvent[] = [];
  const phases = new Map<PhaseId, PhaseTally>();
  const totals: Totals = {
    tokensIn: 0,
    tokensOut: 0,
    tokensEstimated: false,
    contextTrims: 0,
    operational: { ...NO_OPERATIONS },
    questionsRaised: 0,
  };

  const forPhase = (phase: PhaseId): PhaseTally => {
    const existing = phases.get(phase);
    if (existing) return existing;
    const created: PhaseTally = {
      phase,
      title: phase,
      llmCalls: 0,
      toolCalls: 0,
      failedToolCalls: 0,
      reply: "",
      exit: null,
    };
    phases.set(phase, created);
    return created;
  };

  return {
    observe(event) {
      events.push(event);
      const handler = HANDLERS[event.type] as Handler<RunEvent["type"]>;
      handler(event, forPhase(event.phase), totals);
    },

    snapshot() {
      const ordered = [...phases.values()];
      return {
        events,
        phases: ordered,
        llmCalls: ordered.reduce((sum, phase) => sum + phase.llmCalls, 0),
        toolCalls: ordered.reduce((sum, phase) => sum + phase.toolCalls, 0),
        ...totals,
      };
    },
  };
}
