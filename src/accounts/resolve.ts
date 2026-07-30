import type Database from "libsql";
import {
  createAccount,
  ensureStructuralAccount,
  ensureTopLevelRoot,
} from "./accounts.js";
import {
  findAccountById,
  TOP_LEVEL_TYPES,
  type AccountType,
} from "../db/queries/accounts.js";
import { merchantExists } from "../db/queries/merchants.js";
import { findAccountsByFuzzyName } from "./matching.js";

export interface ResolvedMerchant {
  readonly merchantId: string | null;
  readonly attemptedUnknownId: string | null;
}

export type AccountHint =
  | { readonly type: "placeholder_created"; readonly accountId: string }
  | { readonly type: "uncategorized_fallback"; readonly accountId: string }
  /** The account was created as asked and an existing lookalike was found. */
  | {
      readonly type: "similar_account";
      readonly accountId: string;
      readonly similarId: string;
    };

/**
 * A merchant id that doesn't exist is recorded as attempted-unknown, so the
 * caller can raise a question.
 */
export function resolveMerchantId(
  db: Database.Database,
  merchantId: string | null | undefined,
): ResolvedMerchant {
  if (!merchantId) return { merchantId: null, attemptedUnknownId: null };
  if (merchantExists(db, merchantId)) return { merchantId, attemptedUnknownId: null };
  return { merchantId: null, attemptedUnknownId: merchantId };
}

/**
 * `hint` is null on an exact match. A lookalike never moves the posting: the
 * requested id is created and the lookalike reported as `similar_account`, so
 * money can only land on the account the input actually named.
 */
export function resolveOnePosting<T extends { account_id: string }>(
  db: Database.Database,
  posting: T,
): { posting: T; hint: AccountHint | null } {
  if (findAccountById(db, posting.account_id)) {
    return { posting, hint: null };
  }
  const similarId = bestFuzzyMatch(db, posting.account_id);
  const placeholder = ensurePlaceholderAccount(db, posting.account_id);
  return {
    posting: { ...posting, account_id: placeholder.accountId },
    hint: accountHint(placeholder, similarId),
  };
}

/** One hint per side. A fallback outranks a lookalike: the money really did land
 *  on `expense:uncategorized`, so recategorizing it is the caller's next move. */
function accountHint(placeholder: PlaceholderResult, similarId: string | null): AccountHint {
  if (placeholder.fellBack) {
    return { type: "uncategorized_fallback", accountId: placeholder.accountId };
  }
  if (similarId) {
    return { type: "similar_account", accountId: placeholder.accountId, similarId };
  }
  return { type: "placeholder_created", accountId: placeholder.accountId };
}

const FUZZY_THRESHOLD = 0.7;

/**
 * The closest existing account to a requested id, or null: advisory only, it
 * never changes where money posts. A child account shares its parent's type
 * and extends its id, so a candidate of another type or one on the same
 * lineage is parentage, not a lookalike. The leaf of `asset:bank:kbank`
 * contains its own parent's name "Bank", and `income:transfers:p2p` has an
 * exact-name expense twin across roots; neither is worth a question.
 */
function bestFuzzyMatch(db: Database.Database, accountId: string): string | null {
  const type = accountId.split(":")[0] as AccountType;
  if (!TOP_LEVEL_TYPES.includes(type)) return null;
  const leaf = leafSegment(accountId).replace(/[-_]+/g, " ");
  if (!leaf) return null;
  const matches = findAccountsByFuzzyName(db, leaf, FUZZY_THRESHOLD);
  const candidate = matches.find(
    (m) => m.account.type === type && !sharesLineage(m.account.id, accountId),
  );
  return candidate?.account.id ?? null;
}

/** The same account, or one of the two an ancestor of the other. */
function sharesLineage(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
}

function leafSegment(id: string): string {
  const segments = id.split(":");
  return segments[segments.length - 1] ?? id;
}

// `upTo` is 1-based. `ACCOUNT_EXISTS` races are swallowed as a no-op; every other error propagates.
function walkAncestorChain(
  db: Database.Database,
  segments: string[],
  type: AccountType,
  upTo: number,
): string[] {
  const created: string[] = [];
  if (!findAccountById(db, type)) created.push(type);
  ensureTopLevelRoot(db, type);
  for (let i = 2; i <= upTo; i++) {
    const id = segments.slice(0, i).join(":");
    if (findAccountById(db, id)) continue;
    const parentId = segments.slice(0, i - 1).join(":");
    const name = humanizeSegment(segments[i - 1]);
    try {
      createAccount(db, { id, name, type, parent_id: parentId });
      created.push(id);
    } catch (err: any) {
      if (err?.code === "ACCOUNT_EXISTS") continue;
      throw err;
    }
  }
  return created;
}

interface PlaceholderResult {
  /** The resolved account id: the requested path when it was created, else
   *  `expense:uncategorized`. */
  accountId: string;
  /** True when the path couldn't be built (bad id, unknown type, or a
   *  hierarchy error) and resolution fell back to `expense:uncategorized`.
   *  The commit pipeline turns a fallback into a question. */
  fellBack: boolean;
}

// Never surfaces an error: always returns a usable id, falling back to `expense:uncategorized`.
function ensurePlaceholderAccount(db: Database.Database, accountId: string): PlaceholderResult {
  const segments = accountId.split(":").filter(Boolean);
  if (segments.length < 2) return { accountId: ensureUncategorizedFallback(db), fellBack: true };

  const type = segments[0] as AccountType;
  if (!TOP_LEVEL_TYPES.includes(type)) return { accountId: ensureUncategorizedFallback(db), fellBack: true };

  // Any hierarchy failure here degrades to the fallback silently; `--resolve` depends on that.
  try {
    walkAncestorChain(db, segments, type, segments.length);
  } catch {
    return { accountId: ensureUncategorizedFallback(db), fellBack: true };
  }
  return { accountId, fellBack: false };
}

interface EnsureAccountAncestorsResult {
  /** The immediate parent id the leaf should be created under, or null for a
   *  single-segment id (a bare top-level root, nothing to auto-create). */
  parentId: string | null;
  /** Ancestor ids created as a side effect, root-to-leaf order; empty when
   *  every ancestor along the chain already existed. */
  createdParents: string[];
}

/**
 * Creates any missing ancestor above the leaf for a multi-segment id (e.g.
 * `asset:bank:ttb`), so `accounts create` doesn't need every intermediate
 * category pre-created. Unlike `ensurePlaceholderAccount`, propagates
 * hierarchy errors as-is so the CLI can surface a real INVALID.
 */
export function ensureAccountAncestors(
  db: Database.Database,
  id: string,
  type: AccountType,
): EnsureAccountAncestorsResult {
  const segments = id.split(":").filter(Boolean);
  if (segments.length < 2) return { parentId: null, createdParents: [] };

  const createdParents = walkAncestorChain(db, segments, type, segments.length - 1);
  const parentId = segments.slice(0, segments.length - 1).join(":");
  return { parentId, createdParents };
}

function ensureUncategorizedFallback(db: Database.Database): string {
  ensureStructuralAccount(db, "expense:uncategorized");
  return "expense:uncategorized";
}

function humanizeSegment(segment: string): string {
  const spaced = segment.replace(/[-_]+/g, " ").trim();
  if (!spaced) return "Placeholder";
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}
