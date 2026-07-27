/**
 * The run's observable vocabulary. The runner emits these; the recorder is the
 * only subscriber that keeps state, and the scorecard reads the recorded stream
 * back to derive every analysis. No event carries a duration: this run measures
 * how a model and the OpenLedger contract fit together, not how fast either is.
 */

export type PhaseId = "orient" | "ingest" | "resolve" | "answer";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** true when the server omitted `usage` and the runner estimated chars/4. */
  estimated: boolean;
}

/** How the harness refused a tool call before any command could run. */
export type RejectionType = "unknown_tool" | "bad_tool_args" | "refused_shell";

/**
 * Why a phase's loop ended. A model that answered, one that ran out of calls and
 * one that went quiet look identical in a reply count and mean nothing alike.
 */
export type PhaseExit = "answered" | "call_cap" | "stalled";

/** `ingest commit` counters, read back from its NDJSON summary. */
export interface CommitCounters {
  posted: number;
  duplicates: number;
  failed: number;
  questionsRaised: number;
}

export interface ToolObservation {
  tool: string;
  /** The command path oled dispatches on (`ingest commit`), or the tool name. */
  subcommand: string;
  /** The argument string the model passed, truncated; bulk rows travel on stdin. */
  args: string;
  /** Reproducible display of what ran. */
  command: string;
  ok: boolean;
  /** null when nothing ran: the harness refused the call, or the process never finished. */
  exitCode: number | null;
  rejected: RejectionType | null;
  /** First stderr line, or the harness's refusal message. */
  message: string;
  /** oled's `hint` field, when the error carried one. */
  hint: string | null;
  /** NDJSON lines piped to `ingest commit` on stdin; null for every other call. */
  rows: number | null;
  commit: CommitCounters | null;
  /** The tool's reply to the model, truncated, so the log carries the transcript. */
  result: string;
}

/**
 * Kept because the run needs them, excluded from the eval: they describe the
 * endpoint, the loop that drives it, and what the host carried on the model's
 * behalf, not the model's fit with the contract. Every one of them is recorded,
 * because a payload the host silently dropped would look like a model mistake.
 */
export type OperationalType =
  | "endpoint_retry"
  | "stall_prod"
  /** The host delivered what a command produced. */
  | "artifacts_attached"
  /** A size or count cap dropped part of it. */
  | "artifacts_capped"
  /** A file oled named could not be read. */
  | "artifacts_unreadable"
  /** The model's input types allow no route for it. */
  | "artifacts_no_route";

export type RunEvent =
  | { type: "phase_start"; phase: PhaseId; title: string }
  | { type: "phase_end"; phase: PhaseId; reply: string; exit: PhaseExit }
  | {
      type: "llm_call";
      phase: PhaseId;
      /** 1-based position in the run, so a turn's calls can be told from a later one's. */
      turn: number;
      /** The assistant's text for this turn, truncated. */
      content: string;
      finishReason: string | null;
      toolCalls: number;
      usage: TokenUsage;
    }
  /**
   * `turn` is the llm_call that dispatched it. Calls sharing a turn were sent
   * together, before any of their results existed, so none of them could have
   * been informed by another's reply.
   */
  | ({ type: "tool_call"; phase: PhaseId; turn: number } & ToolObservation)
  | { type: "context_trim"; phase: PhaseId }
  /** `operation`, not `type`: `type` is already this union's own tag. */
  | { type: "operational"; phase: PhaseId; operation: OperationalType; detail: string };

export type EventSink = (event: RunEvent) => void;
