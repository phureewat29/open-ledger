import type Database from "libsql";
import {
  ensureUncategorizedFallback,
  namesUnopenedLedger,
  resolveOnePosting,
  resolveMerchantId,
  type AccountHint,
  type PostingResolution,
  type ResolvedMerchant,
} from "../accounts/resolve.js";
import {
  findTransactionById,
  insertTransaction,
  insertLinkedTransactions,
  invalidTransaction,
  validateTransaction,
  validateTransactionFields,
  type TransactionInput,
  type ValidateTransactionResult,
} from "../db/queries/transactions.js";
import {
  currencyOf,
  deriveTransactionId,
  deriveGroupId,
  isLedgerScopedId,
  newTransactionId,
  newGroupId,
} from "../lib/ids.js";
import { toMinorUnits } from "../lib/money.js";
import { ledgerExists } from "../db/queries/accounts.js";
import { upsertMerchant, type MerchantUpsertInput } from "../db/queries/merchants.js";
import {
  raiseCurrencyMismatch,
  raiseDirtyInput,
  raiseSimilarAccount,
  raiseUncategorizedFallback,
  raiseUnknownLedger,
  raiseUnknownMerchant,
  type QuestionContext,
  type TransactionSide,
} from "./questions.js";
import { noiseTokens } from "../datasets/noise.js";
import { config } from "../config.js";

export const CURRENCY_MISMATCH_HINT =
  "add a linked conversion pair through <currency>:equity:conversion (one leg per currency, sharing a group)";

export interface TransactionCommitContext extends QuestionContext {
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
  // Hint only; account ids' currency wins, conflict surfaces as `currencyOverridden`.
  currency?: string | null;
  source_page?: number | null;
  row_index?: number | null;
  leg_index?: number | null;
}

type TransactionDropReason = "dirty_input" | "currency_mismatch";

/** `unopenedLedger` flags the currency_mismatch whose repair is opening that
 *  ledger, not a conversion pair; callers branch on it, not on message text. */
interface CommitDrop {
  ok: false;
  reason: TransactionDropReason;
  message: string;
  raisedQuestions: number;
  unopenedLedger?: string;
}

type SideHow =
  | "exact"
  | "similar_account"
  | "placeholder_created"
  | "uncategorized_fallback"
  | "as_committed";

/** Callers emit these fields verbatim: declared key order is the NDJSON key order. */
interface CommittedSide {
  side: TransactionSide;
  requested: string;
  resolved: string;
  how: SideHow;
  similar_to?: string;
}

/** `unknown` means the row named a merchant id no merchant here answers to. */
interface CommittedMerchant {
  how: "none" | "unknown" | "linked";
  merchant_id?: string;
}

type TransactionCommitOutcome =
  | {
      ok: true;
      transactionId: string;
      duplicate: boolean;
      raisedQuestions: number;
      currencyOverridden: boolean;
      /** Debit first, then credit. */
      sides: CommittedSide[];
      merchant: CommittedMerchant;
    }
  | CommitDrop;

/** No `sides` here: each leg has its own pair; the group is what's reported. */
type LinkedTransactionsOutcome =
  | {
      ok: true;
      group_id: string;
      results: { id: string; duplicate: boolean }[];
      raisedQuestions: number;
      /** True when any leg stated a currency its accounts overruled. */
      currencyOverridden: boolean;
      merchant: CommittedMerchant;
    }
  | CommitDrop;

/** One side, resolved: the hint is null only when it posted exactly as asked. */
interface PreparedSide {
  side: TransactionSide;
  requested: string;
  resolved: string;
  hint: AccountHint | null;
}

interface PreparedTransaction {
  input: TransactionInput;
  /** Debit first, then credit. */
  sides: PreparedSide[];
  merchant: ResolvedMerchant;
  currencyOverridden: boolean;
  raw: RawTransactionInput;
}

interface UnopenedLedgerRefusal {
  ok: false;
  reason: "unknown_ledger";
  message: string;
  side: TransactionSide;
  accountId: string;
  ledger: string;
}

type DirtyInput = { ok: false; reason: "dirty_input"; message: string };

/** What `refuseRow` decides, all of it by pure read. */
type PrepareFailure =
  | DirtyInput
  | {
      ok: false;
      reason: "currency_mismatch";
      message: string;
      debit: { id: string; currency: string };
      credit: { id: string; currency: string };
    }
  | UnopenedLedgerRefusal;

/** What `resolveRow` decides, once refusals are past: only the row's own
 *  accounts can still fail it. */
type ResolveResult = { ok: true; prepared: PreparedTransaction } | DirtyInput;

function validateRawTransaction(input: RawTransactionInput): ValidateTransactionResult {
  const fields = validateTransactionFields(input);
  if (!fields.ok) return fields;
  // tx: ids make re-ingest idempotent; a caller-supplied id must stay in that namespace.
  if (input.id != null && !input.id.startsWith("tx:")) {
    return invalidTransaction('id must start with "tx:".');
  }
  if (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount <= 0) {
    return invalidTransaction("amount must be a positive number.");
  }
  // 3 is the largest ISO exponent; an amount overflowing x1000 fits no currency's minor units.
  if (input.amount * 1000 > Number.MAX_SAFE_INTEGER) {
    return invalidTransaction("amount is too large to hold in any currency's minor units.");
  }
  return { ok: true };
}

/** An unplaced side carries the fallback as its own hint, so it explains itself. */
function preparedSide(
  side: TransactionSide,
  requested: string,
  resolved: string,
  posting: PostingResolution,
): PreparedSide {
  const hint = posting.accountId
    ? posting.hint
    : ({ type: "uncategorized_fallback", accountId: resolved } as const);
  return { side, requested, resolved, hint };
}

/** An unplaced side inherits the other side's ledger; both unplaced is dirty_input. */
function resolveTransactionAccounts(
  db: Database.Database,
  debitAccountId: string,
  creditAccountId: string,
): { ok: true; debit: PreparedSide; credit: PreparedSide } | { ok: false } {
  const debit = resolveOnePosting(db, debitAccountId);
  const credit = resolveOnePosting(db, creditAccountId);
  if (!debit.accountId && !credit.accountId) return { ok: false };

  const debitId = debit.accountId ?? ensureUncategorizedFallback(db, currencyOf(credit.accountId!));
  const creditId = credit.accountId ?? ensureUncategorizedFallback(db, currencyOf(debit.accountId!));

  return {
    ok: true,
    debit: preparedSide("debit", debitAccountId, debitId, debit),
    credit: preparedSide("credit", creditAccountId, creditId, credit),
  };
}

/** Refuses the whole row before either side resolves, so a good side's
 *  placeholder tree can't outlive a refused row. */
function unopenedLedgerRefusal(
  db: Database.Database,
  side: TransactionSide,
  accountId: string,
): UnopenedLedgerRefusal | null {
  if (!namesUnopenedLedger(db, accountId)) return null;
  const ledger = currencyOf(accountId).toLowerCase();
  return {
    ok: false,
    reason: "unknown_ledger",
    side,
    accountId,
    ledger,
    message:
      `${side} ${accountId} names ledger "${ledger}", which does not exist here; ` +
      "open it with `oled accounts create`, or fix the currency prefix",
  };
}

/** Only heads naming an EXISTING ledger count as a mismatch; an unopened
 *  ledger is `unopenedLedgerRefusal`'s to catch. */
function crossLedger(
  db: Database.Database,
  debitAccountId: string,
  creditAccountId: string,
): boolean {
  if (!isLedgerScopedId(debitAccountId) || !isLedgerScopedId(creditAccountId)) return false;
  const debitCurrency = currencyOf(debitAccountId);
  const creditCurrency = currencyOf(creditAccountId);
  if (debitCurrency === creditCurrency) return false;
  return ledgerExists(db, debitCurrency) && ledgerExists(db, creditCurrency);
}

/** Pure-read refusals only, decided before resolution writes anything; shared
 *  with the compound pre-scan so a bad later leg is caught first. */
function refuseRow(db: Database.Database, input: RawTransactionInput): PrepareFailure | null {
  const raw = validateRawTransaction(input);
  if (!raw.ok) return { ok: false, reason: "dirty_input", message: raw.message };

  const unopened =
    unopenedLedgerRefusal(db, "debit", input.debit_account_id) ??
    unopenedLedgerRefusal(db, "credit", input.credit_account_id);
  if (unopened) return unopened;

  if (crossLedger(db, input.debit_account_id, input.credit_account_id)) {
    const debit = { id: input.debit_account_id, currency: currencyOf(input.debit_account_id) };
    const credit = { id: input.credit_account_id, currency: currencyOf(input.credit_account_id) };
    return {
      ok: false,
      reason: "currency_mismatch",
      message: `debit ${debit.id} is ${debit.currency}, credit ${credit.id} is ${credit.currency}`,
      debit,
      credit,
    };
  }
  return null;
}

/** Resolution writes — placeholder accounts, ledger structure — and no later
 *  refusal can take them back, so `refuseRow` must have cleared this row (and,
 *  in a group, every other leg) before this runs. */
function resolveRow(
  db: Database.Database,
  ctx: TransactionCommitContext,
  input: RawTransactionInput,
): ResolveResult {
  const resolved = resolveTransactionAccounts(
    db,
    input.debit_account_id,
    input.credit_account_id,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      reason: "dirty_input",
      message: "neither account id names a path in an existing ledger.",
    };
  }
  const { debit, credit } = resolved;

  const currency = currencyOf(debit.resolved);
  const currencyOverridden = !!input.currency && input.currency.toUpperCase() !== currency;

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
    // Resolved here because db/queries may not read `src/datasets/`.
    merchant: input.merchant
      ? { ...input.merchant, noise_tokens: noiseTokens(config.country) }
      : null,
    raw_descriptor: input.raw_descriptor ?? null,
    source_file_id: input.source_file_id ?? ctx.fileId ?? null,
    source_page: input.source_page ?? null,
    debit_account_id: debit.resolved,
    credit_account_id: credit.resolved,
    amount: amountMinor,
  };

  // Backstop: a shared fallback account surfaces as validateTransaction's debit == credit check.
  const v = validateTransaction(built);
  if (!v.ok) return { ok: false, reason: "dirty_input", message: v.message };

  return {
    ok: true,
    prepared: { input: built, sides: [debit, credit], merchant, currencyOverridden, raw: input },
  };
}

interface HintDispatchArgs {
  db: Database.Database;
  ctx: TransactionCommitContext;
  side: TransactionSide;
  transactionId: string;
}

interface SideOutcome {
  how: SideHow;
  similar_to?: string;
  /** Questions this hint raised. */
  raised: number;
}

/** Each arm raises the question its hint earns and names how the side landed. */
const HINT_DISPATCH: {
  [K in AccountHint["type"]]: (
    hint: Extract<AccountHint, { type: K }>,
    args: HintDispatchArgs,
  ) => SideOutcome;
} = {
  // A placeholder path is unambiguous: reported in the side summary, no question raised.
  placeholder_created: () => ({ how: "placeholder_created", raised: 0 }),
  uncategorized_fallback: (hint, { db, ctx, side, transactionId }) => ({
    how: "uncategorized_fallback",
    raised: raiseUncategorizedFallback(db, ctx, side, hint.accountId, transactionId),
  }),
  similar_account: (hint, { db, ctx, side, transactionId }) => ({
    how: "similar_account",
    similar_to: hint.similarId,
    raised: raiseSimilarAccount(db, ctx, side, hint.accountId, hint.similarId, transactionId),
  }),
};

const POSTED_EXACTLY: SideOutcome = { how: "exact", raised: 0 };

type CommitFailure = Extract<TransactionCommitOutcome, { ok: false }>;

/** Unopened ledger reports as `currency_mismatch`; its own message names the
 *  missing ledger. */
const PREPARE_FAILURE_DISPATCH: {
  [K in PrepareFailure["reason"]]: (
    db: Database.Database,
    ctx: TransactionCommitContext,
    failure: Extract<PrepareFailure, { reason: K }>,
    input: RawTransactionInput,
  ) => { reason: TransactionDropReason; raised: 0 | 1 };
} = {
  dirty_input: (db, ctx, failure, input) => ({
    reason: "dirty_input",
    raised: raiseDirtyInput(db, ctx, input, failure.message),
  }),
  currency_mismatch: (db, ctx, failure, input) => ({
    reason: "currency_mismatch",
    raised: raiseCurrencyMismatch(db, ctx, input, failure.debit, failure.credit),
  }),
  unknown_ledger: (db, ctx, failure, input) => ({
    reason: "currency_mismatch",
    raised: raiseUnknownLedger(db, ctx, input, failure.side, failure.accountId, failure.ledger),
  }),
};

function reportPrepareFailure(
  db: Database.Database,
  ctx: TransactionCommitContext,
  failure: PrepareFailure,
  input: RawTransactionInput,
): CommitFailure {
  const dropped = PREPARE_FAILURE_DISPATCH[failure.reason](db, ctx, failure as never, input);
  return {
    ok: false,
    reason: dropped.reason,
    message: failure.message,
    raisedQuestions: dropped.raised,
    ...(failure.reason === "unknown_ledger" ? { unopenedLedger: failure.ledger } : {}),
  };
}

function applyTransactionHints(
  db: Database.Database,
  ctx: TransactionCommitContext,
  transactionId: string,
  prepared: PreparedTransaction,
): { sides: CommittedSide[]; raisedQuestions: number } {
  let raised = 0;
  if (prepared.merchant.attemptedUnknownId) {
    raised += raiseUnknownMerchant(
      db,
      ctx,
      prepared.raw,
      transactionId,
      prepared.merchant.attemptedUnknownId,
    );
  }

  const sides: CommittedSide[] = [];
  for (const { side, requested, resolved, hint } of prepared.sides) {
    const outcome = hint
      ? HINT_DISPATCH[hint.type](hint as never, { db, ctx, side, transactionId })
      : POSTED_EXACTLY;
    raised += outcome.raised;
    sides.push({
      side,
      requested,
      resolved,
      how: outcome.how,
      ...(outcome.similar_to ? { similar_to: outcome.similar_to } : {}),
    });
  }
  return { sides, raisedQuestions: raised };
}

/** `unknown` merchant id still commits, unlinked. `committedId` reads back an
 *  upsert's id, assigned only at insert time. */
function committedMerchant(
  prepared: PreparedTransaction,
  committedId: () => string | null,
): CommittedMerchant {
  const { raw, merchant } = prepared;
  if (!raw.merchant && !raw.merchant_id) return { how: "none" };
  if (merchant.attemptedUnknownId) return { how: "unknown" };
  const id = merchant.merchantId ?? committedId();
  if (!id) return { how: "linked" };
  return { how: "linked", merchant_id: id };
}

/** Reports what the stored row holds now, not what this run resolved (it may
 *  have been recategorized since). */
function reportStoredRow(
  db: Database.Database,
  transactionId: string,
  prepared: PreparedTransaction,
): { sides: CommittedSide[]; merchant: CommittedMerchant } {
  const stored = findTransactionById(db, transactionId);
  const sides: CommittedSide[] = [
    {
      side: "debit",
      requested: prepared.raw.debit_account_id,
      resolved: stored?.debit_account_id ?? prepared.input.debit_account_id,
      how: "as_committed",
    },
    {
      side: "credit",
      requested: prepared.raw.credit_account_id,
      resolved: stored?.credit_account_id ?? prepared.input.credit_account_id,
      how: "as_committed",
    },
  ];
  return { sides, merchant: committedMerchant(prepared, () => stored?.merchant_id ?? null) };
}

/** A duplicate re-commit is a no-op: no questions raised, no balance change. */
export function commitTransaction(
  db: Database.Database,
  ctx: TransactionCommitContext,
  input: RawTransactionInput,
): TransactionCommitOutcome {
  const refused = refuseRow(db, input);
  if (refused) return reportPrepareFailure(db, ctx, refused, input);

  const prep = resolveRow(db, ctx, input);
  if (!prep.ok) return reportPrepareFailure(db, ctx, prep, input);
  const prepared = prep.prepared;

  const { id, duplicate } = insertTransaction(db, prepared.input);
  if (duplicate) {
    const stored = reportStoredRow(db, id, prepared);
    return {
      ok: true,
      transactionId: id,
      duplicate: true,
      raisedQuestions: 0,
      currencyOverridden: prepared.currencyOverridden,
      sides: stored.sides,
      merchant: stored.merchant,
    };
  }

  const { sides, raisedQuestions } = applyTransactionHints(db, ctx, id, prepared);
  return {
    ok: true,
    transactionId: id,
    duplicate: false,
    raisedQuestions,
    currencyOverridden: prepared.currencyOverridden,
    sides,
    merchant: committedMerchant(prepared, () => findTransactionById(db, id)?.merchant_id ?? null),
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
    row_index: header.row_index ?? null,
    leg_index: legIndex,
  };
}

/**
 * Every leg carries the header's merchant, so one claim covers the group: left
 * to `insertTransaction`, the same merchant would be upserted, and its alias
 * re-claimed, once per leg. The claim sits ahead of the legs' transaction, so a
 * transaction still cannot land without its merchant. What that costs: a group
 * abandoned mid-insert leaves the merchant and its alias claim behind, where a
 * per-leg upsert would have rolled back with the write.
 */
function claimGroupMerchant(
  db: Database.Database,
  inputs: TransactionInput[],
): TransactionInput[] {
  const first = inputs[0];
  if (first.merchant_id || !first.merchant) return inputs;
  const { id } = upsertMerchant(db, first.merchant, first.merchant.noise_tokens);
  return inputs.map((input) => ({ ...input, merchant_id: id, merchant: null }));
}

/** Atomic under one group_id: every leg is prepared first; if any fails, nothing is inserted. */
export function commitLinkedTransactions(
  db: Database.Database,
  ctx: TransactionCommitContext,
  header: LinkedTransactionHeader,
  legs: LinkedTransactionLeg[],
): LinkedTransactionsOutcome {
  if (legs.length === 0) {
    return { ok: false, reason: "dirty_input", message: "linked transaction has no legs.", raisedQuestions: 0 };
  }

  const groupId =
    header.group_id ??
    (ctx.fileHash && header.row_index != null
      ? deriveGroupId(ctx.fileHash, header.source_page ?? 0, header.row_index)
      : newGroupId());

  const merged = legs.map((leg, i) => mergeHeaderLeg(header, leg, groupId, i));

  // Pre-scan every leg's pure refusals first: a resolution write for leg 0
  // must not outlive a refusal of leg 1.
  for (const raw of merged) {
    const refused = refuseRow(db, raw);
    if (refused) return reportPrepareFailure(db, ctx, refused, raw);
  }

  const preps: PreparedTransaction[] = [];
  for (const raw of merged) {
    const prep = resolveRow(db, ctx, raw);
    if (!prep.ok) return reportPrepareFailure(db, ctx, prep, raw);
    preps.push(prep.prepared);
  }

  const { results, group_id } = insertLinkedTransactions(
    db,
    claimGroupMerchant(db, preps.map((p) => p.input)),
    { group_id: groupId },
  );

  let raised = 0;
  for (let i = 0; i < preps.length; i++) {
    const r = results[i];
    if (r.duplicate) continue;
    raised += applyTransactionHints(db, ctx, r.id, preps[i]).raisedQuestions;
  }
  // Every leg carries the header's merchant, so the first one speaks for the group.
  const merchant = committedMerchant(
    preps[0],
    () => findTransactionById(db, results[0].id)?.merchant_id ?? null,
  );
  return {
    ok: true,
    group_id,
    results,
    raisedQuestions: raised,
    currencyOverridden: preps.some((p) => p.currencyOverridden),
    merchant,
  };
}
