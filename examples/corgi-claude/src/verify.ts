// Fully offline: no `claude` CLI or OpenLedger build required.
import { createStreamParser, type ClaudeStreamEvent } from "./claude-stream.js";
import { parseMarkdown, renderPlain } from "./markdown.js";
import { makePlainReporter } from "./reporters.js";

function assistantLine(block: Record<string, unknown>): string {
  return JSON.stringify({ type: "assistant", message: { content: [block] } });
}

function toolUse(name: string, input: Record<string, unknown>): string {
  return assistantLine({ type: "tool_use", name, input });
}

/** Everything the demo reads out of `claude -p --output-format stream-json`. */
function checkStreamParser(problems: string[]): void {
  const longCommand = `oled transactions list --json ${"x".repeat(300)}`;
  const lines = [
    "",
    "not json at all",
    "{",
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    toolUse("Bash", { command: "oled status --json" }),
    toolUse("Bash", { command: "grep -n 'page 1'\n  document.txt" }),
    toolUse("Bash", { command: longCommand }),
    toolUse("Read", { file_path: "/ws/cwd/cache/sf_1/document.txt" }),
    toolUse("Write", { file_path: "/ws/cwd/batch.ndjson" }),
    toolUse("Skill", { command: "openledger" }),
    assistantLine({ type: "text", text: "no tool here" }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta" } }),
    JSON.stringify({ type: "result", result: "final answer", duration_ms: 4200 }),
  ];

  const events: ClaudeStreamEvent[] = [];
  const parser = createStreamParser((event) => events.push(event));
  for (const line of lines) parser.handleLine(line);

  const activity = events.flatMap((e) => (e.kind === "activity" ? [e.line] : []));
  const expected = [
    "> oled status --json",
    "> grep -n 'page 1' document.txt",
    `> ${longCommand.slice(0, 117)}...`,
    "> Read /ws/cwd/cache/sf_1/document.txt",
    "> Write /ws/cwd/batch.ndjson",
    "> Skill",
  ];
  if (JSON.stringify(activity) !== JSON.stringify(expected)) {
    problems.push(`activity lines ${JSON.stringify(activity)} != ${JSON.stringify(expected)}`);
  }

  const oledCalls = events.filter((e) => e.kind === "oled-call").length;
  if (oledCalls !== 2) {
    problems.push(`expected 2 oled-calls (only commands starting with oled), got ${oledCalls}`);
  }

  const skills = events.filter((e) => e.kind === "skill").length;
  if (skills !== 1) problems.push(`expected 1 skill event, got ${skills}`);

  const result = parser.getResult();
  if (result.answer !== "final answer" || result.durationMs !== 4200) {
    problems.push(`result event not read: ${JSON.stringify(result)}`);
  }
}

/** The answer renderer: a model's markdown must reach a pipe as flat text. */
function checkMarkdown(problems: string[]): void {
  const heading = parseMarkdown("## Summary of findings");
  if (!(heading.length === 1 && heading[0].type === "heading" && heading[0].text === "Summary of findings")) {
    problems.push(`markdown heading not parsed: ${JSON.stringify(heading)}`);
  }

  const bullets = parseMarkdown("- first item\n  - nested item");
  const bulletsOk =
    bullets.length === 2 &&
    bullets[0].type === "bullet" &&
    bullets[0].depth === 0 &&
    bullets[0].text === "first item" &&
    bullets[1].type === "bullet" &&
    bullets[1].depth === 1 &&
    bullets[1].text === "nested item";
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

  const inline = parseMarkdown("go **bold** then *slant* then `oled report` then [site](http://x)");
  const flat = inline.length === 1 && inline[0].type === "paragraph" ? inline[0].text : "";
  if (flat !== "go bold then slant then oled report then site (http://x)") {
    problems.push(`inline marks not flattened: ${JSON.stringify(flat)}`);
  }

  const code = parseMarkdown("run `python x.py **kwargs` now");
  const codeFlat = code.length === 1 && code[0].type === "paragraph" ? code[0].text : "";
  if (!codeFlat.includes("**kwargs")) {
    problems.push(`asterisks inside a code span were eaten as emphasis: ${JSON.stringify(codeFlat)}`);
  }
}

function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.flatMap((line) => line.split("\n"));
}

/** The only renderer: one pass over the full Reporter contract. */
function checkPlainReporter(problems: string[]): void {
  const pendingTimers = (): number =>
    process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

  const before = pendingTimers();
  const out = captureLog(() => {
    const reporter = makePlainReporter();
    reporter.step("build OpenLedger", true);
    reporter.step("ingest prepare smoke", false, "exit 4: the PDF is locked and no password was given");
    reporter.turnStart(1, 1, "ingest my new statements");
    reporter.turnActivity("> oled ingest list --json");
    reporter.turnAnswer("**Done** - see `oled report`\n\n| Merchant | Amount |\n| --- | --- |\n| Foo | 1 |");
    reporter.turnStderr(["node warning: something"]);
    reporter.turnDone(true, 5000, 3);
    reporter.step("final assertions", true, "files.ingested=1");
  });

  if (pendingTimers() !== before) {
    problems.push(`turnDone leaked the heartbeat timer: ${before} -> ${pendingTimers()} pending timeouts`);
  }

  const missing = [
    "[ ok ] build OpenLedger",
    "[fail] ingest prepare smoke  exit 4: the PDF is locked and no password was given",
    "turn 1/1: ingest my new statements",
    "> oled ingest list --json",
    "Done - see oled report",
    "Merchant  Amount",
    "stderr: node warning: something",
    "turn 1 done in 5s · 3 oled calls",
  ].filter((line) => !out.includes(line));
  if (missing.length > 0) {
    problems.push(`plain reporter lines missing: ${JSON.stringify(missing)} in ${JSON.stringify(out)}`);
  }

  if (out.some((line) => line.includes("**") || line.includes("|"))) {
    problems.push(`raw markdown reached the plain output: ${JSON.stringify(out)}`);
  }

  // A step after the turns is separated from the last divider by a blank line.
  const assertions = out.indexOf("[ ok ] final assertions  files.ingested=1");
  if (assertions < 1 || out[assertions - 1] !== "") {
    problems.push(`post-turn step is not preceded by a blank line: ${JSON.stringify(out.slice(-4))}`);
  }
}

const problems: string[] = [];
checkStreamParser(problems);
checkMarkdown(problems);
checkPlainReporter(problems);

console.log("stream parser:   activity lines, oled-call and skill signals, result answer/duration, junk ignored");
console.log("markdown:        heading / nested bullets / table / malformed table / inline marks / code span");
console.log("plain reporter:  step, turn, answer, stderr and summary lines; no leaked heartbeat timer");

if (problems.length > 0) {
  console.error(`\nFAIL:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("\nOK: parser and renderer contracts hold.\n");
