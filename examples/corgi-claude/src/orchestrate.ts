/**
 * The demo's orchestration core: the ordered build -> workspace -> skill ->
 * vault -> status sequence, the optional skip-claude plumbing check, and the
 * three-turn `claude -p` conversation with final assertions.
 *
 * This module has no UI knowledge. It reports progress purely through the
 * `Reporter` contract, so the ink (TTY) and plain (piped) renderers drive the
 * exact same sequence and only differ in how the callbacks are rendered.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEnv,
  buildOpenLedger,
  checkClaudeCli,
  createWorkspace,
  installSkill,
  parseNdjson,
  placeStatement,
  runOpenLedger,
  vaultAddPassword,
  writeBinShim,
  type WorkspacePaths,
} from "./workspace.js";
import { runClaudeTurn } from "./claude-stream.js";
import type { Reporter } from "./reporters.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const STATEMENT_SOURCE = resolve(SCRIPT_DIR, "..", "fixtures", "card-statement-2026-05.pdf");
const STATEMENT_PASSWORD = "password";
const VAULT_PATTERN = "^card-statement";
const DEMO_TOOLS = "Bash(oled:*),Read,Write,Skill";

const TURN_PROMPTS = [
  "ingest my new statements, then give me a quick summary of what you found",
  "resolve any open questions using your own judgment, and capture the card's statement metadata (masked number, points, due day) onto the account",
  "how much did I spend this billed period, what were my top merchants, and what should I watch next month?",
];

/** Stable ids for each reported step. Referenced by the plain reporter's
 *  blank-line special case (see makePlainReporter) so it isn't a magic string. */
export const STEP_IDS = {
  build: "build",
  workspace: "workspace",
  placeStatement: "place-statement",
  installSkill: "install-skill",
  vaultAdd: "vault-add",
  statusCheck: "status-check",
  plumbing: "plumbing",
  preflight: "preflight",
  assertions: "assertions",
} as const;

export interface DemoOptions {
  skipClaude: boolean;
  turnTimeoutSec: number;
}

export interface DemoOutcome {
  pass: boolean;
  paths: WorkspacePaths | null;
}

/** First non-blank line of a subprocess's stderr, truncated for display. */
function truncateDetail(s: string, max = 200): string {
  const line = (s.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  return line.length > max ? `${line.slice(0, Math.max(0, max - 3))}...` : line;
}

/** Safe nested-number lookup into a parsed JSON value (never throws). */
function numberField(obj: unknown, ...path: string[]): number {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return 0;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "number" ? cur : 0;
}

interface PreStep {
  id: string;
  label: string;
  run: () => Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Runs the full demo sequence, reporting progress through `report`, and
 * returns whether it passed. `onWorkspaceReady` fires once the workspace
 * exists, so callers can register cleanup before the long claude turns start.
 */
export async function runDemo(
  opts: DemoOptions,
  report: Reporter,
  onWorkspaceReady: (paths: WorkspacePaths) => void,
): Promise<DemoOutcome> {
  const step = async (
    id: string,
    label: string,
    fn: () => Promise<{ ok: boolean; detail?: string }>,
  ): Promise<boolean> => {
    report.stepStart(id, label);
    let result: { ok: boolean; detail?: string };
    try {
      result = await fn();
    } catch (err) {
      result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    report.stepDone(id, label, result.ok, result.detail);
    return result.ok;
  };

  // ws/env come from the workspace step; safe since later steps only run
  // after it succeeds.
  let ws: WorkspacePaths | null = null;
  let env: NodeJS.ProcessEnv = process.env;

  const preSteps: PreStep[] = [
    {
      id: STEP_IDS.build,
      label: "build open-ledger",
      run: async () => {
        const res = await buildOpenLedger(REPO_ROOT);
        return { ok: res.ok, detail: res.ok ? undefined : `exit ${res.code}: ${truncateDetail(res.stderr)}` };
      },
    },
    {
      id: STEP_IDS.workspace,
      label: "create workspace",
      run: async () => {
        // One can't-fail step: create the workspace, register it for
        // cleanup, then write the bin shim and build the isolation env.
        ws = createWorkspace();
        onWorkspaceReady(ws);
        writeBinShim(ws, REPO_ROOT);
        env = buildEnv(ws);
        return { ok: true, detail: ws.root };
      },
    },
    {
      id: STEP_IDS.placeStatement,
      label: "place statement",
      run: async () => ({ ok: true, detail: placeStatement(ws!, STATEMENT_SOURCE) }),
    },
    {
      id: STEP_IDS.installSkill,
      label: "install skill",
      run: async () => {
        const res = await installSkill(ws!, env);
        return { ok: res.ok, detail: res.ok ? ws!.skillDir : `exit ${res.code}: ${truncateDetail(res.stderr)}` };
      },
    },
    {
      id: STEP_IDS.vaultAdd,
      label: "vault add password",
      run: async () => {
        const res = await vaultAddPassword(VAULT_PATTERN, STATEMENT_PASSWORD, env, ws!.cwd);
        return { ok: res.ok, detail: res.ok ? undefined : `exit ${res.code}: ${truncateDetail(res.stderr)}` };
      },
    },
    {
      id: STEP_IDS.statusCheck,
      label: "status check",
      run: async () => {
        const res = await runOpenLedger(["status", "--json"], env, ws!.cwd);
        return { ok: res.ok, detail: res.ok ? undefined : `exit ${res.code}: ${truncateDetail(res.stderr)}` };
      },
    },
  ];

  for (const s of preSteps) {
    if (!(await step(s.id, s.label, s.run))) return { pass: false, paths: ws };
  }
  const wsReady: WorkspacePaths = ws!; // guaranteed set by the workspace step above

  if (opts.skipClaude) {
    const plumbingOk = await step(STEP_IDS.plumbing, "ingest list plumbing check", async () => {
      const res = await runOpenLedger(["ingest", "list", "--json"], env, wsReady.cwd);
      if (!res.ok) return { ok: false, detail: `exit ${res.code}: ${truncateDetail(res.stderr)}` };

      const objs = parseNdjson(res.stdout);
      const summary = objs.find((o) => o.type === "summary");
      if (!summary) return { ok: false, detail: "no summary line in ingest list --json output" };

      const newCount = summary.new;
      if (!(typeof newCount === "number" && newCount >= 1)) {
        return { ok: false, detail: `expected summary.new >= 1, got ${JSON.stringify(newCount)}` };
      }
      return { ok: true, detail: `${newCount} new file(s) awaiting ingest` };
    });
    return { pass: plumbingOk, paths: wsReady };
  }

  // Fail fast with a friendly message if `claude` isn't installed/authenticated,
  // instead of a raw ENOENT once the first turn's spawn() runs.
  const preflightOk = await step(STEP_IDS.preflight, "check claude CLI", async () => {
    const ok = checkClaudeCli(env);
    return {
      ok,
      detail: ok ? undefined : "claude CLI not found or not working - install Claude Code and authenticate",
    };
  });
  if (!preflightOk) return { pass: false, paths: wsReady };

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
        cwd: wsReady.cwd,
        env,
        allowedTools: DEMO_TOOLS,
        turnTimeoutSec: opts.turnTimeoutSec,
      },
      (event) => {
        if (event.kind === "activity") report.turnActivity(turn, event.line);
        else if (event.kind === "delta") report.turnDelta(turn, event.text);
        else if (event.kind === "skill") skillLoaded = true;
        else if (event.kind === "oled-call") oledCalls += 1;
      },
    );

    if (result.stderrTail && result.stderrTail.length > 0) {
      report.turnStderr(turn, result.stderrTail);
    }
    report.turnAnswer(turn, result.answer || "(no answer text)");
    if (turn === 1) {
      report.info(`skill loaded: ${skillLoaded ? "yes" : "no"}`);
    }
    report.turnDone(turn, result.ok, { durationMs: result.durationMs, oledCalls });
    if (!result.ok) return { pass: false, paths: wsReady };
  }

  const assertionsOk = await step(STEP_IDS.assertions, "final assertions", async () => {
    const res = await runOpenLedger(["status", "--json"], env, wsReady.cwd);
    if (!res.ok) return { ok: false, detail: `exit ${res.code}: ${truncateDetail(res.stderr)}` };

    const [status] = parseNdjson(res.stdout);
    const ingested = numberField(status, "files", "ingested");
    const transactions = numberField(status, "counts", "transactions");
    if (!(ingested >= 1 && transactions > 0)) {
      return {
        ok: false,
        detail: `expected files.ingested >= 1 and counts.transactions > 0, got ingested=${ingested} transactions=${transactions}`,
      };
    }

    const openQuestions = numberField(status, "questions", "open");
    report.info(`${openQuestions} open question(s) after the demo (informational)`);
    return { ok: true, detail: `files.ingested=${ingested}, counts.transactions=${transactions}` };
  });

  return { pass: assertionsOk, paths: wsReady };
}
