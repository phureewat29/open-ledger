import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Result } from "./core/result.js";
import { HELP, loadConfig, modelSlug, type Config } from "./config.js";
import {
  SCENARIO,
  STATEMENT_FIXTURES,
  buildSystemPrompt,
  ENVIRONMENT_ADAPTER,
} from "./scenario.js";
import { createOpenLedgerRunner } from "./oled/command.js";
import { probeLedger, type LedgerProbe } from "./oled/ledger.js";
import { installPackedCli, type InstalledCli } from "./sandbox/install.js";
import {
  createWorkspace,
  createWorkspaceGuard,
  installSkillPack,
  seedStatements,
  type SkillPack,
  type Workspace,
} from "./sandbox/workspace.js";
import {
  expectLedger,
  loadEveryStatement,
  type ExpectedLedger,
  type StatementFacts,
} from "./statement/truth.js";
import { createOpenAiCompatibleModel } from "./model/chat.js";
import { resolveContextBudget, type ContextBudget } from "./model/capabilities.js";
import { planHostTransport, transportNames, type TransportPlan } from "./agent/attach.js";
import { createTools, type Tool } from "./agent/tools.js";
import { runPhase } from "./agent/runner.js";
import { createRecorder } from "./report/recorder.js";
import { buildDiagnosis, type PhaseSnapshot } from "./report/diagnosis.js";
import {
  buildScorecard,
  MAX_UNCATEGORIZED_RATIO,
  MONEY_TOLERANCE,
  NET_WORTH_TOLERANCE,
} from "./report/scorecard.js";
import { buildTranscript } from "./report/transcript.js";
import { renderConsole, timestampSlug, traceLine, writeReport } from "./report/render.js";
import type { RunIdentity, RunReport, SetupStep, ToolSchema } from "./report/report.js";
import type { EventSink } from "./report/events.js";

const EXAMPLE_ROOT = fileURLToPath(new URL("..", import.meta.url));
// Only the sandbox reaches out of the example: it packs the product it tests.
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURES = STATEMENT_FIXTURES.map((name) => join(EXAMPLE_ROOT, "fixtures", name));
const REPORTS_DIR = join(EXAMPLE_ROOT, "reports");
const OLED_TIMEOUT_MS = 120_000;

function note(text: string): void {
  process.stderr.write(`${text}\n`);
}

/** `work` comes before `describe` so the value's type is inferred, not annotated. */
type Step = <T>(
  name: string,
  work: () => Promise<Result<T>>,
  describe: (value: T) => string,
) => Promise<Result<T>>;

function createStepRecorder(steps: SetupStep[]): Step {
  return async function step<T>(
    name: string,
    work: () => Promise<Result<T>>,
    describe: (value: T) => string,
  ): Promise<Result<T>> {
    note(`… ${name}`);
    const result = await work();
    const detail = result.ok ? describe(result.value) : result.error;
    steps.push({ name, ok: result.ok, detail });
    note(`  ${result.ok ? "ok" : "failed"} ${name}: ${detail}`);
    return result;
  };
}

interface Sandbox {
  workspace: Workspace;
  cli: InstalledCli;
  skill: SkillPack;
  runner: ReturnType<typeof createOpenLedgerRunner>;
  statements: StatementFacts[];
  ledger: LedgerProbe;
}

async function prepare(
  step: Step,
  register: (workspace: Workspace) => void,
): Promise<Result<Sandbox>> {
  const created = await step(
    "create sandbox",
    async () => createWorkspace(),
    (workspace) => workspace.root,
  );
  if (!created.ok) return created;

  const workspace = created.value;
  register(workspace);

  const installed = await step(
    "pack and install OpenLedger",
    () =>
      installPackedCli({ repoRoot: REPO_ROOT, tarballDir: workspace.root, prefix: workspace.npm }),
    (cli) => `${cli.version}, ${cli.fileCount} files`,
  );
  if (!installed.ok) return installed;

  const cli = installed.value;
  const runner = createOpenLedgerRunner({
    bin: cli.binPath,
    env: workspace.env,
    cwd: workspace.cwd,
    timeoutMs: OLED_TIMEOUT_MS,
  });

  const seeded = await step(
    "seed the statements",
    async () => seedStatements(workspace, FIXTURES),
    (paths) => paths.join(", "),
  );
  if (!seeded.ok) return seeded;

  const facts = await step(
    "load the checked-in statement facts",
    async () => loadEveryStatement(FIXTURES),
    (every) => {
      const expected = expectLedger(every);
      return `${every.length} statement(s), ${expected.rows} rows, ${expected.charges.toFixed(2)} ${expected.currency} charged`;
    },
  );
  if (!facts.ok) return facts;

  const packed = await step(
    "install the skill",
    () => installSkillPack(workspace, runner),
    (skill) => `${skill.version}, ${skill.length} chars, sha256 ${skill.sha256.slice(0, 12)}`,
  );
  if (!packed.ok) return packed;

  const probed = await step(
    "check the harness is reachable",
    () => probeLedger(runner),
    (probe) => `${probe.postedRows} rows, net worth ${probe.netWorth.toFixed(2)}`,
  );
  if (!probed.ok) return probed;

  return {
    ok: true,
    value: {
      workspace,
      cli,
      skill: packed.value,
      runner,
      statements: facts.value,
      ledger: probed.value,
    },
  };
}

interface Walkthrough {
  config: Config;
  sandbox: Sandbox;
  tools: Tool[];
  transport: TransportPlan;
  budget: ContextBudget;
  emit: EventSink;
}

interface Walked {
  /** Set when the endpoint itself failed and the walkthrough stopped early. */
  endpointError: string | null;
  snapshots: PhaseSnapshot[];
}

/** Re-probes the ledger after every phase (no events emitted) so a report shows where progress stopped. */
async function walkthrough(run: Walkthrough): Promise<Walked> {
  const { config, sandbox, tools, transport, emit } = run;
  const deps = {
    model: createOpenAiCompatibleModel(config),
    tools,
    transport,
    emit,
    contextBudgetTokens: run.budget.tokens,
    // Shared across phases: separates concurrent tool calls from a later reaction to one.
    turns: { count: 0 },
  };
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(sandbox.skill.text) },
  ];

  const snapshots: PhaseSnapshot[] = [];
  for (const phase of SCENARIO) {
    const result = await runPhase(deps, messages, phase);
    if (!result.ok) return { endpointError: result.error, snapshots };

    const probed = await probeLedger(sandbox.runner);
    snapshots.push({
      phase: phase.id,
      ledger: probed.ok
        ? {
            postedRows: probed.value.postedRows,
            filesIngested: probed.value.filesIngested,
            questionsOpen: probed.value.questionsOpen,
          }
        : null,
    });
  }
  return { endpointError: null, snapshots };
}

function toolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function buildIdentity(args: {
  config: Config;
  startedAt: Date;
  cli: InstalledCli;
  skill: SkillPack;
  expected: ExpectedLedger;
  tools: ToolSchema[];
  transport: TransportPlan;
  budget: ContextBudget;
}): RunIdentity {
  const { config, cli, skill, expected, tools, transport, budget } = args;
  return {
    startedAt: args.startedAt.toISOString(),
    model: config.model,
    baseUrl: config.baseUrl,
    stream: config.stream,
    host: {
      modalities: transport.capabilities.modalities,
      modalitiesSource: transport.capabilities.source,
      contextLength: transport.capabilities.contextLength,
      detail: transport.capabilities.detail,
      transports: transportNames(transport),
    },
    context: { budgetTokens: budget.tokens, source: budget.source, detail: budget.detail },
    oled: { version: cli.version, tarball: cli.tarball, fileCount: cli.fileCount },
    skill: {
      path: skill.path,
      version: skill.version,
      sha256: skill.sha256,
      length: skill.length,
    },
    environmentAdapter: ENVIRONMENT_ADAPTER,
    tools,
    toolsSha256: createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
    expected,
    thresholds: {
      moneyTolerance: MONEY_TOLERANCE,
      netWorthTolerance: NET_WORTH_TOLERANCE,
      maxUncategorizedRatio: MAX_UNCATEGORIZED_RATIO,
    },
  };
}

async function run(config: Config): Promise<Result<boolean>> {
  const guard = createWorkspaceGuard(config.keepWorkspace);
  const steps: SetupStep[] = [];
  const step = createStepRecorder(steps);
  const startedAt = new Date();
  const recorder = createRecorder();

  // Before any sandbox work: a model that can't take a statement shouldn't earn a report of zero rows.
  const planned = await step(
    "read what the model accepts",
    () =>
      planHostTransport({
        baseUrl: config.baseUrl,
        model: config.model,
        override: config.inputModalities,
      }),
    (plan) =>
      `${plan.capabilities.modalities.join("+")} (${plan.capabilities.source}), carried as ${transportNames(plan).join(" or ")}`,
  );
  if (!planned.ok) return planned;

  const transport = planned.value;
  const budget = resolveContextBudget(transport.capabilities, config.contextBudgetTokens);
  note(`  context budget ${budget.tokens} tokens: ${budget.detail}`);

  const prepared = await prepare(step, guard.register);
  if (!prepared.ok) return prepared;

  const sandbox = prepared.value;
  const emit: EventSink = (event) => {
    recorder.observe(event);
    const line = traceLine(event);
    if (line) note(line);
  };

  const tools = createTools(sandbox.runner);
  const walked = await walkthrough({ config, sandbox, tools, transport, budget, emit });
  const { endpointError } = walked;
  if (endpointError) note(`endpoint error: ${endpointError}`);

  const probed = await probeLedger(sandbox.runner);
  if (!probed.ok) return probed;

  const ledger = probed.value;
  const metrics = recorder.snapshot();
  const expected = expectLedger(sandbox.statements);
  const report: RunReport = {
    identity: buildIdentity({
      config,
      startedAt,
      cli: sandbox.cli,
      skill: sandbox.skill,
      expected,
      tools: toolSchemas(tools),
      transport,
      budget,
    }),
    endpointError,
    setup: steps,
    statements: sandbox.statements,
    expected,
    ledger,
    scorecard: buildScorecard({ metrics, ledger, expected }),
    diagnosis: buildDiagnosis({
      events: metrics.events,
      phases: metrics.phases,
      snapshots: walked.snapshots,
    }),
    transcript: buildTranscript(metrics.events, SCENARIO),
    events: metrics.events,
  };

  const name = `${timestampSlug(startedAt)}-${modelSlug(config)}`;
  const written = writeReport(REPORTS_DIR, name, report);
  if (!written.ok) return written;

  process.stdout.write(renderConsole(report, written.value.markdownPath));
  guard.release();
  return { ok: true, value: report.scorecard.passed && !endpointError };
}

async function main(): Promise<number> {
  const config = loadConfig(process.argv.slice(2), process.env);
  if (!config.ok) {
    if (config.reason === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    process.stderr.write(`${config.message}\n\n${HELP}`);
    return 2;
  }

  const result = await run(config.value);
  if (!result.ok) {
    process.stderr.write(`corgi-eval failed: ${result.error}\n`);
    return 1;
  }
  return result.value ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause) => {
    process.stderr.write(
      `corgi-eval crashed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`,
    );
    process.exitCode = 1;
  });
