/**
 * The ink renderer's UI state: types, render-clock constants, the single pure
 * reducer that drives every visible update, and the helpers (spinner frames,
 * live-region line budget) that keep the live area bounded.
 *
 * Render clock: one interval (TICK_MS) drives every spinner / elapsed /
 * streaming-text update (see ui.tsx's App). Streaming deltas are never
 * dispatched as they arrive - they're buffered outside React state and merged
 * in only on TICK, which is itself a no-op (same reference) when nothing a
 * viewer would see has changed. See the "TICK" case below.
 *
 * Live region vs. scrollback: only the running step(s) and the active turn
 * re-render live. Everything finished is appended once to the append-only
 * `scrollback` list, which ui.tsx pins with ink's <Static> so it's never
 * repainted. This is what stops the flicker: ink fully repaints the terminal
 * once a frame's dynamic height reaches `stdout.rows`, so the live region is
 * capped to stay strictly below it (computeLiveCaps / LIVE_TURN_CHROME_ROWS).
 *
 * The reducer is pure: STEP_START / TURN_START / TICK carry the clock reading
 * (`at` / `now`) on the action, set by the ink reporter at dispatch time, so
 * the reducer itself never reads the wall clock.
 */

/** Render-clock cadence (ms): drives the elapsed-time ticker, spinner frame,
 *  and the merge of buffered streaming deltas. Fast enough to read as "live"
 *  (250-400ms), while guaranteeing no delta chunk can itself trigger a re-render. */
export const TICK_MS = 300;

/** A delta is treated as "still writing" (vs. "thinking") while it's this
 *  recent. */
export const WRITING_WINDOW_MS = 2000;

/** cli-spinners "dots" braille cycle, indexed by the render clock (see
 *  spinnerFrame) rather than a private timer, so it never commits its own re-render. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Number of distinct spinner frames (exported for the render-clock check). */
export const SPINNER_FRAME_COUNT = SPINNER_FRAMES.length;

/** Spinner glyph for a clock reading: pure in `now`, so it advances once per
 *  tick (`floor(now / TICK_MS) % SPINNER_FRAME_COUNT`) rather than driving its own render. */
export function spinnerFrame(now: number): string {
  return SPINNER_FRAMES[Math.floor(now / TICK_MS) % SPINNER_FRAME_COUNT];
}

export interface StepRow {
  id: string;
  label: string;
  status: "running" | "ok" | "fail";
  detail?: string;
  startedAt: number;
}

export interface TurnData {
  turn: number;
  total: number;
  prompt: string;
  activity: string[];
  /** Coalesced live-streaming answer text; cleared once the authoritative answer lands. */
  streamingText: string;
  /** Timestamp of the last TICK that merged delta text into `streamingText`,
   *  or null if none has arrived; drives "thinking…" vs "writing…". */
  lastDeltaAt: number | null;
  answer: string;
  status: "running" | "ok" | "fail";
  startedAt: number;
  plasalidCalls: number;
  durationMs?: number;
  stderrTail: string[];
}

/** Header text pinned as the first scrollback item (rendered bold cyan). Kept in
 *  state so it sits above all history rather than below it. */
export const HEADER_TEXT = "🐶 corgi-claude — plasalid x claude -p";

export type ScrollbackKind = "header" | "step" | "turn" | "info";

/** One frozen, already-finished thing pinned above the live region. Appended
 *  once and never mutated, so ink's <Static> can render it a single time. */
export type ScrollbackItem =
  | { kind: "header"; key: string; text: string }
  | { kind: "info"; key: string; text: string }
  | { kind: "step"; key: string; step: StepRow }
  | { kind: "turn"; key: string; turn: TurnData };

/** A scrollback item minus its key. Distributive so each union member keeps its
 *  own payload (a plain `Omit` over a union collapses to only the shared keys). */
type ScrollbackDraft = ScrollbackItem extends infer T ? (T extends ScrollbackItem ? Omit<T, "key"> : never) : never;

/** Appends a scrollback item, stamping a key from the current length: since
 *  the list only grows, `sb-${length}` is unique and prior items keep their reference/index. */
function appendItem(scrollback: ScrollbackItem[], draft: ScrollbackDraft): ScrollbackItem[] {
  return [...scrollback, { ...draft, key: `sb-${scrollback.length}` } as ScrollbackItem];
}

export interface UiState {
  /** Append-only, pinned via <Static>; header is always item 0. */
  scrollback: ScrollbackItem[];
  /** Steps currently running (live region). Pinned to scrollback on STEP_DONE. */
  runningSteps: StepRow[];
  activeTurn: TurnData | null;
  /** Info lines emitted mid-turn - held back so they land after the turn's
   *  pinned panel (e.g. "skill loaded"), not above it. Flushed on TURN_DONE. */
  pendingInfo: string[];
  /** Updated on TICK while anything is running; drives spinner/elapsed rendering. */
  now: number;
  done: boolean;
  pass: boolean;
}

export const initialUiState: UiState = {
  scrollback: [{ kind: "header", key: "sb-0", text: HEADER_TEXT }],
  runningSteps: [],
  activeTurn: null,
  pendingInfo: [],
  now: Date.now(),
  done: false,
  pass: false,
};

export type UiAction =
  | { type: "STEP_START"; id: string; label: string; at: number }
  | { type: "STEP_DONE"; id: string; label: string; ok: boolean; detail?: string }
  | { type: "TURN_START"; turn: number; total: number; prompt: string; at: number }
  | { type: "TURN_ACTIVITY"; turn: number; line: string }
  | { type: "TURN_ANSWER"; turn: number; text: string }
  | { type: "TURN_STDERR"; turn: number; lines: string[] }
  | { type: "TURN_DONE"; turn: number; ok: boolean; durationMs?: number; plasalidCalls: number }
  | { type: "INFO"; line: string }
  /** The single render clock. `pendingDelta`/`pendingDeltaTurn` carry any
   *  text buffered since the last TICK (see App's `pendingDeltaRef`) and are
   *  merged into the active turn's `streamingText` here, and only here. */
  | { type: "TICK"; now: number; pendingDelta?: string; pendingDeltaTurn?: number }
  | { type: "FINAL"; pass: boolean };

export function elapsedSeconds(now: number, startedAt: number): number {
  return Math.max(0, Math.round((now - startedAt) / 1000));
}

export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "STEP_START": {
      if (state.runningSteps.some((s) => s.id === action.id)) {
        return {
          ...state,
          runningSteps: state.runningSteps.map((s) =>
            s.id === action.id ? { ...s, status: "running", startedAt: action.at } : s,
          ),
        };
      }
      return {
        ...state,
        runningSteps: [
          ...state.runningSteps,
          { id: action.id, label: action.label, status: "running", startedAt: action.at },
        ],
      };
    }
    case "STEP_DONE": {
      const running = state.runningSteps.find((s) => s.id === action.id);
      const finished: StepRow = {
        id: action.id,
        label: action.label,
        status: action.ok ? "ok" : "fail",
        detail: action.detail,
        startedAt: running?.startedAt ?? state.now,
      };
      return {
        ...state,
        runningSteps: state.runningSteps.filter((s) => s.id !== action.id),
        scrollback: appendItem(state.scrollback, { kind: "step", step: finished }),
      };
    }
    case "TURN_START":
      return {
        ...state,
        activeTurn: {
          turn: action.turn,
          total: action.total,
          prompt: action.prompt,
          activity: [],
          streamingText: "",
          lastDeltaAt: null,
          answer: "",
          status: "running",
          startedAt: action.at,
          plasalidCalls: 0,
          stderrTail: [],
        },
      };
    case "TURN_ACTIVITY":
      if (!state.activeTurn || state.activeTurn.turn !== action.turn) return state;
      return { ...state, activeTurn: { ...state.activeTurn, activity: [...state.activeTurn.activity, action.line] } };
    case "TURN_ANSWER":
      if (!state.activeTurn || state.activeTurn.turn !== action.turn) return state;
      return { ...state, activeTurn: { ...state.activeTurn, answer: action.text, streamingText: "" } };
    case "TURN_STDERR":
      if (!state.activeTurn || state.activeTurn.turn !== action.turn) return state;
      return { ...state, activeTurn: { ...state.activeTurn, stderrTail: action.lines } };
    case "TURN_DONE": {
      if (!state.activeTurn || state.activeTurn.turn !== action.turn) return state;
      const finished: TurnData = {
        ...state.activeTurn,
        status: action.ok ? "ok" : "fail",
        durationMs: action.durationMs,
        plasalidCalls: action.plasalidCalls,
      };
      // Pin the turn, then flush any info buffered during it so those lines land
      // below the panel rather than above it.
      let scrollback = appendItem(state.scrollback, { kind: "turn", turn: finished });
      for (const line of state.pendingInfo) {
        scrollback = appendItem(scrollback, { kind: "info", text: line });
      }
      return { ...state, activeTurn: null, pendingInfo: [], scrollback };
    }
    case "INFO":
      if (state.activeTurn != null) {
        return { ...state, pendingInfo: [...state.pendingInfo, action.line] };
      }
      return { ...state, scrollback: appendItem(state.scrollback, { kind: "info", text: action.line }) };
    case "TICK": {
      const hasPendingDelta =
        typeof action.pendingDelta === "string" &&
        action.pendingDelta.length > 0 &&
        state.activeTurn != null &&
        state.activeTurn.turn === action.pendingDeltaTurn;

      const runningStepsChanged = state.runningSteps.some(
        (s) =>
          s.status === "running" &&
          elapsedSeconds(state.now, s.startedAt) !== elapsedSeconds(action.now, s.startedAt),
      );
      const activeTurnSecondsChanged =
        state.activeTurn != null &&
        elapsedSeconds(state.now, state.activeTurn.startedAt) !==
          elapsedSeconds(action.now, state.activeTurn.startedAt);

      // Spinner is clock-driven: re-render whenever its frame index advances,
      // so it animates off the single TICK cadence, not a private timer.
      const spinnerVisible = state.runningSteps.length > 0 || state.activeTurn != null;
      const spinnerFrameChanged =
        spinnerVisible && Math.floor(state.now / TICK_MS) !== Math.floor(action.now / TICK_MS);

      if (!hasPendingDelta && !runningStepsChanged && !activeTurnSecondsChanged && !spinnerFrameChanged) {
        // Nothing visible changed - same reference, so React bails out of re-rendering.
        return state;
      }

      return {
        ...state,
        now: action.now,
        activeTurn:
          state.activeTurn && hasPendingDelta
            ? {
                ...state.activeTurn,
                streamingText: state.activeTurn.streamingText + action.pendingDelta,
                lastDeltaAt: action.now,
              }
            : state.activeTurn,
      };
    }
    case "FINAL": {
      // Defensive: flush any info still buffered, so a run that ends mid-turn doesn't lose a line.
      let scrollback = state.scrollback;
      for (const line of state.pendingInfo) {
        scrollback = appendItem(scrollback, { kind: "info", text: line });
      }
      return { ...state, scrollback, pendingInfo: [], done: true, pass: action.pass };
    }
    default:
      return state;
  }
}

/** Fixed rows the live TurnBlock spends on chrome (everything but the capped
 *  activity/streaming tail). Worst case (see TurnBlock in ui.tsx): top blank +
 *  divider + prompt + activity marker + streaming blank + streaming marker +
 *  status blank + status row + bottom divider + bottom blank = 10 rows.
 *  computeLiveCaps' guarantee depends on this staying in sync with that layout. */
export const LIVE_TURN_CHROME_ROWS = 10;

/** Slack rows kept free beneath the live region, so one pathological frame
 *  (e.g. a late stderr tail batching normally keeps out) can't reach `stdout.rows`. */
export const SAFETY_ROWS = 2;

export interface LiveCaps {
  activityCap: number;
  streamingCap: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Activity/streaming line caps for a terminal `rows` tall.
 *
 * Budget is what's left after chrome + safety: `rows - LIVE_TURN_CHROME_ROWS -
 * SAFETY_ROWS`. Streaming gets a third of it (2..6 rows); activity gets the
 * rest (3..12 rows). For rows >= 17 this keeps the whole live panel at most
 * `rows - 1` tall, so ink never hits its full-repaint threshold. Below 17 the
 * floors win - the panel may exceed budget on tiny terminals (see ui.tsx) -
 * trading the strict bound for a usable minimum.
 */
export function computeLiveCaps(rows: number): LiveCaps {
  const budget = rows - LIVE_TURN_CHROME_ROWS - SAFETY_ROWS;
  const streamingCap = clamp(Math.floor(budget / 3), 2, 6);
  const activityCap = clamp(budget - streamingCap, 3, 12);
  return { activityCap, streamingCap };
}

export interface VisualTail {
  /** The kept tail, one string per wrapped visual row. */
  lines: string[];
  /** How many visual rows were dropped above the tail. */
  hiddenRows: number;
}

/** Soft-wrap one source line into rows of at most `width` chars (an empty line
 *  stays one empty row, so blank lines still occupy a visual row like a real
 *  terminal). */
function wrapToWidth(line: string, width: number): string[] {
  if (line.length === 0) return [""];
  const rows: string[] = [];
  for (let i = 0; i < line.length; i += width) rows.push(line.slice(i, i + width));
  return rows;
}

/**
 * Tail of `text` in wrapped VISUAL rows, not source lines: soft-wraps to
 * `columns - 1`-wide rows (matching the terminal), then keeps only the last
 * `maxRows`. This is what bounds the streaming region's on-screen height - a
 * single long line wraps to many rows, which a source-line count would miss.
 */
export function visualTail(text: string, columns: number, maxRows: number): VisualTail {
  const width = Math.max(1, columns - 1);
  const rows: string[] = [];
  for (const src of text.split("\n")) {
    for (const r of wrapToWidth(src, width)) rows.push(r);
  }
  const hiddenRows = Math.max(0, rows.length - maxRows);
  return { lines: rows.slice(-maxRows), hiddenRows };
}

export interface TailItems<T> {
  items: T[];
  /** How many items were dropped above the kept tail. */
  hiddenCount: number;
}

/** Last `cap` items plus how many were dropped. Used for the live activity
 *  list, where each item renders as exactly one visual row (truncate-end). */
export function tailItems<T>(items: T[], cap: number): TailItems<T> {
  return { items: items.slice(-cap), hiddenCount: Math.max(0, items.length - cap) };
}
