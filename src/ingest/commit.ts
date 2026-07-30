import type Database from "libsql";
import { config } from "../config.js";
import {
  resolveOnePosting,
  resolveMerchantId,
  type AccountHint,
  type ResolvedMerchant,
} from "../accounts/resolve.js";
import { findAccountCurrency } from "../db/queries/accounts.js";
import {
  insertTransaction,
  insertLinkedTransactions,
  validateTransaction,
  type TransactionInput,
  type ValidateTransactionResult,
} from "../db/queries/transactions.js";
import { deriveTransactionId, deriveGroupId, newTransactionId, newGroupId } from "../lib/ids.js";
import { toMinorUnits } from "../lib/money.js";
import { ISO_DATE_RE } from "../lib/date.js";
import { recordQuestion } from "../db/queries/questions.js";
import type { MerchantUpsertInput } from "../db/queries/merchants.js";

/**
 * Both legs must share a currency (derived from the accounts, never trusted
 * from input); a cross-currency move needs a linked conversion pair.
 */
export const CURRENCY_MISMATCH_HINT =
  "add a linked conversion pair (one leg per currency, sharing a group)";

export interface TransactionCommitContext {
  readonly batchId: string | null;
  readonly fileId: string | null;
  // Enables idempotent transaction id derivation.
  readonly fileHash?: string | null;
}

export interface RawTransactionInput {
  id?: string;
  group_id?: string | null;
  date: string;
  description: string;
  raw_descriptor?: string | null;
  merchant?: MerchantUpsertInput | null;
  merchant_id?: string | null;
  source_file_id?: string | null;
  debit_account_id: string;
  credit_account_id: string;
  // DECIMAL in `currency`; converted to minor units during commit.
  amount: number;
  // Agent-supplied hint; the DERIVED currency from the resolved accounts
  // wins, and a conflict is reported via `currencyOverridden`.
  currency?: string | null;
  code?: string | null;
  user_ref?: string | null;
  source_page?: number | null;
  row_index?: number | null;
  leg_index?: number | null;
}

type TransactionDropReason = "dirty_input" | "currency_mismatch";

type TransactionCommitOutcome =
  | {
      ok: true;
      transactionId: string;
      duplicate: boolean;
      raisedQuestions: number;
      currencyOverridden: boolean;
    }
  | {
      ok: false;
      reason: TransactionDropReason;
      message: string;
      raisedQuestions: number;
    };

type LinkedTransactionsOutcome =
  | {
      ok: true;
      group_id: string;
      results: { id: string; duplicate: boolean }[];
      raisedQuestions: number;
    }
  | {
      ok: false;
      reason: TransactionDropReason;
      message: string;
      raisedQuestions: number;
    };

export type TransactionSide = "debit" | "credit";

export interface TransactionCommitHooks {
  onCommitted(transactionId: string): void;
  onDirtyInput(input: RawTransactionInput, reason: string): void;
  onUnknownMerchant(input: RawTransactionInput, transactionId: string, attemptedId: string): void;
  /** A well-formed multi-segment hint was silently auto-created as a placeholder
   *  account. Reported for the per-side resolution summary; raises NO question. */
  onPlaceholderAccount(side: TransactionSide, accountId: string, transactionId: string): void;
  /** A hint couldn't be built into a well-formed path and fell back to
   *  `expense:uncategorized`. Raises the `uncategorized` question. */
  onUncategorizedFallback(side: TransactionSide, accountId: string, transactionId: string): void;
  /** The side posted to `accountId`, created as asked; `similarId` is an
   *  existing lookalike the caller may want to merge. Raises `similar_accounts`. */
  onSimilarAccount(
    side: TransactionSide,
    accountId: string,
    similarId: string,
    transactionId: string,
  ): void;
  onCurrencyMismatch(
    input: RawTransactionInput,
    debit: { id: string; currency: string },
    credit: { id: string; currency: string },
  ): void;
}

const NON_WORD = /[^\p{L}\p{N}]+/gu;

function normalizeForKey(raw: string): string {
  return raw.toLowerCase().replace(NON_WORD, " ").replace(/\s+/g, " ").trim();
}
function descriptorKey(descriptor: string): string {
  return `descriptor:${normalizeForKey(descriptor)}`;
}
function accountIdKey(id: string): string {
  return `account:${id}`;
}
function accountPairKey(a: string, b: string): string {
  const [lo, hi] = [a, b].sort();
  return `account-pair:${lo}|${hi}`;
}

/**
 * Every raise() no-ops when `ctx.batchId` is null; raised questions attach to
 * `transaction_id`, or none for pre-insert failures.
 */
export function defaultTransactionCommitHooks(
  db: Database.Database,
  ctx: TransactionCommitContext,
): TransactionCommitHooks {
  const raise = (
    input: Omit<Parameters<typeof recordQuestion>[1], "file_id" | "batch_id">,
  ): void => {
    if (!ctx.batchId) return;
    recordQuestion(db, { ...input, file_id: ctx.fileId, batch_id: ctx.batchId });
  };

  return {
    onCommitted: () => {},

    onDirtyInput: (input, reason) =>
      raise({
        transaction_id: null,
        account_id: null,
        kind: "dirty_input",
        prompt:
          `The ingest input produced a transaction that couldn't be validated: ${reason}. ` +
          `Raw description: "${input.description}" on ${input.date}.`,
        context: { description: input.description, date: input.date, reason },
      }),

    onUnknownMerchant: (input, transactionId, attemptedId) => {
      const descriptor = input.raw_descriptor || input.description;
      raise({
        transaction_id: transactionId,
        account_id: null,
        kind: "unknown_merchant",
        prompt:
          `The ingest input referenced merchant id "${attemptedId}" but no such merchant exists. ` +
          `Link "${descriptor}" to an existing merchant or leave it unlinked.`,
        context: { rule_key: descriptorKey(descriptor), descriptor, attempted_id: attemptedId },
      });
    },

    // Empty on purpose: a well-formed placeholder path is unambiguous, so it is
    // recorded for the resolution summary but raises no question.
    onPlaceholderAccount: () => {},

    onUncategorizedFallback: (side, accountId, transactionId) =>
      raise({
        transaction_id: transactionId,
        account_id: accountId,
        kind: "uncategorized",
        prompt:
          `The ${side} side couldn't be matched to a well-formed account and was booked to ` +
          `"${accountId}". Recategorize it onto a real account, or re-run with a full ` +
          `colon-path hint (e.g. expense:food:dining).`,
        context: { rule_key: accountIdKey(accountId), placeholder_id: accountId, side },
      }),

    // Anchored on the lookalike, not the created account: the natural repair is
    // `accounts merge --from <created> --to <lookalike>`, which deletes the
    // created row; anchoring there would cascade this question away unanswered.
    onSimilarAccount: (side, accountId, similarId, transactionId) =>
      raise({
        transaction_id: transactionId,
        account_id: similarId,
        kind: "similar_accounts",
        prompt:
          `The ${side} side posted to "${accountId}", created as asked, but "${similarId}" ` +
          `already looks like the same account. Merge them with \`accounts merge\`, or leave ` +
          `them apart if they are different.`,
        context: {
          rule_key: accountPairKey(accountId, similarId),
          created_id: accountId,
          similar_id: similarId,
          side,
        },
      }),

    onCurrencyMismatch: (input, debit, credit) =>
      raise({
        transaction_id: null,
        account_id: null,
        kind: "currency_mismatch",
        prompt:
          `Transaction "${input.description}" on ${input.date} moves money between ` +
          `${debit.id} (${debit.currency}) and ${credit.id} (${credit.currency}), which use ` +
          `different currencies. A single transaction can't cross currencies: record it as a ` +
          `linked conversion pair (one transaction out of ${debit.currency}, one into ` +
          `${credit.currency}, sharing a group) so the FX conversion is explicit.`,
        context: { debit, credit, date: input.date, description: input.description },
      }),
  };
}

interface PreparedTransaction {
  input: TransactionInput;
  hints: { side: TransactionSide; hint: AccountHint }[];
  merchant: ResolvedMerchant;
  currencyOverridden: boolean;
  raw: RawTransactionInput;
}

type PrepareResult =
  | { ok: true; prepared: PreparedTransaction }
  | { ok: false; reason: "dirty_input"; message: string }
  | {
      ok: false;
      reason: "currency_mismatch";
      message: string;
      debit: { id: string; currency: string };
      credit: { id: string; currency: string };
    };

function validateRawTransaction(input: RawTransactionInput): ValidateTransactionResult {
  if (!ISO_DATE_RE.test(input.date ?? "")) {
    return { ok: false, reason: "date must be an ISO date (YYYY-MM-DD)." };
  }
  if (!input.description || !input.description.trim()) {
    return { ok: false, reason: "description must not be empty." };
  }
  if (!input.debit_account_id || !input.debit_account_id.trim()) {
    return { ok: false, reason: "debit_account_id must not be empty." };
  }
  if (!input.credit_account_id || !input.credit_account_id.trim()) {
    return { ok: false, reason: "credit_account_id must not be empty." };
  }
  if (input.debit_account_id === input.credit_account_id) {
    return { ok: false, reason: "debit and credit accounts must differ." };
  }
  if (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, reason: "amount must be a positive number." };
  }
  return { ok: true };
}

function accountCurrency(db: Database.Database, id: string): string {
  return findAccountCurrency(db, id) || config.displayCurrency;
}

/** Resolution never redirects a side, so two distinct inputs land on one account
 *  only when both fell back to `expense:uncategorized`, left to the dirty_input
 *  backstop, the same as before. */
function resolveTransactionAccounts(
  db: Database.Database,
  debitAccountId: string,
  creditAccountId: string,
): { debitId: string; creditId: string; hints: { side: TransactionSide; hint: AccountHint }[] } {
  const debitRes = resolveOnePosting(db, { account_id: debitAccountId });
  const creditRes = resolveOnePosting(db, { account_id: creditAccountId });

  const hints: { side: TransactionSide; hint: AccountHint }[] = [];
  if (debitRes.hint) hints.push({ side: "debit", hint: debitRes.hint });
  if (creditRes.hint) hints.push({ side: "credit", hint: creditRes.hint });

  return {
    debitId: debitRes.posting.account_id,
    creditId: creditRes.posting.account_id,
    hints,
  };
}

/** Currency comes from the resolved accounts, never from input.
 *  A cross-currency pair is reported as a mismatch rather than merged. */
function deriveTransactionCurrency(
  db: Database.Database,
  debitId: string,
  creditId: string,
):
  | { ok: true; currency: string }
  | { ok: false; debit: { id: string; currency: string }; credit: { id: string; currency: string } } {
  const debitCur = accountCurrency(db, debitId);
  const creditCur = accountCurrency(db, creditId);
  if (debitCur !== creditCur) {
    return {
      ok: false,
      debit: { id: debitId, currency: debitCur },
      credit: { id: creditId, currency: creditCur },
    };
  }
  return { ok: true, currency: debitCur };
}

/** Doesn't touch the transactions table, but resolving may create placeholder
 *  accounts; on a currency mismatch those side effects remain with nothing inserted. */
function prepareTransaction(
  db: Database.Database,
  ctx: TransactionCommitContext,
  input: RawTransactionInput,
): PrepareResult {
  const raw = validateRawTransaction(input);
  if (!raw.ok) return { ok: false, reason: "dirty_input", message: raw.reason };

  const { debitId, creditId, hints } = resolveTransactionAccounts(
    db,
    input.debit_account_id,
    input.credit_account_id,
  );

  const cur = deriveTransactionCurrency(db, debitId, creditId);
  if (!cur.ok) {
    return {
      ok: false,
      reason: "currency_mismatch",
      message: `debit ${cur.debit.id} is ${cur.debit.currency}, credit ${cur.credit.id} is ${cur.credit.currency}`,
      debit: cur.debit,
      credit: cur.credit,
    };
  }
  const currency = cur.currency;
  const currencyOverridden = !!input.currency && input.currency !== currency;

  const amountMinor = toMinorUnits(input.amount, currency);
  const merchant = resolveMerchantId(db, input.merchant_id);

  const id =
    ctx.fileHash && input.row_index != null
      ? deriveTransactionId(
          ctx.fileHash,
          input.source_page ?? 0,
          input.row_index,
          input.leg_index ?? undefined,
        )
      : input.id ?? newTransactionId();

  const built: TransactionInput = {
    id,
    group_id: input.group_id ?? null,
    date: input.date,
    description: input.description,
    merchant_id: merchant.merchantId,
    merchant: input.merchant ?? null,
    raw_descriptor: input.raw_descriptor ?? null,
    source_file_id: input.source_file_id ?? ctx.fileId ?? null,
    source_page: input.source_page ?? null,
    debit_account_id: debitId,
    credit_account_id: creditId,
    amount: amountMinor,
    currency,
    code: input.code ?? null,
    user_ref: input.user_ref ?? null,
  };

  // Backstop: both sides can still fall back to `expense:uncategorized`, which
  // validateTransaction catches as debit == credit.
  const v = validateTransaction(built);
  if (!v.ok) return { ok: false, reason: "dirty_input", message: v.reason };

  return { ok: true, prepared: { input: built, hints, merchant, currencyOverridden, raw: input } };
}

interface HintDispatchArgs {
  hooks: TransactionCommitHooks;
  side: TransactionSide;
  transactionId: string;
}

/** This union is also dispatched in cli/commands/ingest-commit.ts, so a new
 *  variant must be handled in both; the Record makes the compiler enforce it
 *  here. Returns the number of questions raised. */
const HINT_DISPATCH: {
  [K in AccountHint["type"]]: (hint: Extract<AccountHint, { type: K }>, args: HintDispatchArgs) => number;
} = {
  placeholder_created: (hint, { hooks, side, transactionId }) => {
    hooks.onPlaceholderAccount(side, hint.accountId, transactionId);
    return 0;
  },
  uncategorized_fallback: (hint, { hooks, side, transactionId }) => {
    hooks.onUncategorizedFallback(side, hint.accountId, transactionId);
    return 1;
  },
  similar_account: (hint, { hooks, side, transactionId }) => {
    hooks.onSimilarAccount(side, hint.accountId, hint.similarId, transactionId);
    return 1;
  },
};

function applyTransactionHints(
  hooks: TransactionCommitHooks,
  transactionId: string,
  prepared: PreparedTransaction,
): number {
  let raised = 0;
  if (prepared.merchant.attemptedUnknownId) {
    hooks.onUnknownMerchant(prepared.raw, transactionId, prepared.merchant.attemptedUnknownId);
    raised++;
  }
  for (const { side, hint } of prepared.hints) {
    raised += HINT_DISPATCH[hint.type](hint as never, { hooks, side, transactionId });
  }
  return raised;
}

/** A duplicate re-commit is a no-op: no questions raised, no balance change. */
export function commitTransaction(
  db: Database.Database,
  ctx: TransactionCommitContext,
  input: RawTransactionInput,
  hooks: TransactionCommitHooks = defaultTransactionCommitHooks(db, ctx),
): TransactionCommitOutcome {
  const prep = prepareTransaction(db, ctx, input);
  if (!prep.ok) {
    if (prep.reason === "currency_mismatch") {
      hooks.onCurrencyMismatch(input, prep.debit, prep.credit);
    } else {
      hooks.onDirtyInput(input, prep.message);
    }
    return { ok: false, reason: prep.reason, message: prep.message, raisedQuestions: 1 };
  }

  const { id, duplicate } = insertTransaction(db, prep.prepared.input);
  if (duplicate) {
    return {
      ok: true,
      transactionId: id,
      duplicate: true,
      raisedQuestions: 0,
      currencyOverridden: prep.prepared.currencyOverridden,
    };
  }

  hooks.onCommitted(id);
  const raised = applyTransactionHints(hooks, id, prep.prepared);
  return {
    ok: true,
    transactionId: id,
    duplicate: false,
    raisedQuestions: raised,
    currencyOverridden: prep.prepared.currencyOverridden,
  };
}

export interface LinkedTransactionHeader {
  date: string;
  description: string;
  raw_descriptor?: string | null;
  source_file_id?: string | null;
  source_page?: number | null;
  merchant?: MerchantUpsertInput | null;
  merchant_id?: string | null;
  group_id?: string | null;
  row_index?: number | null;
}

export interface LinkedTransactionLeg {
  debit_account_id: string;
  credit_account_id: string;
  /** DECIMAL amount for this leg. */
  amount: number;
  currency?: string | null;
  /** Falls back to the header's description when omitted. */
  description?: string;
  code?: string | null;
  user_ref?: string | null;
}

function mergeHeaderLeg(
  header: LinkedTransactionHeader,
  leg: LinkedTransactionLeg,
  groupId: string,
  legIndex: number,
): RawTransactionInput {
  return {
    group_id: groupId,
    date: header.date,
    description: leg.description ?? header.description,
    raw_descriptor: header.raw_descriptor ?? null,
    source_file_id: header.source_file_id ?? null,
    source_page: header.source_page ?? null,
    merchant: header.merchant ?? null,
    merchant_id: header.merchant_id ?? null,
    debit_account_id: leg.debit_account_id,
    credit_account_id: leg.credit_account_id,
    amount: leg.amount,
    currency: leg.currency ?? null,
    code: leg.code ?? null,
    user_ref: leg.user_ref ?? null,
    row_index: header.row_index ?? null,
    leg_index: legIndex,
  };
}

/** Atomic under one group_id: every leg is prepared first; if any fails, nothing is inserted. */
export function commitLinkedTransactions(
  db: Database.Database,
  ctx: TransactionCommitContext,
  header: LinkedTransactionHeader,
  legs: LinkedTransactionLeg[],
  hooks: TransactionCommitHooks = defaultTransactionCommitHooks(db, ctx),
): LinkedTransactionsOutcome {
  if (legs.length === 0) {
    return { ok: false, reason: "dirty_input", message: "linked transaction has no legs.", raisedQuestions: 0 };
  }

  const groupId =
    header.group_id ??
    (ctx.fileHash && header.row_index != null
      ? deriveGroupId(ctx.fileHash, header.source_page ?? 0, header.row_index)
      : newGroupId());

  const preps: PreparedTransaction[] = [];
  for (let i = 0; i < legs.length; i++) {
    const raw = mergeHeaderLeg(header, legs[i], groupId, i);
    const prep = prepareTransaction(db, ctx, raw);
    if (!prep.ok) {
      if (prep.reason === "currency_mismatch") {
        hooks.onCurrencyMismatch(raw, prep.debit, prep.credit);
      } else {
        hooks.onDirtyInput(raw, prep.message);
      }
      return { ok: false, reason: prep.reason, message: prep.message, raisedQuestions: 1 };
    }
    preps.push(prep.prepared);
  }

  const { results, group_id } = insertLinkedTransactions(
    db,
    preps.map((p) => p.input),
    { group_id: groupId },
  );

  let raised = 0;
  for (let i = 0; i < preps.length; i++) {
    const r = results[i];
    if (r.duplicate) continue;
    hooks.onCommitted(r.id);
    raised += applyTransactionHints(hooks, r.id, preps[i]);
  }
  return { ok: true, group_id, results, raisedQuestions: raised };
}
