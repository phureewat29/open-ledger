/**
 * Dev checks for the ink renderer's flicker-safety invariants (run via
 * `npm run verify`). Fully offline: needs neither the `claude` CLI nor the
 * plasalid build. Exits non-zero on any violation.
 *
 * Sections:
 *  1. Live-region line budget (computeLiveCaps): the capped live turn stays
 *     strictly below `stdout.rows`, so ink never hits its full-repaint path.
 *  2. visualTail: a long single line is bounded by true wrapped visual rows.
 *  3. spinnerFrame: the clock-driven spinner cycles all its frames.
 *  4. Scrollback: the reducer's pinned list is append-only, correctly ordered,
 *     and holds info back until after its turn.
 *  5. markdown parser: headings / bullets / tables / malformed tables / inline
 *     marks parse (and flatten to plain) as expected.
 *  6. Render clock: a fast synthetic delta stream drives only TICK-bounded
 *     visible updates (never per-delta), and the spinner re-renders each tick.
 */
import { createStreamParser } from "./claude-stream.js";
import {
  computeLiveCaps,
  initialUiState,
  LIVE_TURN_CHROME_ROWS,
  spinnerFrame,
  SPINNER_FRAME_COUNT,
  TICK_MS,
  uiReducer,
  visualTail,
  type UiAction,
  type UiState,
} from "./ui-state.js";
import { parseMarkdown, renderPlain, segmentsToText } from "./markdown.js";

function checkBudget(problems: string[]): void {
  for (let rows = 17; rows <= 80; rows++) {
    const { activityCap, streamingCap } = computeLiveCaps(rows);
    if (activityCap + streamingCap + LIVE_TURN_CHROME_ROWS > rows - 1) {
      problems.push(
        `live region can reach rows at rows=${rows}: ${activityCap}+${streamingCap}+${LIVE_TURN_CHROME_ROWS} > ${rows - 1}`,
      );
    }
  }
  for (let rows = 4; rows <= 16; rows++) {
    const { activityCap, streamingCap } = computeLiveCaps(rows);
    if (streamingCap < 2 || activityCap < 3) {
      problems.push(`caps floor violated at rows=${rows}: activity=${activityCap} streaming=${streamingCap}`);
    }
  }
}

function checkVisualTail(problems: string[]): void {
  const cap = 6;
  const cols = 80;
  const blob = "x".repeat(500);
  const { lines, hiddenRows } = visualTail(blob, cols, cap);
  const totalRows = Math.ceil(500 / (cols - 1)); // wraps at cols-1 = 79 -> 7 rows
  if (lines.length > cap) problems.push(`visualTail returned ${lines.length} rows > cap ${cap}`);
  if (lines.some((l) => l.length > cols - 1)) problems.push(`visualTail row exceeds ${cols - 1} chars`);
  if (hiddenRows + lines.length !== totalRows) {
    problems.push(`visualTail row accounting off: ${hiddenRows} hidden + ${lines.length} shown != ${totalRows}`);
  }
}

function checkSpinnerFrames(problems: string[]): void {
  const frames = new Set<string>();
  for (let i = 0; i < SPINNER_FRAME_COUNT * 3; i++) frames.add(spinnerFrame(i * TICK_MS));
  if (frames.size !== SPINNER_FRAME_COUNT) {
    problems.push(`spinnerFrame cycled ${frames.size} distinct frames, expected ${SPINNER_FRAME_COUNT}`);
  }
}

function checkScrollback(problems: string[]): void {
  // Steps -> turn (mid-turn INFO) -> TURN_DONE -> turn 2 -> post-turn INFO ->
  // FINAL. Mid-turn info must land after turn 1's panel; post-turn info appends directly.
  const seq: UiAction[] = [
    { type: "STEP_START", id: "s1", label: "build plasalid", at: 1000 },
    { type: "STEP_DONE", id: "s1", label: "build plasalid", ok: true },
    { type: "STEP_START", id: "s2", label: "create workspace", at: 1100 },
    { type: "STEP_DONE", id: "s2", label: "create workspace", ok: true, detail: "/tmp/ws" },
    { type: "TURN_START", turn: 1, total: 2, prompt: "ingest", at: 1200 },
    { type: "TURN_ACTIVITY", turn: 1, line: "> plasalid status --json" },
    { type: "INFO", line: "skill loaded: yes" },
    { type: "TURN_DONE", turn: 1, ok: true, durationMs: 5000, plasalidCalls: 3 },
    { type: "TURN_START", turn: 2, total: 2, prompt: "report", at: 1300 },
    { type: "TURN_DONE", turn: 2, ok: true, durationMs: 6000, plasalidCalls: 2 },
    { type: "INFO", line: "0 open question(s) after the demo" },
    { type: "FINAL", pass: true },
  ];

  let state: UiState = initialUiState;
  for (const action of seq) {
    const prev = state.scrollback;
    state = uiReducer(state, action);
    const next = state.scrollback;
    if (next.length < prev.length) {
      problems.push(`scrollback shrank on ${action.type}`);
    }
    // Append-only by reference: every prior item keeps its exact reference/index.
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== next[i]) {
        problems.push(`scrollback item ${i} changed reference on ${action.type} (not append-only)`);
        break;
      }
    }
  }

  const kinds = state.scrollback.map((it) => it.kind).join(",");
  const expected = "header,step,step,turn,info,turn,info";
  if (kinds !== expected) problems.push(`scrollback kind order [${kinds}] != [${expected}]`);

  const keys = state.scrollback.map((it) => it.key);
  if (new Set(keys).size !== keys.length) problems.push(`scrollback keys not unique: ${keys.join(",")}`);
}

function checkMarkdown(problems: string[]): void {
  const heading = parseMarkdown("## Summary of findings");
  if (
    !(
      heading.length === 1 &&
      heading[0].type === "heading" &&
      heading[0].level === 2 &&
      segmentsToText(heading[0].segments) === "Summary of findings"
    )
  ) {
    problems.push(`markdown heading not parsed: ${JSON.stringify(heading)}`);
  }

  const bullets = parseMarkdown("- first item\n- second item");
  const bulletsOk =
    bullets.length === 2 &&
    bullets[0].type === "bullet" &&
    segmentsToText(bullets[0].segments) === "first item" &&
    bullets[1].type === "bullet" &&
    segmentsToText(bullets[1].segments) === "second item";
  if (!bulletsOk) problems.push(`markdown bullets not parsed: ${JSON.stringify(bullets)}`);

  const table = parseMarkdown("| Merchant | Amount |\n| --- | --- |\n| Foo | 100 |\n| Bar | 200 |");
  const tableOk =
    table.length === 1 &&
    table[0].type === "table" &&
    JSON.stringify(table[0].rows) === JSON.stringify([["Merchant", "Amount"], ["Foo", "100"], ["Bar", "200"]]);
  if (!tableOk) problems.push(`markdown table not parsed / column order wrong: ${JSON.stringify(table)}`);
  if (renderPlain(table).includes("|")) problems.push("plain table output still contains raw pipes");

  // No separator row -> not a table; the pipe lines degrade to a paragraph.
  const malformed = parseMarkdown("| Merchant | Amount |\n| Foo | 100 |");
  if (malformed.some((b) => b.type === "table")) {
    problems.push(`malformed table should fall back to paragraph: ${JSON.stringify(malformed)}`);
  }

  const inline = parseMarkdown("go **bold** then *slant* then `mono` then [site](http://x)");
  const segs = inline.length === 1 && inline[0].type === "paragraph" ? inline[0].segments : [];
  const flat = segmentsToText(segs);
  const hasBold = segs.some((s) => s.bold && s.text === "bold");
  const hasItalic = segs.some((s) => s.italic && s.text === "slant");
  const hasCode = segs.some((s) => s.code && s.text === "mono");
  if (!(hasBold && hasItalic && hasCode)) problems.push(`inline marks not annotated: ${JSON.stringify(segs)}`);
  if (!flat.includes("site (http://x)")) problems.push(`link not rewritten to 'text (url)': ${flat}`);
  if (flat.includes("**") || flat.includes("[site]")) problems.push(`inline markers leaked into plain text: ${flat}`);
}

function runSyncChecks(): void {
  const problems: string[] = [];
  checkBudget(problems);
  checkVisualTail(problems);
  checkSpinnerFrames(problems);
  checkScrollback(problems);
  checkMarkdown(problems);

  console.log("live-region budget:     rows 17..80 stay <= rows-1, floors hold for rows 4..16");
  console.log(
    `visualTail:             500-char blob @ 80 cols bounded to <= ${computeLiveCaps(80).streamingCap} rows of <= 79 chars`,
  );
  console.log(`spinnerFrame:           cycles all ${SPINNER_FRAME_COUNT} frames off the render clock`);
  console.log("scrollback:             append-only, order [header,step,step,turn,info,turn,info], unique keys");
  console.log("markdown:               heading / bullets / table / malformed-table / inline marks");

  if (problems.length > 0) {
    console.error(`\nFAIL (invariants):\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("OK: renderer invariants hold.\n");
}

function runRenderClockCheck(): void {
  const DURATION_MS = 3000;
  const RAW_DELTAS = 200;
  const DELTA_TEXT = "lorem ";
  const TURN = 1;

  const deltaLine = JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: DELTA_TEXT } },
  });
  const toolLine = (command: string) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
    });

  // 200 delta lines with a tool_use sprinkled in every 50, plus one more = 4 total.
  const lines: string[] = [];
  for (let i = 0; i < RAW_DELTAS; i++) {
    lines.push(deltaLine);
    if (i > 0 && i % 50 === 0) lines.push(toolLine("plasalid status --json"));
  }
  lines.push(toolLine("plasalid transactions list --json"));
  const TOOL_USES = 4;

  let state: UiState = initialUiState;
  let renderCount = 0;
  let tickRenderCount = 0;
  let totalTicks = 0;
  let deltaEventCount = 0;
  let activityEventCount = 0;
  let plasalidCallCount = 0;

  /** Dispatch through the real reducer; report whether a new state reference (a
   *  visible change) was produced, mirroring what would trigger a React render. */
  function dispatch(action: UiAction): boolean {
    const prev = state;
    state = uiReducer(state, action);
    return state !== prev;
  }

  let pendingText = "";
  const parser = createStreamParser((event) => {
    if (event.kind === "delta") {
      deltaEventCount++;
      pendingText += event.text; // buffered outside state, exactly like App's pendingDeltaRef
    } else if (event.kind === "activity") {
      activityEventCount++;
      if (dispatch({ type: "TURN_ACTIVITY", turn: TURN, line: event.line })) renderCount++;
    } else if (event.kind === "plasalid-call") {
      plasalidCallCount++;
    }
  });

  function tick(): void {
    totalTicks++;
    const pending = pendingText;
    pendingText = "";
    if (dispatch({ type: "TICK", now: Date.now(), pendingDelta: pending || undefined, pendingDeltaTurn: TURN })) {
      tickRenderCount++;
      renderCount++;
    }
  }

  const startedAt = Date.now();
  dispatch({ type: "TURN_START", turn: TURN, total: 1, prompt: "verify render clock", at: startedAt });

  const tickTimer = setInterval(tick, TICK_MS);
  let fed = 0;
  const feedTimer = setInterval(
    () => {
      if (fed < lines.length) parser.handleLine(lines[fed++]);
    },
    Math.max(1, Math.floor(DURATION_MS / lines.length)),
  );

  setTimeout(() => {
    clearInterval(feedTimer);
    while (fed < lines.length) parser.handleLine(lines[fed++]); // drain any stragglers
    parser.flush(); // emit the last buffered delta event
    tick(); // final merge of trailing buffered text
    clearInterval(tickTimer);
    parser.dispose();

    const elapsedMs = Date.now() - startedAt;
    const bound = Math.ceil(elapsedMs / TICK_MS) + 2;
    const streamingLen = state.activeTurn?.streamingText.length ?? 0;
    const expectedLen = RAW_DELTAS * DELTA_TEXT.length;

    console.log(`raw text_delta chunks fed:       ${RAW_DELTAS}`);
    console.log(`coalesced delta events emitted:  ${deltaEventCount}`);
    console.log(
      `tool_use lines fed:              ${TOOL_USES} (activity: ${activityEventCount}, plasalid-calls: ${plasalidCallCount})`,
    );
    console.log(`TICKs dispatched:                ${totalTicks} over ${elapsedMs}ms`);
    console.log(`visible updates from TICK:       ${tickRenderCount} (cadence bound: <= ${bound})`);
    console.log(`total visible state updates:     ${renderCount}`);

    const problems: string[] = [];
    if (tickRenderCount > bound) {
      problems.push(`TICK-driven visible updates (${tickRenderCount}) exceed the TICK-cadence bound (${bound}).`);
    }
    if (tickRenderCount * 4 >= RAW_DELTAS) {
      problems.push(
        `visible updates (${tickRenderCount}) track the delta count (${RAW_DELTAS}), not the clock - deltas are re-rendering per-chunk.`,
      );
    }
    // Spinner rides the clock: almost every tick while running produces a
    // visible update, not just the ones with deltas.
    if (tickRenderCount < totalTicks - 2) {
      problems.push(
        `spinner not clock-driven: only ${tickRenderCount} of ${totalTicks} ticks re-rendered (expected >= ${totalTicks - 2}).`,
      );
    }
    if (streamingLen !== expectedLen) {
      problems.push(`streamingText length ${streamingLen} != expected ${expectedLen}; delta text was lost in buffering/merge.`);
    }

    if (problems.length > 0) {
      console.error(`\nFAIL:\n- ${problems.join("\n- ")}`);
      process.exit(1);
    }
    console.log(
      `\nOK: ${RAW_DELTAS} deltas produced ${tickRenderCount} clock-bounded visible updates (spinner rode all ${totalTicks} ticks; all text merged).`,
    );
    process.exit(0);
  }, DURATION_MS + 500);
}

runSyncChecks();
runRenderClockCheck();
