import type { Command } from "commander";
import type { QuestionRow } from "../../db/queries/questions.js";
import { emitList, fail, runAction, type Column } from "../output.js";
import { openDb } from "../db.js";
import * as z from "zod";
import { parseInput, str, int } from "../../lib/validate.js";
import { parseJsonOrNull } from "../../lib/json.js";

interface QuestionListRow {
  id: string;
  kind: string | null;
  prompt: string;
  transaction_id: string | null;
  account_id: string | null;
  options: unknown;
  context: unknown;
  file_id: string | null;
  created_at: string;
}

function toListRow(row: QuestionRow): QuestionListRow {
  return {
    id: row.id,
    kind: row.kind,
    prompt: row.prompt,
    transaction_id: row.transaction_id,
    account_id: row.account_id,
    options: parseJsonOrNull(row.options_json),
    context: parseJsonOrNull(row.context_json),
    file_id: row.file_id,
    created_at: row.created_at,
  };
}

// `prompt` is the only free-text field; options/context are structured JSON
// carrying ids the agent needs verbatim, so they're left intact.
const QUESTION_REDACT_FIELDS = ["prompt"] as const;

const LIST_COLUMNS: Column<QuestionListRow>[] = [
  { header: "ID", value: (r) => r.id },
  { header: "Kind", value: (r) => r.kind ?? "" },
  { header: "Prompt", value: (r) => r.prompt },
  { header: "Transaction ID", value: (r) => r.transaction_id ?? "" },
  { header: "Account ID", value: (r) => r.account_id ?? "" },
  { header: "Options", value: (r) => (r.options != null ? JSON.stringify(r.options) : "") },
  { header: "Context", value: (r) => (r.context != null ? JSON.stringify(r.context) : "") },
  { header: "File ID", value: (r) => r.file_id ?? "" },
  { header: "Created At", value: (r) => r.created_at },
];

interface AnsweredRow {
  id: string;
  kind: string | null;
  answer: string;
  rule_key: string | null;
}

const ANSWERED_COLUMNS: Column<AnsweredRow>[] = [
  { header: "ID", value: (r) => r.id },
  { header: "Kind", value: (r) => r.kind ?? "" },
  { header: "Answer", value: (r) => r.answer },
  { header: "Rule Key", value: (r) => r.rule_key ?? "" },
];

const DEFER_COLUMNS: Column<{ id: string; days: number }>[] = [
  { header: "ID", value: (r) => r.id },
  { header: "Days", value: (r) => String(r.days) },
];

interface ListQuestionsOpts {
  batch?: string;
  includeDeferred?: boolean;
  redact?: boolean;
}

async function listQuestions(opts: ListQuestionsOpts): Promise<void> {
  const { listQuestions: queryQuestions } = await import("../../db/queries/questions.js");
  const db = await openDb();
  const rows = queryQuestions(db, {
    batchId: opts.batch,
    includeDeferred: !!opts.includeDeferred,
  });
  let listRows = rows.map(toListRow);
  if (opts.redact) {
    const { applyRedaction } = await import("../../privacy/redactor.js");
    listRows = applyRedaction(listRows, true, QUESTION_REDACT_FIELDS);
  }
  emitList(listRows, LIST_COLUMNS);
}

const ANSWER_SPEC = z.object({
  answer: str(),
  also: str().optional(),
});

async function answerQuestion(id: string, opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(ANSWER_SPEC, opts);
  const also: string[] = parsed.also
    ? parsed.also.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const ids = [id, ...also];

  const { closeQuestion } = await import("../../db/queries/questions.js");
  const db = await openDb();

  const results: AnsweredRow[] = [];
  for (const qid of ids) {
    const closed = closeQuestion(db, qid, parsed.answer);
    if (!closed) fail("NOT_FOUND", `question "${qid}" not found`);
    results.push({ id: qid, kind: closed.kind, answer: closed.answer, rule_key: closed.rule_key });
  }
  emitList(results, ANSWERED_COLUMNS);
}

const DEFER_SPEC = z.object({
  days: int().default(7),
});

async function deferQuestion(id: string, opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(DEFER_SPEC, opts);
  const { deferQuestion: deferQuestionRow } = await import("../../db/queries/questions.js");
  const db = await openDb();
  const ok = deferQuestionRow(db, id, parsed.days);
  if (!ok) fail("NOT_FOUND", `question "${id}" not found`);
  emitList([{ id, days: parsed.days }], DEFER_COLUMNS);
}

export function registerQuestions(program: Command): void {
  const questions = program
    .command("questions")
    .description("List, answer, and defer open questions")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: the harness opens a question when a row is ambiguous; you list them, then answer or defer.",
        "Typical flow: list --json, resolve each by kind (merge, recategorize, upsert), then answer or defer.",
        "Example: oled questions list --json",
      ].join("\n"),
    );

  questions
    .command("list")
    .description("List questions")
    .option("--batch <id>", "filter by batch id")
    .option("--include-deferred", "include deferred questions")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(listQuestions));

  questions
    .command("answer <id>")
    .description("Answer a question")
    .option("--answer <text>", "the answer text")
    .option("--also <ids>", "additional question ids to answer")
    .action(runAction(answerQuestion));

  questions
    .command("defer <id>")
    .description("Defer a question")
    .option("--days <n>", "number of days to defer")
    .action(runAction(deferQuestion));
}
