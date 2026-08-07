import type Database from "libsql";
import {
  createAccount,
  ensureLedgerRoot,
  ensureStructuralAccount,
  isLedgerRootId,
  structuralAccountId,
  type AccountRefusal,
} from "./accounts.js";
import {
  ACCOUNT_TYPES,
  findAccountById,
  ledgerExists,
  type AccountType,
} from "../db/queries/accounts.js";
import { merchantExists } from "../db/queries/merchants.js";
import { currencyOf, isLedgerScopedId, typeFromId } from "../lib/ids.js";
import { findAccountsByFuzzyName } from "./matching.js";

export interface ResolvedMerchant {
  readonly merchantId: string | null;
  readonly attemptedUnknownId: string | null;
}

export type AccountHint =
  | { readonly type: "placeholder_created"; readonly accountId: string }
  | { readonly type: "uncategorized_fallback"; readonly accountId: string }
  | { readonly type: "uncategorized_requested"; readonly accountId: string }
  | {
      readonly type: "similar_account";
      readonly accountId: string;
      readonly similarId: string;
    };

/** The ledger's own uncategorized account, and nothing under it. Compared
 *  against the id `ensureStructuralAccount` would build, never re-parsed. */
export function isUncategorizedId(accountId: string): boolean {
  return (
    isLedgerScopedId(accountId) &&
    accountId === structuralAccountId(currencyOf(accountId), "uncategorized")
  );
}

export function resolveMerchantId(
  db: Database.Database,
  merchantId: string | null | undefined,
): ResolvedMerchant {
  if (!merchantId) return { merchantId: null, attemptedUnknownId: null };
  if (merchantExists(db, merchantId)) return { merchantId, attemptedUnknownId: null };
  return { merchantId: null, attemptedUnknownId: merchantId };
}

export interface PostingResolution {
  /** Null when no path could be built; caller supplies the fallback ledger. */
  readonly accountId: string | null;
  readonly hint: AccountHint | null;
}

/** A lookalike is reported, never used: the requested id is still created. */
export function resolveOnePosting(
  db: Database.Database,
  accountId: string,
): PostingResolution {
  if (findAccountById(db, accountId)) return { accountId, hint: null };

  const similarId = bestFuzzyMatch(db, accountId);
  if (!ensurePlaceholderAccount(db, accountId)) return { accountId: null, hint: null };
  return {
    accountId,
    hint: similarId
      ? { type: "similar_account", accountId, similarId }
      : { type: "placeholder_created", accountId },
  };
}

/** `<currency>:expense:uncategorized` for a ledger that already exists. */
export function ensureUncategorizedFallback(db: Database.Database, currency: string): string {
  return ensureStructuralAccount(db, currency, "uncategorized");
}

const CURRENCY_HEAD_RE = /^[A-Za-z]{3}:/;

/** The currency head alone decides: booking elsewhere would relabel the
 *  amount at the wrong exponent. */
export function namesUnopenedLedger(db: Database.Database, accountId: string): boolean {
  if (!CURRENCY_HEAD_RE.test(accountId)) return false;
  return !ledgerExists(db, currencyOf(accountId));
}

// Stricter than MATCH_THRESHOLD (accounts/matching.ts): hints are unprompted,
// so precision wins over recall. Tune the two together.
const FUZZY_THRESHOLD = 0.7;

/**
 * Closest existing account to a requested id, or null; advisory only.
 * Excludes cross-ledger and same-lineage matches.
 */
function bestFuzzyMatch(db: Database.Database, accountId: string): string | null {
  const type = typeFromId(accountId) as AccountType;
  if (!ACCOUNT_TYPES.includes(type)) return null;
  const currency = currencyOf(accountId);
  const leaf = leafSegment(accountId).replace(/[-_]+/g, " ");
  if (!leaf) return null;
  const matches = findAccountsByFuzzyName(db, leaf, FUZZY_THRESHOLD, { type, ledger: currency });
  const candidate = matches.find((m) => !sharesLineage(m.account.id, accountId));
  return candidate?.account.id ?? null;
}

function sharesLineage(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
}

function leafSegment(id: string): string {
  const segments = id.split(":");
  return segments[segments.length - 1] ?? id;
}

type WalkResult = { readonly ok: true; readonly created: string[] } | AccountRefusal;

/** `upTo` is 1-based. */
function walkAncestorChain(
  db: Database.Database,
  segments: string[],
  type: AccountType,
  upTo: number,
): WalkResult {
  const currency = segments[0];
  const rootId = `${currency}:${type}`;
  const created: string[] = [];
  if (!findAccountById(db, rootId)) created.push(rootId);
  ensureLedgerRoot(db, currency, type);
  // Segment 3 onward: the ledger root already covers the first two.
  for (let i = 3; i <= upTo; i++) {
    const id = segments.slice(0, i).join(":");
    if (findAccountById(db, id)) continue;
    const parentId = segments.slice(0, i - 1).join(":");
    const name = humanizeSegment(segments[i - 1]);
    const result = createAccount(db, { id, name, type, parent_id: parentId });
    if (result.ok) {
      created.push(id);
      continue;
    }
    // A concurrent writer claimed the id first: its row stands, the walk goes on.
    if (result.reason !== "account_exists") return result;
  }
  return { ok: true, created };
}

/**
 * False on a malformed id, unknown type, or unopened ledger; `--resolve`
 * depends on that contract. A database failure propagates instead.
 */
function ensurePlaceholderAccount(db: Database.Database, accountId: string): boolean {
  const segments = accountId.split(":").filter(Boolean);
  if (segments.length < 2) return false;

  const type = segments[1] as AccountType;
  if (!ACCOUNT_TYPES.includes(type)) return false;
  if (!ledgerExists(db, segments[0])) return false;

  return walkAncestorChain(db, segments, type, segments.length).ok;
}

interface AncestorsReady {
  readonly ok: true;
  /** Parent id for the leaf, or null for a ledger type root. */
  readonly parentId: string | null;
  /** Ancestor ids created as a side effect, root-to-leaf order. */
  readonly createdParents: string[];
}

/**
 * Unlike `ensurePlaceholderAccount`, returns the refusal instead of
 * swallowing it, and may open a new ledger.
 */
export function ensureAccountAncestors(
  db: Database.Database,
  id: string,
  type: AccountType,
): AncestorsReady | AccountRefusal {
  const segments = id.split(":").filter(Boolean);
  if (segments.length < 2 || isLedgerRootId(id)) {
    return { ok: true, parentId: null, createdParents: [] };
  }

  const walked = walkAncestorChain(db, segments, type, segments.length - 1);
  if (!walked.ok) return walked;
  return {
    ok: true,
    parentId: segments.slice(0, segments.length - 1).join(":"),
    createdParents: walked.created,
  };
}

export function humanizeSegment(segment: string): string {
  const spaced = segment.replace(/[-_]+/g, " ").trim();
  if (!spaced) return "Placeholder";
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}
