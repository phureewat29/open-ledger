import type Database from "libsql";
import {
  ACCOUNT_TYPES,
  countChildAccounts,
  deleteAccount as deleteAccountRow,
  findAccountById,
  insertAccount,
  insertStructuralAccount,
  type AccountType,
  type CreateAccountInput,
} from "../db/queries/accounts.js";
import { accountHasTransactions, repointTransactions } from "../db/queries/transactions.js";
import { repointMerchantDefaultAccount } from "../db/queries/merchants.js";
import { currencyOf, typeFromId } from "../lib/ids.js";

/** The DDL only GLOB-checks the currency head and the type position; this
 *  module owns the rest of the grammar. */
const ACCOUNT_ID_RE = /^[a-z]{3}:[a-z]+(?::[a-z0-9][a-z0-9._-]*)*$/;

const CURRENCY_RE = /^[a-z]{3}$/;

const TYPE_ROOT_NAME: Record<AccountType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  income: "Income",
  expense: "Expenses",
  equity: "Equity",
};

export type StructuralKind = "uncategorized" | "adjustments" | "opening";

/** The accounts the system auto-creates, one set per ledger. */
export const STRUCTURAL_ACCOUNTS: Record<StructuralKind, { type: AccountType; name: string }> = {
  uncategorized: { type: "expense", name: "Uncategorized" },
  adjustments: { type: "equity", name: "Adjustments" },
  opening: { type: "equity", name: "Opening Balance" },
};

/** A bad currency here is a broken invariant, not user input (refused at the
 *  edges); throws instead of writing an id the DDL's CHECK would abort on. */
function ledgerCurrency(currency: string): string {
  const lower = currency.toLowerCase();
  if (!CURRENCY_RE.test(lower)) {
    throw new Error(`Currency "${currency}" must be a 3-letter code (e.g. thb) to name a ledger.`);
  }
  return lower;
}

export function structuralAccountId(currency: string, kind: StructuralKind): string {
  return `${ledgerCurrency(currency)}:${STRUCTURAL_ACCOUNTS[kind].type}:${kind}`;
}

function ledgerRootId(currency: string, type: AccountType): string {
  return `${ledgerCurrency(currency)}:${type}`;
}

/** True for a `<currency>:<type>` id, the only shape allowed a null parent. */
export function isLedgerRootId(id: string): boolean {
  const segments = id.split(":");
  return segments.length === 2 && ACCOUNT_TYPES.includes(segments[1] as AccountType);
}

/** Root and structural names carry the currency, or `thb:asset` and `usd:asset`
 *  both named "Assets" become mutual fuzzy-match lookalikes. */
function ledgerName(name: string, currency: string): string {
  return `${name} (${currency.toUpperCase()})`;
}

export function ensureLedgerRoot(db: Database.Database, currency: string, type: AccountType): void {
  const id = ledgerRootId(currency, type);
  if (findAccountById(db, id)) return;
  insertStructuralAccount(db, {
    id,
    name: ledgerName(TYPE_ROOT_NAME[type], currency),
    type,
    parent_id: null,
  });
}

/** Idempotent; returns the id so callers don't re-derive it. */
export function ensureStructuralAccount(
  db: Database.Database,
  currency: string,
  kind: StructuralKind,
): string {
  const id = structuralAccountId(currency, kind);
  if (findAccountById(db, id)) return id;
  const { type, name } = STRUCTURAL_ACCOUNTS[kind];
  ensureLedgerRoot(db, currency, type);
  insertStructuralAccount(db, {
    id,
    name: ledgerName(name, currency),
    type,
    parent_id: ledgerRootId(currency, type),
  });
  return id;
}

/** Callers branch on these: the CLI maps them to exit codes, and the ancestor
 *  walk singles out `account_exists` to swallow a lost race. */
export type AccountFailure = "account_exists" | "parent_not_found" | "invalid_hierarchy";

export interface AccountRefusal {
  readonly ok: false;
  readonly reason: AccountFailure;
  readonly message: string;
}

export type AccountResult = { readonly ok: true } | AccountRefusal;

const ACCOUNT_OK: AccountResult = { ok: true };

function refuse(reason: AccountFailure, message: string): AccountRefusal {
  return { ok: false, reason, message };
}

/** Grammar only, no database; callable standalone so a caller opening the
 *  ledger before the leaf can refuse a bad id before any write. */
export function validateAccountId(id: string, type: AccountType): AccountResult {
  if (!ACCOUNT_ID_RE.test(id)) {
    return refuse(
      "invalid_hierarchy",
      `Account id "${id}" must be lowercase <currency>:<type>[:<segment>...], e.g. thb:expense:food.`,
    );
  }
  // Caught here so a mismatch is a clean refusal rather than a raw CHECK abort.
  if (typeFromId(id) !== type) {
    return refuse(
      "invalid_hierarchy",
      `Account id "${id}" must carry its type in the second segment: expected "${currencyOf(id).toLowerCase()}:${type}".`,
    );
  }
  return ACCOUNT_OK;
}

/** May open the named parent when it's a ledger root, so callers writing more
 *  than one account wrap the sequence in a transaction. */
function validateAccountHierarchy(
  db: Database.Database,
  input: CreateAccountInput,
  parentId: string | null,
): AccountResult {
  const grammar = validateAccountId(input.id, input.type);
  if (!grammar.ok) return grammar;

  if (parentId === null) {
    if (!isLedgerRootId(input.id)) {
      return refuse(
        "invalid_hierarchy",
        `Account "${input.id}" has no parent_id; only a ledger's type root (<currency>:<type>, e.g. thb:asset) may have a null parent.`,
      );
    }
    return ACCOUNT_OK;
  }

  let parent = findAccountById(db, parentId);
  if (!parent && isLedgerRootId(parentId)) {
    ensureLedgerRoot(db, currencyOf(parentId), typeFromId(parentId) as AccountType);
    parent = findAccountById(db, parentId);
  }
  if (!parent) {
    return refuse("parent_not_found", `Parent account "${parentId}" does not exist; create it first.`);
  }
  if (parent.type !== input.type) {
    return refuse(
      "invalid_hierarchy",
      `Account "${input.id}" type "${input.type}" does not match parent "${parentId}" type "${parent.type}".`,
    );
  }
  // Also the same-ledger check: a child extends its parent's id, prefix included.
  if (!input.id.startsWith(parent.id + ":")) {
    return refuse(
      "invalid_hierarchy",
      `Account id "${input.id}" must start with parent id "${parent.id}:".`,
    );
  }
  return ACCOUNT_OK;
}

export function createAccount(db: Database.Database, input: CreateAccountInput): AccountResult {
  const hierarchy = validateAccountHierarchy(db, input, input.parent_id ?? null);
  if (!hierarchy.ok) return hierarchy;
  if (!insertAccount(db, input).inserted) {
    return refuse("account_exists", `Account "${input.id}" already exists.`);
  }
  return ACCOUNT_OK;
}

interface MergeAccountsResult {
  moved: number;
  // Deleted, not moved: re-pointing would collapse into a self-transaction (debit == credit).
  deletedSelfTransactions: number;
  /** Merchants whose default account followed the survivor. */
  movedMerchantDefaults: number;
}

export function mergeAccounts(
  db: Database.Database,
  fromId: string,
  toId: string,
): MergeAccountsResult {
  if (fromId === toId) throw new Error("Cannot merge an account into itself.");
  const from = findAccountById(db, fromId);
  if (!from) throw new Error(`Source account ${fromId} not found.`);
  const to = findAccountById(db, toId);
  if (!to) throw new Error(`Destination account ${toId} not found.`);
  // The trigger only catches this once a row moves; an account with none
  // would silently merge across ledgers.
  if (currencyOf(fromId) !== currencyOf(toId)) {
    throw new Error(
      `Cannot merge across ledgers: ${fromId} is ${currencyOf(fromId)}, ${toId} is ${currencyOf(toId)}.`,
    );
  }

  const children = countChildAccounts(db, fromId);
  if (children > 0) {
    throw new Error(`Account ${fromId} has ${children} child account(s); merge or delete them first.`);
  }

  // Not one transaction: repointTransactions self-wraps and libsql can't nest
  // transactions. Each step is atomic; a re-run after a crash between steps completes the merge.
  const { moved, deletedSelfTransactions } = repointTransactions(db, fromId, toId);
  // Before the delete: the FK would otherwise null these defaults out.
  const movedMerchantDefaults = repointMerchantDefaultAccount(db, fromId, toId);
  deleteAccountRow(db, fromId);
  return { moved, deletedSelfTransactions, movedMerchantDefaults };
}

export function deleteAccount(db: Database.Database, id: string): void {
  if (accountHasTransactions(db, id)) {
    throw new Error(`Account ${id} still has transactions; merge it first.`);
  }
  const children = countChildAccounts(db, id);
  if (children > 0) {
    throw new Error(`Account ${id} has ${children} child account(s); delete them first.`);
  }
  deleteAccountRow(db, id);
}
