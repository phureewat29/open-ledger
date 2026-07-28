// No event carries a duration: this run measures how a model and the
// OpenLedger contract fit together, not how fast either is.

export type PhaseId = "ingest" | "resolve" | "answer";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** true when the server omitted `usage` and the runner estimated chars/4. */
  estimated: boolean;
}

/** How the harness refused a tool call before any command could run. */
export type RejectionType =
  | "unknown_tool"
  | "bad_tool_args"
  | "refused_shell"
  /** A `<placeholder>` was copied from the docs instead of a real value. */
  | "refused_placeholder"
  /** The command acts on the operator's machine, not the sandbox. */
  | "refused_command";

// Why a phase's loop ended - "answered", "call_cap", "stalled" mean very different things
// despite producing the same reply count.
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
  command: string;
  ok: boolean;
  /** null when nothing ran: the harness refused the call, or the process never finished. */
  exitCode: number | null;
  rejected: RejectionType | null;
  /** First stderr line, or the harness's refusal message. */
  message: string;
  /** oled's `hint` field, when the error carried one. */
  hint: string | null;
  /** The host piped the model's `stdin` field into the command. */
  stdin: boolean;
  /** NDJSON lines piped to `ingest commit` on stdin; null for every other call. */
  rows: number | null;
  commit: CommitCounters | null;
  /** The tool's reply to the model, truncated, so the log carries the transcript. */
  result: string;
}

/**
 * Excluded from the eval score - these describe the endpoint and host, not the
 * model - but still recorded, since a payload the host silently dropped would
 * otherwise look like a model mistake.
 */
export type OperationalType =
  | "endpoint_retry"
  | "stall_prod"
  | "artifacts_attached"
  /** A size or count cap dropped part of it. */
  | "artifacts_capped"
  /** A file oled named could not be read, or a `prepare` payload the host could not parse. */
  | "artifacts_unreadable"
  /** The model's input types allow no route for it. */
  | "artifacts_no_route";

/** An operational event a host step produced, minus the phase the runner knows. */
export interface OperationalNote {
  operation: OperationalType;
  detail: string;
}

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
  // Calls sharing a `turn` were sent together, before any of their results existed.
  | ({ type: "tool_call"; phase: PhaseId; turn: number } & ToolObservation)
  | { type: "context_trim"; phase: PhaseId }
  /** `operation`, not `type`: `type` is already this union's own tag. */
  | { type: "operational"; phase: PhaseId; operation: OperationalType; detail: string };

export type EventSink = (event: RunEvent) => void;
