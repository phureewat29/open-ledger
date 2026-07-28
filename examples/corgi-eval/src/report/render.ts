import chalk from "chalk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryExecute, type Result } from "../core/result.js";
import { groupedRows, type LedgerProbe } from "../oled/ledger.js";
import type { StatementFacts, StatementGroup } from "../statement/truth.js";
import type { Claim, ClaimStatus, CheckStatus, Excluded, Scorecard } from "./scorecard.js";
import type { MissingKind, PhaseProgress, RunDiagnosis, Wall } from "./diagnosis.js";
import type { FrictionItem, SubcommandRow } from "./friction.js";
import type { RunIdentity, RunReport } from "./report.js";
import type { OperationalType, PhaseExit, RunEvent } from "./events.js";

/**
 * Three views of one run. The console stays short enough to read at a glance;
 * the markdown carries the detail a harness change would be argued from; the
 * JSON carries everything, including the raw event log.
 *
 * The numbered sections come from one registry, so a section can never appear
 * in one view and go missing from the other.
 */

const STATUS_TEXT: Record<CheckStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  not_applicable: "N/A",
};

const STATUS_PAINT: Record<CheckStatus, (text: string) => string> = {
  pass: chalk.green,
  fail: chalk.red,
  not_applicable: chalk.dim,
};

const CLAIM_TEXT: Record<ClaimStatus, string> = {
  match: "match",
  mismatch: "mismatch",
  not_stated: "not stated",
};

/** Singular and plural, so the footnote reads as prose in both views. */
const OPERATIONAL_NAME: Record<OperationalType, { one: string; many: string }> = {
  endpoint_retry: { one: "endpoint retry", many: "endpoint retries" },
  stall_prod: { one: "stall prod", many: "stall prods" },
  artifacts_attached: { one: "host attachment", many: "host attachments" },
  artifacts_capped: { one: "attachment cut by a cap", many: "attachments cut by a cap" },
  artifacts_unreadable: {
    one: "output the host could not read",
    many: "outputs the host could not read",
  },
  artifacts_no_route: {
    one: "file with no route to this model",
    many: "files with no route to this model",
  },
};

const EXIT_TEXT: Record<PhaseExit, string> = {
  answered: "answered",
  call_cap: "ran out of calls",
  stalled: "went quiet",
};

const MISSING_TEXT: Record<MissingKind, string> = {
  tool: "tool",
  command: "command",
  flag: "flag",
};

const WALL_TEXT: Record<Wall["kind"], string> = {
  unknown_tool: "a tool that does not exist",
  missing_capability: "a capability the CLI does not have",
  self_reported: "the model said it was stuck",
};

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function keyValues(rows: [string, string][]): string[] {
  const width = Math.max(0, ...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${pad(label, width)}  ${value}`);
}

function percent(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

function ratio(part: number, whole: number, value: number | null): string {
  return `${part} of ${whole} (${percent(value)})`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function code(text: string): string {
  return text ? `\`${cell(text)}\`` : "-";
}

function markdownTable(header: string[], rows: string[][]): string[] {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

/** A table, or the sentence that stands in for an empty one. */
function tableOr(empty: string, header: string[], rows: string[][]): string {
  return rows.length === 0 ? empty : markdownTable(header, rows).join("\n");
}

function paint(status: CheckStatus): string {
  return STATUS_PAINT[status](STATUS_TEXT[status]);
}

function paintClaim(claim: Claim): string {
  const text = CLAIM_TEXT[claim.status];
  if (claim.status === "match") return chalk.green(text);
  return claim.passed ? chalk.dim(text) : chalk.red(text);
}

function wallLine(wall: Wall): string {
  return `${WALL_TEXT[wall.kind]}, in ${wall.phase} at ${wall.index}: ${wall.detail}`;
}

function progressCells(entry: PhaseProgress): string[] {
  const { ledger } = entry;
  return [
    entry.title,
    entry.exit === null ? "did not finish" : EXIT_TEXT[entry.exit],
    ledger === null ? "-" : String(ledger.postedRows),
    ledger === null ? "-" : String(ledger.filesIngested),
    ledger === null ? "-" : String(ledger.questionsOpen),
  ];
}

function missingSummary(diagnosis: RunDiagnosis): string {
  if (diagnosis.missing.length === 0) return "none";
  return diagnosis.missing
    .map((item) => `${item.asked} ×${item.count} (${MISSING_TEXT[item.kind]})`)
    .join(" · ");
}

function operationalCounts(excluded: Excluded): [OperationalType, number][] {
  return Object.keys(OPERATIONAL_NAME).map((key) => {
    const operation = key as OperationalType;
    return [operation, excluded[operation]];
  });
}

/** Zeros say nothing here; the markdown table carries every count. */
function excludedLine(excluded: Excluded): string {
  const counted = operationalCounts(excluded)
    .filter(([, count]) => count > 0)
    .map(([operation, count]) =>
      plural(count, OPERATIONAL_NAME[operation].one, OPERATIONAL_NAME[operation].many),
    );
  return counted.length === 0 ? "none" : counted.join(" · ");
}

function tokens(scorecard: Scorecard): string {
  const { profile } = scorecard;
  const suffix = profile.tokensEstimated ? " tokens (estimated)" : " tokens";
  return `${profile.tokensIn} in / ${profile.tokensOut} out${suffix}`;
}

/**
 * Every reading taken from the row listing is short once the cap bites, so it
 * is said once, next to those readings, in both views.
 */
function truncationWarning(ledger: LedgerProbe): string | null {
  const cut = ledger.truncated;
  if (!cut) return null;
  return `\`transactions list\` returned ${cut.returned} of ${cut.total} rows at its ${cut.limit}-row limit, so the group totals, the uncategorized count and the linked-row count are all read from that one page.`;
}

export function timestampSlug(date: Date): string {
  const pad2 = (value: number): string => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    `${pad2(date.getHours())}${pad2(date.getMinutes())}`,
  ].join("-");
}

/** A live line for stderr while the run is in flight; null for events not worth showing. */
export function traceLine(event: RunEvent): string | null {
  if (event.type === "phase_start") return chalk.bold(`\n▸ ${event.title}`);
  if (event.type === "llm_call") {
    return chalk.dim(
      `  turn ${event.turn} · ${event.toolCalls} tool calls · ${event.finishReason ?? "no reason"}`,
    );
  }
  if (event.type === "tool_call") {
    const mark = event.ok
      ? chalk.green("·")
      : chalk.red(`✗ ${event.rejected ?? `exit ${event.exitCode ?? "none"}`}`);
    return `  ${mark} ${event.command}`;
  }
  if (event.type === "context_trim") return chalk.yellow("  context trim");
  if (event.type === "operational") return chalk.yellow(`  ${event.operation}: ${event.detail}`);
  return null;
}

function outcomeConsole(report: RunReport): string[] {
  const { outcome } = report.scorecard;
  const labelWidth = Math.max(...outcome.map((entry) => entry.label.length));
  const statusWidth = Math.max(...Object.values(STATUS_TEXT).map((text) => text.length));
  return outcome.map((entry) => {
    const gap = " ".repeat(statusWidth - STATUS_TEXT[entry.status].length);
    const detail = chalk.dim(`${entry.actual} (want ${entry.expected})`);
    return `  ${paint(entry.status)}${gap}  ${pad(entry.label, labelWidth)}  ${detail}`;
  });
}

function outcomeMarkdown(report: RunReport): string[] {
  return [
    "What the pairing accomplished, read back through the CLI. Every row must pass.",
    "",
    "`every statement row posted` counts the rows that became one of the statement's charges, refunds or card payments, which is what its printed totals cover. Bookkeeping outside those groups — a carried-forward opening balance, say — is reported in the ledger readout and never scored.",
    "",
    ...markdownTable(
      ["check", "result", "want", "got"],
      report.scorecard.outcome.map((entry) => [
        entry.label,
        STATUS_TEXT[entry.status],
        cell(entry.expected),
        cell(entry.actual),
      ]),
    ),
  ];
}

function frictionHeading(report: RunReport): string {
  const { friction } = report.scorecard;
  const touched = new Set(friction.items.map((item) => item.subcommand)).size;
  return `${friction.total} across ${plural(touched, "subcommand")}`;
}

function frictionConsole(report: RunReport): string[] {
  const { types } = report.scorecard.friction;
  if (types.length === 0) return ["  none"];
  return types.map((entry) => `  ${String(entry.count).padStart(3)}  ${entry.type}`);
}

function subcommandTable(rows: SubcommandRow[]): string {
  return tableOr(
    "No commands ran.",
    [
      "subcommand",
      "calls",
      "help",
      "failures",
      "types",
      "hinted",
      "recovered",
      "same turn",
      "recovery",
    ],
    rows.map((row) => [
      `\`${cell(row.subcommand)}\``,
      String(row.calls),
      String(row.help),
      String(row.failures),
      row.types.length === 0 ? "-" : row.types.map((k) => `${k.type} ×${k.count}`).join(", "),
      String(row.hinted),
      String(row.recovered),
      String(row.sameTurn),
      percent(row.recoveryRate),
    ]),
  );
}

function nextAttemptCell(item: FrictionItem): string {
  const next = item.next;
  if (next) {
    return `${code(next.command)} → ${next.ok ? "ok" : `failed: ${cell(next.message)}`}${next.followedHint ? " (followed the hint)" : ""}`;
  }
  if (item.recovery === "same_turn") {
    return "_no later turn: every other attempt was dispatched in this same turn_";
  }
  return "_never tried this subcommand again_";
}

function frictionDetail(item: FrictionItem, index: number): string[] {
  return [
    `#### ${index + 1}. ${item.type} — ${item.phase}`,
    "",
    ...markdownTable(
      ["field", "value"],
      [
        ["tool", code(item.tool)],
        ["subcommand", code(item.subcommand)],
        ["turn", String(item.turn)],
        ["args", code(item.args)],
        ["command", code(item.command)],
        ["exit code", item.exitCode === null ? "none" : String(item.exitCode)],
        ["stderr", cell(item.message) || "-"],
        ["hint", item.hint === null ? "_none emitted_" : cell(item.hint)],
        ["recovery", item.recovery ?? "n/a (call succeeded)"],
        ["next attempt", nextAttemptCell(item)],
      ],
    ),
    "",
  ];
}

function frictionMarkdown(report: RunReport): string[] {
  const { friction } = report.scorecard;
  const lines = [
    "Every mismatch between what the model tried and what the contract accepts. Diagnostic only.",
    "",
    tableOr(
      "No friction.",
      ["type", "count"],
      friction.types.map((entry) => [entry.type, String(entry.count)]),
    ),
    "",
    "### Per subcommand",
    "",
    "A subcommand whose failures carry hints that never lead to recovery is a harness defect: the copy is there and it does not teach.",
    "",
    "`types` can exceed `failures`: `bad_date_format` is misuse the CLI may still accept. `same turn` failures are outside `recovery`, which needs a later turn to read. `help` counts the calls that asked for `--help`, which are calls, never failures.",
    "",
    subcommandTable(friction.subcommands),
  ];
  if (friction.items.length === 0) return lines;

  lines.push("", "### Each item in context", "");
  for (const [index, item] of friction.items.entries()) lines.push(...frictionDetail(item, index));
  return lines;
}

function recoveryHeading(report: RunReport): string {
  const { recovery } = report.scorecard.friction;
  return `${ratio(recovery.recovered, recovery.judged, recovery.rate)} · ${recovery.sameTurn} same turn`;
}

function recoveryConsole(report: RunReport): string[] {
  const { hints } = report.scorecard.friction;
  return [
    chalk.dim(
      `  hints ${hints.emitted} emitted, ${hints.judged} judged, ${hints.followed} followed, ${hints.recovered} recovered`,
    ),
  ];
}

function recoveryMarkdown(report: RunReport): string[] {
  const { recovery, hints } = report.scorecard.friction;
  return [
    "Does the contract's error design teach the model? For each failure, what the next attempt at the same subcommand did in a later turn.",
    "",
    `Recovered ${ratio(recovery.recovered, recovery.judged, recovery.rate)} of the failures a later turn could answer; ${recovery.sameTurn} of ${recovery.encountered} had no later turn.`,
    "",
    tableOr(
      "No failures to recover from.",
      ["type", "encountered", "recovered", "repeated", "changed", "abandoned", "same turn"],
      recovery.rows.map((row) => [
        row.type,
        String(row.encountered),
        String(row.recovered),
        String(row.repeated),
        String(row.changed),
        String(row.abandoned),
        String(row.sameTurn),
      ]),
    ),
    "",
    "`recovered` means a later call to the subcommand succeeded, not necessarily the next one. `repeated` sent the identical command again; `changed` tried a different one and still never succeeded; `abandoned` never returned to the subcommand.",
    "",
    "`same turn` means every other attempt at that subcommand was dispatched in the same turn as this one — parallel tool calls in one reply, sent before any of their results existed. They are outside the rate: an error the model had not read yet cannot have taught it anything.",
    "",
    "### Hint efficacy",
    "",
    "Whether oled's error copy actually teaches. A hint naming only a flag this host appends to every call is not counted: the model would score as following it whatever it did.",
    "",
    ...markdownTable(
      ["measure", "value"],
      [
        ["hints emitted on a failure", String(hints.emitted)],
        ["of those, naming a flag or offering stdin", String(hints.actionable)],
        ["of those, with a later turn to act on", String(hints.judged)],
        ["next attempt followed the hint", String(hints.followed)],
        ["next attempt ignored it", String(hints.ignored)],
        ["followed and then succeeded", String(hints.recovered)],
        ["hint-follow recovery rate", percent(hints.rate)],
      ],
    ),
  ];
}

function truthfulnessConsole(report: RunReport): string[] {
  const { truthfulness } = report.scorecard;
  const claimWidth = Math.max(...truthfulness.map((claim) => claim.label.length));
  const statusWidth = Math.max(...Object.values(CLAIM_TEXT).map((text) => text.length));
  return truthfulness.map((claim) => {
    const gap = " ".repeat(statusWidth - CLAIM_TEXT[claim.status].length);
    const detail = chalk.dim(`${claim.claimed} vs ${claim.actual}`);
    return `  ${paintClaim(claim)}${gap}  ${pad(claim.label, claimWidth)}  ${detail}`;
  });
}

function truthfulnessMarkdown(report: RunReport): string[] {
  return [
    "The model's prose against the ledger. A mismatch fails the run.",
    "",
    ...markdownTable(
      ["claim", "result", "claimed", "ledger", "verdict"],
      report.scorecard.truthfulness.map((claim) => [
        claim.label,
        CLAIM_TEXT[claim.status],
        cell(claim.claimed),
        cell(claim.actual),
        claim.passed ? "pass" : "fail",
      ]),
    ),
  ];
}

function profileConsole(report: RunReport): string[] {
  const { profile } = report.scorecard;
  const perRow = profile.toolCallsPerPostedRow;
  return [
    [
      plural(profile.modelCalls, "model call"),
      plural(profile.toolCalls, "tool call"),
      plural(profile.helpCalls, "help lookup"),
      `${perRow === null ? "-" : perRow.toFixed(2)} per posted row`,
    ].join(" · "),
    [
      plural(profile.repeatedCommands, "repeated command"),
      plural(profile.redundantCommits, "redundant commit"),
      plural(profile.contextTrims, "context trim"),
      tokens(report.scorecard),
    ].join(" · "),
  ].map((line) => `  ${line}`);
}

function profileMarkdown(report: RunReport): string[] {
  const { scorecard } = report;
  const { profile } = scorecard;
  return [
    "Volume, not time.",
    "",
    "`help lookups` counts the calls that asked for `--help`. The skill is short and sends the model to the CLI's own help for everything else, so whether it goes there is worth seeing. Reported, never scored.",
    "",
    ...markdownTable(
      ["metric", "value"],
      [
        ["model calls", String(profile.modelCalls)],
        ["tool calls", String(profile.toolCalls)],
        ["help lookups", String(profile.helpCalls)],
        [
          "tool calls per posted row",
          profile.toolCallsPerPostedRow === null
            ? "-"
            : profile.toolCallsPerPostedRow.toFixed(2),
        ],
        ["repeated identical commands", String(profile.repeatedCommands)],
        ["redundant commits", String(profile.redundantCommits)],
        ["context trims", String(profile.contextTrims)],
        ["tokens", tokens(scorecard)],
      ],
    ),
    "",
    ...markdownTable(
      ["phase", "model calls", "tool calls", "failed"],
      profile.phases.map((phase) => [
        phase.title,
        String(phase.llmCalls),
        String(phase.toolCalls),
        String(phase.failedToolCalls),
      ]),
    ),
    "",
    "### Excluded from the eval",
    "",
    "Kept for operations, never scored: these describe the endpoint, the loop that drives it, and what the host carried back on the model's behalf, not how the model fits the contract.",
    "",
    ...markdownTable(
      ["event", "count"],
      operationalCounts(scorecard.excluded).map(([operation, count]) => [
        OPERATIONAL_NAME[operation].many,
        String(count),
      ]),
    ),
  ];
}

function diagnosisConsole(report: RunReport): string[] {
  const { diagnosis } = report;
  const titleWidth = Math.max(1, ...diagnosis.progress.map((entry) => entry.title.length));
  const exitWidth = Math.max(...Object.values(EXIT_TEXT).map((text) => text.length));
  const lines = diagnosis.progress.map((entry) => {
    const [title, exit, rows, files, questions] = progressCells(entry);
    const detail = chalk.dim(`${rows} rows · ${files} files · ${questions} open questions`);
    return `  ${pad(title ?? "", titleWidth)}  ${pad(exit ?? "", exitWidth)}  ${detail}`;
  });
  lines.push(`  reached for what is not there  ${missingSummary(diagnosis)}`);
  const stuck =
    diagnosis.blockers.length === 0
      ? "none"
      : plural(diagnosis.blockers.length, "reply", "replies");
  lines.push(`  said it was stuck              ${stuck}`);
  return lines;
}

function diagnosisMarkdown(report: RunReport): string[] {
  const { diagnosis } = report;
  return [
    "Where progress stopped, and what the model asked for and never got. None of it moves the verdict: it exists so a harness that made the task impossible shows up on the first run instead of the third.",
    "",
    "### Progress by phase",
    "",
    ...markdownTable(
      ["phase", "ended", "rows posted", "files ingested", "questions open"],
      diagnosis.progress.map((entry) => progressCells(entry)),
    ),
    "",
    "### Capabilities the model reached for that do not exist",
    "",
    "A tool, command or flag the model asked for and the harness does not have. Two models reaching for the same missing thing is a harness gap, not a model mistake. A flag that exists but was given a bad value is friction over its value, and is counted in section 2 instead.",
    "",
    tableOr(
      "None.",
      ["kind", "asked for", "calls", "phases", "first command"],
      diagnosis.missing.map((item) => [
        MISSING_TEXT[item.kind],
        code(item.asked),
        String(item.count),
        item.phases.join(", "),
        code(item.command),
      ]),
    ),
    "",
    "### Self-reported blockers",
    "",
    "Where the model said it could not do something, in its own words.",
    "",
    tableOr(
      "None.",
      ["phase", "reply", "sentence"],
      diagnosis.blockers.map((blocker) => [
        blocker.phase,
        String(blocker.reply),
        cell(blocker.sentence),
      ]),
    ),
  ];
}

/**
 * The report's numbered sections, in order. Both views render this one list, so
 * a section cannot be added to the markdown and forgotten in the console.
 */
interface Section {
  title: string;
  /** Appended to the heading in both views: a count or a caveat. */
  heading?: (report: RunReport) => string;
  console: (report: RunReport) => string[];
  markdown: (report: RunReport) => string[];
}

const SECTIONS: Section[] = [
  { title: "Task outcome", console: outcomeConsole, markdown: outcomeMarkdown },
  {
    title: "Contract friction",
    heading: frictionHeading,
    console: frictionConsole,
    markdown: frictionMarkdown,
  },
  {
    title: "Recovery",
    heading: recoveryHeading,
    console: recoveryConsole,
    markdown: recoveryMarkdown,
  },
  { title: "Truthfulness", console: truthfulnessConsole, markdown: truthfulnessMarkdown },
  { title: "Interaction profile", console: profileConsole, markdown: profileMarkdown },
  {
    title: "Diagnosis",
    heading: () => "never scored",
    console: diagnosisConsole,
    markdown: diagnosisMarkdown,
  },
];

export function renderConsole(report: RunReport, reportPath: string): string {
  const { scorecard, identity } = report;
  const lines: string[] = [""];
  lines.push(chalk.bold(`corgi-eval — ${identity.model} @ ${identity.baseUrl}`));
  lines.push(
    chalk.dim(
      `oled ${identity.oled.version} · skill ${identity.skill.version} (${identity.skill.length} chars, sha256 ${identity.skill.sha256.slice(0, 12)})`,
    ),
  );
  lines.push(
    chalk.dim(
      `input ${identity.host.modalities.join("+")} · statement carried as ${identity.host.transports.join(", ")} · budget ${identity.context.budgetTokens} tokens (${identity.context.source})`,
    ),
  );
  if (report.endpointError) lines.push(chalk.red(`endpoint error: ${report.endpointError}`));
  const { firstWall } = report.diagnosis;
  if (firstWall) lines.push(chalk.yellow(`first wall  ${wallLine(firstWall)}`));

  lines.push("");
  lines.push(chalk.bold.yellow("Setup"));
  lines.push(
    ...keyValues(
      report.setup.map((step) => [
        step.name,
        `${step.ok ? chalk.green("ok") : chalk.red("failed")} ${step.detail}`,
      ]),
    ),
  );

  for (const [index, section] of SECTIONS.entries()) {
    const note = section.heading?.(report);
    lines.push("");
    lines.push(
      chalk.bold.yellow(`${index + 1} · ${section.title}`) + (note ? chalk.dim(`  ${note}`) : ""),
    );
    lines.push(...section.console(report));
  }

  const truncated = truncationWarning(report.ledger);
  lines.push("");
  if (truncated) lines.push(chalk.yellow(`Capped read  ${truncated.replace(/`/g, "")}`));
  lines.push(chalk.dim(`Excluded from the eval  ${excludedLine(scorecard.excluded)}`));

  const failures =
    scorecard.outcome.filter((entry) => entry.status === "fail").length +
    scorecard.truthfulness.filter((claim) => !claim.passed).length;
  lines.push("");
  lines.push(
    scorecard.passed
      ? chalk.bold.green("VERDICT PASS")
      : chalk.bold.red(`VERDICT FAIL (${failures} checks)`),
  );
  lines.push(chalk.dim(`report ${reportPath}`));
  lines.push("");
  return lines.join("\n");
}

function identityTable(identity: RunIdentity): string[] {
  return markdownTable(
    ["field", "value"],
    [
      ["started at", identity.startedAt],
      ["model", identity.model],
      ["base url", identity.baseUrl],
      ["stream", String(identity.stream)],
      [
        "model input types",
        `${identity.host.modalities.join(", ")} (${identity.host.modalitiesSource}: ${identity.host.detail})`,
      ],
      ["statement carried as", identity.host.transports.join(", ")],
      [
        "model window",
        identity.host.contextLength === null
          ? "not reported"
          : `${identity.host.contextLength} tokens`,
      ],
      [
        "context budget",
        `${identity.context.budgetTokens} tokens (${identity.context.source}: ${identity.context.detail})`,
      ],
      [
        "oled",
        `${identity.oled.version} (${identity.oled.fileCount} files, ${identity.oled.tarball.split("/").at(-1)})`,
      ],
      ["skill", `${identity.skill.version}, ${identity.skill.length} chars`],
      ["skill sha256", identity.skill.sha256],
      ["tools", identity.tools.map((tool) => tool.name).join(", ")],
      ["tools sha256", identity.toolsSha256],
      [
        "expected",
        `${identity.expected.rows} rows, charges ${identity.expected.charges}, refunds ${identity.expected.refunds}, payments ${identity.expected.payments}`,
      ],
      [
        "thresholds",
        `money ${identity.thresholds.moneyTolerance}, net worth ${identity.thresholds.netWorthTolerance}, uncategorized ${identity.thresholds.maxUncategorizedRatio}`,
      ],
    ],
  );
}

/** One row per group per statement, so a second statement adds rows, not columns. */
function statementRows(statements: StatementFacts[]): string[][] {
  const rows: string[][] = [];
  for (const facts of statements) {
    const groups: [string, StatementGroup][] = [
      ["charges", facts.groups.charges],
      ["refunds", facts.groups.refunds],
      ["card payments", facts.groups.payments],
    ];
    for (const [label, group] of groups) {
      rows.push([code(facts.statement), label, String(group.count), group.total.toFixed(2)]);
    }
  }
  return rows;
}

function ledgerSection(ledger: LedgerProbe): string[] {
  const grouped = groupedRows(ledger.money);
  const lines = [
    "",
    "## Ledger after the run",
    "",
    ...markdownTable(
      ["reading", "value"],
      [
        ["files ingested / pending", `${ledger.filesIngested} / ${ledger.filesPending}`],
        ["rows posted", String(ledger.postedRows)],
        ["rows linked to a statement file", String(ledger.linkedRows)],
        ["rows outside the statement's groups", String(ledger.postedRows - grouped)],
        ["uncategorized rows", String(ledger.uncategorizedRows)],
        ["questions open / deferred", `${ledger.questionsOpen} / ${ledger.questionsDeferred}`],
        ["net worth", ledger.netWorth.toFixed(2)],
        [
          "charges / refunds / payments",
          `${ledger.money.charges.total.toFixed(2)} / ${ledger.money.refunds.total.toFixed(2)} / ${ledger.money.payments.total.toFixed(2)}`,
        ],
      ],
    ),
    "",
    "`rows linked to a statement file` counts the listed rows carrying a `source_file_id`. A row outside the statement's groups — an opening balance through `equity`, if the model posted one — is bookkeeping the statement's printed totals do not cover. Both readings are neutral: reported so they are visible, never scored.",
  ];
  const truncated = truncationWarning(ledger);
  if (truncated) lines.push("", `> **Capped read:** ${truncated}`);
  return lines;
}

/** `skill` is the installed SKILL.md, read back at write time; null when it is gone. */
function renderMarkdown(report: RunReport, skill: string | null): string {
  const { scorecard, statements, expected, ledger, identity } = report;
  const lines = [
    `# corgi-eval — ${identity.model}`,
    "",
    `**Verdict: ${scorecard.passed ? "PASS" : "FAIL"}** · started ${identity.startedAt}`,
    "",
    "An eval of how well this model and the OpenLedger CLI contract work with each other. Sections 1 and 4 decide the verdict; 2, 3, 5, and 6 are diagnostics for changing the harness.",
    "",
  ];

  if (report.endpointError) {
    lines.push(`> The endpoint failed and the walkthrough stopped early: ${report.endpointError}`);
    lines.push("");
  }
  if (report.diagnosis.firstWall) {
    lines.push(`> **First wall:** ${cell(wallLine(report.diagnosis.firstWall))}`);
    lines.push("");
  }

  lines.push("## Run identity", "");
  lines.push(...identityTable(identity));

  lines.push("", "## Setup", "");
  lines.push(
    ...markdownTable(
      ["step", "result", "detail"],
      report.setup.map((step) => [step.name, step.ok ? "ok" : "failed", cell(step.detail)]),
    ),
  );

  for (const [index, section] of SECTIONS.entries()) {
    const note = section.heading?.(report);
    lines.push("", `## ${index + 1}. ${section.title}${note ? ` — ${note}` : ""}`, "");
    lines.push(...section.markdown(report));
  }

  lines.push("", "## What the statements say", "");
  lines.push(
    `Read from each PDF once and checked in beside it. A run is scored against the sum: ${expected.rows} rows, ${expected.charges.toFixed(2)} ${expected.currency} charged.`,
  );
  lines.push("");
  lines.push(...markdownTable(["statement", "group", "rows", "total"], statementRows(statements)));

  lines.push(...ledgerSection(ledger));

  lines.push("", "## Conversation", "");
  lines.push("Prompts and replies. Every turn and every tool call is in the JSON's `events`.");
  for (const phase of report.transcript) {
    lines.push("", `### ${phase.title}`, "");
    lines.push(`**Asked:** ${cell(phase.prompt)}`);
    lines.push("");
    lines.push(phase.reply || "_no reply_");
  }

  lines.push("", "## The skill under test", "");
  lines.push(
    `What the model was handed, verbatim: ${identity.skill.version}, ${identity.skill.length} chars, sha256 \`${identity.skill.sha256}\`. It is short on purpose — everything it leaves out lives in the CLI's own \`--help\`, which is why the profile counts help lookups.`,
  );
  lines.push("");
  lines.push(
    skill === null
      ? "_The installed skill could not be read back._"
      : ["````markdown", skill.trimEnd(), "````"].join("\n"),
  );

  lines.push("", "## Environment adapter (verbatim)", "");
  lines.push("Appended to the skill above, so the model knows what this host can and cannot do.");
  lines.push("", "```markdown", identity.environmentAdapter, "```", "");
  return lines.join("\n");
}

interface WrittenReport {
  markdownPath: string;
  jsonPath: string;
}

/** The report is written before the sandbox is disposed, so the file is still there. */
function readSkill(path: string): string | null {
  const read = tryExecute(() => readFileSync(path, "utf8"));
  return read.ok ? read.value : null;
}

export function writeReport(
  directory: string,
  name: string,
  report: RunReport,
): Result<WrittenReport> {
  const written = tryExecute(() => {
    mkdirSync(directory, { recursive: true });
    const markdownPath = join(directory, `${name}.md`);
    const jsonPath = join(directory, `${name}.json`);
    writeFileSync(markdownPath, renderMarkdown(report, readSkill(report.identity.skill.path)));
    writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
    return { markdownPath, jsonPath };
  });
  if (!written.ok) return { ok: false, error: `cannot write the report: ${written.error}` };
  return written;
}
