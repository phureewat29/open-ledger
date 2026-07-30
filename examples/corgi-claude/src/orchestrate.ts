// No renderer knowledge: progress goes out only through the `Reporter` contract.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEnv,
  buildOpenLedger,
  checkClaudeCli,
  createWorkspace,
  DETAIL_MAX,
  exitStatus,
  failureDetail,
  installSkill,
  numberField,
  parseNdjson,
  placeStatement,
  runOpenLedger,
  stringField,
  truncate,
  writeBinShim,
  type StepResult,
  type WorkspacePaths,
} from "./workspace.js";
import { runClaudeTurn } from "./claude-stream.js";
import type { Reporter } from "./reporters.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const STATEMENT_SOURCE = resolve(SCRIPT_DIR, "..", "fixtures", "card-statement-2026-05.pdf");
const STATEMENT_PASSWORD = "password";
const DEMO_TOOLS = "Bash(oled:*),Read,Write,Glob,Grep,TodoWrite,Skill";

const TURN_PROMPTS = [
  `ingest my new statements — the statement is password-protected; the password is: ${STATEMENT_PASSWORD} — then give me a quick summary of what you found`,
  "resolve any open questions using your own judgment, and capture the card's statement metadata (masked number, points, due day) onto the account",
  "how much did I spend this billed period, what were my top merchants, and what should I watch next month?",
];

export interface DemoOptions {
  skipClaude: boolean;
  turnTimeoutSec: number;
}

interface DemoOutcome {
  pass: boolean;
  paths: WorkspacePaths | null;
}

// `doctor`'s own `ok` covers the hard checks only, so a failure report
// names every check that is not ok.
function failedChecks(payload: Record<string, unknown> | undefined): string[] {
  const checks = payload?.checks;
  if (!Array.isArray(checks)) return [];
  return checks
    .filter((c) => (c as { ok?: unknown })?.ok !== true)
    .map((c) => {
      const detail = stringField(c, "detail");
      return `${stringField(c, "name") || "(unnamed)"}${detail ? `: ${detail}` : ""}`;
    });
}

/** The real readiness gate: `status` always exits 0, while `doctor` reports
 *  whether the db opens, the schema is present and the PDF reader loads. */
async function doctorReady(env: NodeJS.ProcessEnv, cwd: string): Promise<StepResult> {
  const res = await runOpenLedger(["doctor", "--json"], env, cwd);
  const [payload] = parseNdjson(res.stdout);
  if (res.ok && payload?.ok === true) return { ok: true, detail: "environment ready" };

  const failing = failedChecks(payload);
  if (failing.length === 0) return { ok: false, detail: failureDetail(res) };
  return { ok: false, detail: truncate(`not ready - ${failing.join("; ")}`, DETAIL_MAX) };
}

async function discoversStatement(env: NodeJS.ProcessEnv, cwd: string): Promise<StepResult> {
  const res = await runOpenLedger(["ingest", "list", "--json"], env, cwd);
  if (!res.ok) return exitStatus(res);

  const summary = parseNdjson(res.stdout).find((o) => o.type === "summary");
  if (!summary) return { ok: false, detail: "no summary line in ingest list --json output" };

  const newCount = numberField(summary, "new");
  if (newCount < 1) {
    return { ok: false, detail: `expected summary.new >= 1, got ${JSON.stringify(summary.new)}` };
  }
  return { ok: true, detail: `${newCount} new file(s) awaiting ingest` };
}

/**
 * The contract every turn depends on: a locked PDF with a text layer prepares
 * into one document with 1-based `--- page N ---` markers. The CLI keeps no
 * passwords, so every run passes --password.
 */
async function preparesTextDocument(
  env: NodeJS.ProcessEnv,
  cwd: string,
  statementPath: string,
): Promise<StepResult> {
  const res = await runOpenLedger(
    ["ingest", "prepare", statementPath, "--password", STATEMENT_PASSWORD, "--json"],
    env,
    cwd,
  );
  if (!res.ok) return exitStatus(res);

  const [payload] = parseNdjson(res.stdout);
  const kind = stringField(payload, "kind");
  const source = stringField(payload, "source");
  const pageCount = numberField(payload, "page_count");
  if (kind !== "text" || source !== "text-layer" || pageCount < 1) {
    return {
      ok: false,
      detail: `expected kind=text source=text-layer page_count>=1, got kind=${kind} source=${source} page_count=${pageCount}`,
    };
  }

  const document = stringField(payload, "document");
  if (!existsSync(document)) return { ok: false, detail: `document not on disk: ${document || "(absent)"}` };
  if (!readFileSync(document, "utf8").includes("--- page 1 ---")) {
    return { ok: false, detail: `no '--- page 1 ---' marker in ${document}` };
  }
  return { ok: true, detail: `${pageCount} pages of text at ${document}` };
}

async function assertLedgerFilled(env: NodeJS.ProcessEnv, cwd: string): Promise<StepResult> {
  const res = await runOpenLedger(["status", "--json"], env, cwd);
  if (!res.ok) return exitStatus(res);

  const [status] = parseNdjson(res.stdout);
  const ingested = numberField(status, "files", "ingested");
  const transactions = numberField(status, "counts", "transactions");
  if (!(ingested >= 1 && transactions > 0)) {
    return {
      ok: false,
      detail: `expected files.ingested >= 1 and counts.transactions > 0, got ingested=${ingested} transactions=${transactions}`,
    };
  }
  // Open questions are informational: the agent may legitimately defer some.
  const open = numberField(status, "questions", "open");
  return {
    ok: true,
    detail: `files.ingested=${ingested}, counts.transactions=${transactions}, questions.open=${open}`,
  };
}

/** `onWorkspaceReady` fires once the workspace exists, so callers can register cleanup before the long claude turns start. */
export async function runDemo(
  opts: DemoOptions,
  report: Reporter,
  onWorkspaceReady: (paths: WorkspacePaths) => void,
): Promise<DemoOutcome> {
  const step = async (label: string, fn: () => Promise<StepResult>): Promise<boolean> => {
    let result: StepResult;
    try {
      result = await fn();
    } catch (err) {
      result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    report.step(label, result.ok, result.detail);
    return result.ok;
  };

  const builtOk = await step("build OpenLedger", async () => exitStatus(await buildOpenLedger(REPO_ROOT)));
  if (!builtOk) return { pass: false, paths: null };

  // Creating the workspace and copying the fixture either work or throw; there
  // is no failure to report, so they are announced rather than run as steps.
  const ws = createWorkspace();
  onWorkspaceReady(ws);
  writeBinShim(ws, REPO_ROOT);
  const env = buildEnv(ws);
  report.step("create workspace", true, ws.root);

  const statementPath = placeStatement(ws, STATEMENT_SOURCE);
  report.step("place statement", true, statementPath);

  const skillOk = await step("install skill", () => installSkill(env, ws.cwd));
  if (!skillOk) return { pass: false, paths: ws };

  const readyOk = await step("doctor readiness gate", () => doctorReady(env, ws.cwd));
  if (!readyOk) return { pass: false, paths: ws };

  if (opts.skipClaude) {
    const listOk = await step("ingest list plumbing check", () => discoversStatement(env, ws.cwd));
    if (!listOk) return { pass: false, paths: ws };

    const prepareOk = await step("ingest prepare smoke", () =>
      preparesTextDocument(env, ws.cwd, statementPath),
    );
    return { pass: prepareOk, paths: ws };
  }

  // Fail fast with a friendly message instead of a raw ENOENT from the first turn's spawn().
  const preflightOk = await step("check claude CLI", async () => {
    const ok = checkClaudeCli(env);
    return {
      ok,
      detail: ok ? undefined : "claude CLI not found or not working - install Claude Code and authenticate",
    };
  });
  if (!preflightOk) return { pass: false, paths: ws };

  for (let i = 0; i < TURN_PROMPTS.length; i++) {
    const turn = i + 1;
    const prompt = TURN_PROMPTS[i];
    report.turnStart(turn, TURN_PROMPTS.length, prompt);

    let oledCalls = 0;
    let skillLoaded = false;
    const result = await runClaudeTurn(
      {
        prompt,
        continueSession: turn > 1,
        cwd: ws.cwd,
        env,
        allowedTools: DEMO_TOOLS,
        turnTimeoutSec: opts.turnTimeoutSec,
      },
      (event) => {
        if (event.kind === "activity") report.turnActivity(event.line);
        else if (event.kind === "skill") skillLoaded = true;
        else if (event.kind === "oled-call") oledCalls += 1;
      },
    );

    if (result.stderrTail && result.stderrTail.length > 0) {
      report.turnStderr(result.stderrTail);
    }
    report.turnAnswer(result.answer || "(no answer text)");
    if (turn === 1) {
      report.info(`skill loaded: ${skillLoaded ? "yes" : "no"}`);
    }
    report.turnDone(result.ok, result.durationMs, oledCalls);
    if (!result.ok) return { pass: false, paths: ws };
  }

  const assertionsOk = await step("final assertions", () => assertLedgerFilled(env, ws.cwd));
  return { pass: assertionsOk, paths: ws };
}
