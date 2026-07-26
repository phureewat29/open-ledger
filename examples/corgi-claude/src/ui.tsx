/**
 * The ink (TTY) renderer: live dashboard components, and the App that runs
 * the render clock, buffers streaming deltas outside React state, and drives
 * the demo. See ui-state.ts for the render-clock and live-region contracts.
 *
 * Anti-flicker: everything finished is pinned once into ink's <Static>
 * (state.scrollback), so ink never repaints it. Only the running step(s) and
 * the active turn stay live, capped (computeLiveCaps) so the dynamic region
 * stays below `stdout.rows` - the height at which ink wipes and repaints
 * the whole screen.
 */
import { useEffect, useReducer, useRef } from "react";
import { Box, render, Static, Text, useStdout } from "ink";
import {
  computeLiveCaps,
  elapsedSeconds,
  initialUiState,
  type LiveCaps,
  type ScrollbackItem,
  type StepRow,
  spinnerFrame,
  tailItems,
  TICK_MS,
  type TurnData,
  uiReducer,
  visualTail,
  WRITING_WINDOW_MS,
} from "./ui-state.js";
import { DIVIDER, makeInkReporter, turnSummaryText } from "./reporters.js";
import { type Block, padTable, parseMarkdown, type Segment } from "./markdown.js";
import { runDemo, type DemoOptions } from "./orchestrate.js";
import type { WorkspacePaths } from "./workspace.js";

function StepRowView({ step, now }: { step: StepRow; now?: number }) {
  if (step.status === "running") {
    const clock = now ?? Date.now();
    return (
      <Text>
        <Text color="cyan">{spinnerFrame(clock)}</Text> {step.label}{" "}
        <Text color="yellow">elapsed {elapsedSeconds(clock, step.startedAt)}s</Text>
      </Text>
    );
  }
  const ok = step.status === "ok";
  return (
    <Text>
      <Text color={ok ? "green" : "red"}>{ok ? "✅" : "❌"}</Text> {step.label}
      {step.detail ? `  ${step.detail}` : ""}
    </Text>
  );
}

/** Inline emphasis segments as a Fragment of styled <Text>. Callers MUST wrap it
 *  in a <Text> so the pieces stay on one line (a bare Fragment inside a column
 *  Box would stack each segment on its own row). */
function InlineText({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((s, i) => (
        <Text key={i} bold={s.bold} italic={s.italic} color={s.code ? "magenta" : undefined}>
          {s.text}
        </Text>
      ))}
    </>
  );
}

/** One parsed markdown block rendered terminal-native (no literal `##`/`**`/`|`).
 *  Only reached for pinned answers, so its height is unbounded on purpose. */
function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "heading":
      return (
        <Box marginTop={1}>
          <Text bold color="cyan">
            <InlineText segments={block.segments} />
          </Text>
        </Box>
      );
    case "bullet":
      return (
        <Text>
          {"  ".repeat(block.depth)}• <InlineText segments={block.segments} />
        </Text>
      );
    case "numbered":
      return (
        <Text>
          {block.n}. <InlineText segments={block.segments} />
        </Text>
      );
    case "paragraph":
      return (
        <Text>
          <InlineText segments={block.segments} />
        </Text>
      );
    case "code":
      return (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {block.lines.map((line, i) => (
            <Text key={i} dimColor>
              {line.length > 0 ? line : " "}
            </Text>
          ))}
        </Box>
      );
    case "table": {
      if (block.rows.length === 0) return null;
      // Dependency-free padded grid, not ink-table: that package is CommonJS
      // and can't require ink 5's ESM graph under tsx.
      const [header, ...body] = padTable(block.rows);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">
            {header.join("  ").trimEnd()}
          </Text>
          <Text dimColor>{header.map((cell) => "-".repeat(cell.length)).join("  ").trimEnd()}</Text>
          {body.map((row, i) => (
            <Text key={i}>{row.join("  ").trimEnd()}</Text>
          ))}
        </Box>
      );
    }
  }
}

/** A pinned answer, parsed once and rendered as styled blocks. */
function AnswerView({ text }: { text: string }) {
  return (
    <Box flexDirection="column">
      {parseMarkdown(text).map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </Box>
  );
}

/** Bounded raw-text region for the live turn: shows only the last `cap`
 *  wrapped visual rows (true on-screen rows, not source lines) under a "+N
 *  earlier lines" marker; its own rows count toward LIVE_TURN_CHROME_ROWS. */
function BoundedText({
  text,
  columns,
  cap,
  italic,
}: {
  text: string;
  columns: number;
  cap: number;
  italic?: boolean;
}) {
  const { lines, hiddenRows } = visualTail(text, columns, cap);
  return (
    <Box flexDirection="column" marginTop={1}>
      {hiddenRows > 0 && <Text dimColor>… (+{hiddenRows} earlier lines)</Text>}
      {lines.map((line, i) => (
        <Text key={i} dimColor italic={italic}>
          {line.length > 0 ? line : " "}
        </Text>
      ))}
    </Box>
  );
}

/**
 * One turn's panel, in two modes:
 *  - live (now/caps supplied): the running turn. Activity tails to
 *    `caps.activityCap` rows, streaming is bounded by `caps.streamingCap`,
 *    and the spinner rides the clock. The answer doesn't render here - React
 *    18 batches TURN_ANSWER with TURN_DONE, so it lands already pinned; the
 *    BoundedText branch only guards a stray un-batched frame.
 *  - pinned (no now): a finished turn frozen in <Static> - full activity,
 *    answer rendered via AnswerView, no ticking.
 */
function TurnBlock({
  turn,
  now,
  caps,
  columns,
}: {
  turn: TurnData;
  now?: number;
  caps?: LiveCaps;
  columns: number;
}) {
  const running = turn.status === "running";
  const live = now != null && caps != null;
  const writing = now != null && turn.lastDeltaAt != null && now - turn.lastDeltaAt <= WRITING_WINDOW_MS;
  const hasAnswer = turn.answer.length > 0;
  const activity = live ? tailItems(turn.activity, caps.activityCap) : { items: turn.activity, hiddenCount: 0 };

  return (
    <Box flexDirection="column" marginY={1}>
      <Text dimColor>{DIVIDER}</Text>
      <Text bold color="cyan" wrap={live ? "truncate-end" : undefined}>
        🐶 turn {turn.turn}/{turn.total}: {turn.prompt}
      </Text>
      {activity.hiddenCount > 0 && <Text dimColor>… (+{activity.hiddenCount} earlier tool calls)</Text>}
      {activity.items.map((line, i) => (
        <Text key={i} dimColor wrap={live ? "truncate-end" : undefined}>
          {line}
        </Text>
      ))}
      {live ? (
        hasAnswer ? (
          // Pathological (batching normally skips this): keep it bounded.
          <BoundedText text={turn.answer} columns={columns} cap={caps.streamingCap} />
        ) : (
          <>
            {running && turn.streamingText.length > 0 && (
              <BoundedText text={turn.streamingText} columns={columns} cap={caps.streamingCap} italic />
            )}
            {running && now != null && (
              <Box marginTop={1}>
                <Text color="cyan">{spinnerFrame(now)}</Text>
                <Text> {writing ? "writing" : "thinking"}… </Text>
                <Text color="yellow">{elapsedSeconds(now, turn.startedAt)}s</Text>
              </Box>
            )}
          </>
        )
      ) : (
        hasAnswer && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>answer:</Text>
            <Box flexDirection="column" paddingLeft={2}>
              <AnswerView text={turn.answer} />
            </Box>
          </Box>
        )
      )}
      {turn.stderrTail.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {turn.stderrTail.map((line, i) => (
            <Text key={i} dimColor>
              stderr: {line}
            </Text>
          ))}
        </Box>
      )}
      {!running && (
        <Text bold color={turn.status === "ok" ? "green" : "red"}>
          {turn.status === "ok" ? "✅" : "❌"}{" "}
          {turnSummaryText(turn.turn, turn.status === "ok", turn.durationMs, turn.plasalidCalls)}
        </Text>
      )}
      <Text dimColor>{DIVIDER}</Text>
    </Box>
  );
}

/** One pinned scrollback item (rendered once by <Static>, never repainted). */
function ScrollbackView({ item, columns }: { item: ScrollbackItem; columns: number }) {
  switch (item.kind) {
    case "header":
      return (
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {item.text}
          </Text>
        </Box>
      );
    case "step":
      return <StepRowView step={item.step} />;
    case "turn":
      return <TurnBlock turn={item.turn} columns={columns} />;
    case "info":
      return <Text dimColor>{item.text}</Text>;
  }
}

function App({
  opts,
  onWorkspaceReady,
  keepWorkspace,
  onExit,
}: {
  opts: DemoOptions;
  onWorkspaceReady: (paths: WorkspacePaths) => void;
  keepWorkspace: boolean;
  onExit: (code: number) => void;
}) {
  const [state, dispatch] = useReducer(uiReducer, initialUiState);
  const startedRef = useRef(false);
  /** Streaming text buffered outside React state since the last TICK (see
   *  ui-state.ts). Appending never dispatches, so no re-render fires until
   *  the next TICK merges it in. */
  const pendingDeltaRef = useRef<{ turn: number; text: string } | null>(null);

  // Read every render so a TICK or resize recomputes the live-region caps.
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const columns = stdout?.columns ?? 80;
  const caps = computeLiveCaps(rows);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const reporter = makeInkReporter(dispatch, (turn, text) => {
      const cur = pendingDeltaRef.current;
      pendingDeltaRef.current = cur && cur.turn === turn ? { turn, text: cur.text + text } : { turn, text };
    });
    (async () => {
      const outcome = await runDemo(opts, reporter, onWorkspaceReady);
      if (outcome.paths && keepWorkspace) {
        reporter.info(`workspace kept at ${outcome.paths.root}`);
      }
      dispatch({ type: "FINAL", pass: outcome.pass });
      // Give ink one tick to flush the final render (including Static content)
      // before the process exits.
      setTimeout(() => onExit(outcome.pass ? 0 : 1), 50);
    })();
  }, [opts, onWorkspaceReady, keepWorkspace, onExit]);

  // Single render clock: only ticks while something is running; uiReducer's
  // TICK case bails out (no state change) when nothing visible changed.
  const isRunning = state.activeTurn !== null || state.runningSteps.length > 0;
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => {
      const pending = pendingDeltaRef.current;
      pendingDeltaRef.current = null;
      dispatch({
        type: "TICK",
        now: Date.now(),
        pendingDelta: pending?.text,
        pendingDeltaTurn: pending?.turn,
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [isRunning]);

  return (
    <Box flexDirection="column">
      <Static items={state.scrollback}>
        {(item) => <ScrollbackView key={item.key} item={item} columns={columns} />}
      </Static>
      {state.runningSteps.length > 0 && (
        <Box flexDirection="column">
          {state.runningSteps.map((s) => (
            <StepRowView key={s.id} step={s} now={state.now} />
          ))}
        </Box>
      )}
      {state.activeTurn && <TurnBlock turn={state.activeTurn} now={state.now} caps={caps} columns={columns} />}
      {state.done && (
        <Box marginTop={1}>
          <Text bold color={state.pass ? "green" : "red"}>
            {state.pass ? "PASS" : "FAIL"}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** Run the demo with the ink (TTY) renderer, returning the process exit code. */
export function runTty(
  opts: DemoOptions,
  onWorkspaceReady: (paths: WorkspacePaths) => void,
  keepWorkspace: boolean,
): Promise<number> {
  return new Promise((resolveExit) => {
    const instance = render(
      <App
        opts={opts}
        onWorkspaceReady={onWorkspaceReady}
        keepWorkspace={keepWorkspace}
        onExit={(code) => {
          instance.unmount();
          resolveExit(code);
        }}
      />,
    );
  });
}
