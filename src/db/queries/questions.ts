import type Database from "libsql";
import { randomUUID } from "crypto";
import { parseJsonOrNull } from "../../lib/json.js";

interface QuestionTarget {
  transaction_id?: string | null;
  account_id: string | null;
}

interface RecordQuestionInput extends QuestionTarget {
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
  /** Stable signature from context_json the rule synthesizer keys a learned
   *  rule on (so future questions with different prose still match); null learns nothing. */
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
  if (input.transaction_id) {
    db.prepare(`UPDATE transactions SET has_question = 1 WHERE id = ?`).run(input.transaction_id);
  }
  if (input.account_id) {
    db.prepare(`UPDATE accounts SET has_question = 1 WHERE id = ?`).run(input.account_id);
  }
  return id;
}

/** Deletes the row outright (rather than marking it closed); null if the id doesn't exist. */
export function closeQuestion(
  db: Database.Database,
  id: string,
  answer: string,
): ClosedQuestion | null {
  const row = db
    .prepare(
      `SELECT prompt, kind, transaction_id, account_id, context_json FROM questions WHERE id = ?`,
    )
    .get(id) as
    | {
        prompt: string;
        kind: string | null;
        transaction_id: string | null;
        account_id: string | null;
        context_json: string | null;
      }
    | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM questions WHERE id = ?`).run(id);
  maybeClearHasQuestionFlags(db, {
    transaction_id: row.transaction_id,
    account_id: row.account_id,
  });
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

// Safe to call after any resolution; idempotent.
function maybeClearHasQuestionFlags(db: Database.Database, target: QuestionTarget): void {
  if (target.transaction_id) {
    const open = db
      .prepare(`SELECT 1 FROM questions WHERE transaction_id = ? LIMIT 1`)
      .get(target.transaction_id);
    if (!open) db.prepare(`UPDATE transactions SET has_question = 0 WHERE id = ?`).run(target.transaction_id);
  }
  if (target.account_id) {
    const open = db
      .prepare(`SELECT 1 FROM questions WHERE account_id = ? LIMIT 1`)
      .get(target.account_id);
    if (!open) db.prepare(`UPDATE accounts SET has_question = 0 WHERE id = ?`).run(target.account_id);
  }
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
  "(deferred_until IS NULL OR deferred_until <= datetime('now'))";

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

interface ListQuestionsOptions {
  limit?: number;
  batchId?: string;
  includeDeferred?: boolean;
}

const ROW_COLUMNS =
  "id, batch_id, file_id, transaction_id, account_id, kind, prompt, options_json, context_json, deferred_until, created_at";

export function listQuestions(
  db: Database.Database,
  opts: ListQuestionsOptions = {},
): QuestionRow[] {
  const capped = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const conditions: string[] = [];
  const params: any[] = [];
  if (opts.batchId) { conditions.push("batch_id = ?"); params.push(opts.batchId); }
  if (!opts.includeDeferred) conditions.push(ACTIVE_DEFERRED_CLAUSE);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(capped);
  return db.prepare(
    `SELECT ${ROW_COLUMNS}
     FROM questions
     ${where}
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(...params) as QuestionRow[];
}

/**
 * `listQuestions`/`countQuestions` hide deferred rows by default until the
 * timestamp passes; pass `includeDeferred: true` for an unfiltered view.
 */
export function deferQuestion(
  db: Database.Database,
  id: string,
  days: number,
): boolean {
  const safeDays = Math.max(1, Math.floor(days));
  const result = db
    .prepare(`UPDATE questions SET deferred_until = datetime('now', ?) WHERE id = ?`)
    .run(`+${safeDays} days`, id);
  return result.changes > 0;
}
