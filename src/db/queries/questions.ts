import type Database from "libsql";
import { randomUUID } from "crypto";
import { parseJsonOrNull } from "../../lib/json.js";
import { clampLimit, clampOffset } from "../../lib/limit.js";
import { ISO_NOW_SQL, ISO_SHIFTED_SQL } from "../timestamps.js";

interface RecordQuestionInput {
  transaction_id?: string | null;
  account_id: string | null;
  file_id: string | null;
  batch_id?: string | null;
  kind?: string | null;
  prompt: string;
  options?: string[];
  /** Kind-specific structured context (e.g. partner ids for similar_accounts). */
  context?: Record<string, unknown> | null;
}

export interface QuestionRow {
  id: string;
  batch_id: string | null;
  file_id: string | null;
  transaction_id: string | null;
  account_id: string | null;
  kind: string | null;
  prompt: string;
  options_json: string | null;
  context_json: string | null;
  deferred_until: string | null;
  created_at: string;
}

interface ClosedQuestion {
  prompt: string;
  kind: string | null;
  answer: string;
  /** Stable signature from context_json the rule synthesizer keys a learned rule on; null learns nothing. */
  rule_key: string | null;
}

/** The `cn:` id prefix is opaque - nothing else parses it. */
export function recordQuestion(db: Database.Database, input: RecordQuestionInput): string {
  const id = `cn:${randomUUID()}`;
  db.prepare(
    `INSERT INTO questions (id, batch_id, file_id, transaction_id, account_id, kind, prompt, options_json, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.batch_id ?? null,
    input.file_id,
    input.transaction_id ?? null,
    input.account_id,
    input.kind ?? null,
    input.prompt,
    input.options ? JSON.stringify(input.options) : null,
    input.context ? JSON.stringify(input.context) : null,
  );
  return id;
}

/** Deletes the row outright (rather than marking it closed); null if the id doesn't exist. */
export function closeQuestion(
  db: Database.Database,
  id: string,
  answer: string,
): ClosedQuestion | null {
  const row = db
    .prepare(`SELECT prompt, kind, context_json FROM questions WHERE id = ?`)
    .get(id) as
    | { prompt: string; kind: string | null; context_json: string | null }
    | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM questions WHERE id = ?`).run(id);
  return {
    prompt: row.prompt,
    kind: row.kind,
    answer,
    rule_key: extractRuleKey(row.context_json),
  };
}

function extractRuleKey(contextJson: string | null): string | null {
  const parsed = parseJsonOrNull(contextJson) as { rule_key?: unknown } | null;
  return typeof parsed?.rule_key === "string" ? parsed.rule_key : null;
}

interface CountQuestionsScope {
  file_id?: string;
  transaction_id?: string;
  account_id?: string;
  kind?: string;
  batch_id?: string;
  includeDeferred?: boolean;
}

const ACTIVE_DEFERRED_CLAUSE =
  `(deferred_until IS NULL OR deferred_until <= ${ISO_NOW_SQL})`;

export function countQuestions(db: Database.Database, scope: CountQuestionsScope = {}): number {
  const conditions: string[] = [];
  const params: any[] = [];
  if (scope.file_id)     { conditions.push("file_id = ?");     params.push(scope.file_id); }
  if (scope.transaction_id) { conditions.push("transaction_id = ?"); params.push(scope.transaction_id); }
  if (scope.account_id)  { conditions.push("account_id = ?");  params.push(scope.account_id); }
  if (scope.kind)           { conditions.push("kind = ?");           params.push(scope.kind); }
  if (scope.batch_id)       { conditions.push("batch_id = ?");       params.push(scope.batch_id); }
  if (!scope.includeDeferred) conditions.push(ACTIVE_DEFERRED_CLAUSE);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM questions ${where}`)
    .get(...params) as { n: number };
  return row.n;
}

/** Snake_case like CountQuestionsScope, so one filter object can feed both. */
interface ListQuestionsOptions {
  limit?: number;
  offset?: number;
  batch_id?: string;
  includeDeferred?: boolean;
}

const ROW_COLUMNS =
  "id, batch_id, file_id, transaction_id, account_id, kind, prompt, options_json, context_json, deferred_until, created_at";

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

export function clampQuestionsLimit(limit?: number): number {
  return clampLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
}

export function listQuestions(
  db: Database.Database,
  opts: ListQuestionsOptions = {},
): QuestionRow[] {
  const capped = clampQuestionsLimit(opts.limit);
  const conditions: string[] = [];
  const params: any[] = [];
  if (opts.batch_id) { conditions.push("batch_id = ?"); params.push(opts.batch_id); }
  if (!opts.includeDeferred) conditions.push(ACTIVE_DEFERRED_CLAUSE);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(capped, clampOffset(opts.offset));
  return db.prepare(
    `SELECT ${ROW_COLUMNS}
     FROM questions
     ${where}
     ORDER BY created_at ASC
     LIMIT ? OFFSET ?`,
  ).all(...params) as QuestionRow[];
}

/** `listQuestions`/`countQuestions` hide deferred rows by default until the timestamp passes (`includeDeferred: true` shows all). */
export function deferQuestion(
  db: Database.Database,
  id: string,
  days: number,
): boolean {
  const safeDays = Math.max(1, Math.floor(days));
  const result = db
    .prepare(`UPDATE questions SET deferred_until = ${ISO_SHIFTED_SQL} WHERE id = ?`)
    .run(`+${safeDays} days`, id);
  return result.changes > 0;
}
