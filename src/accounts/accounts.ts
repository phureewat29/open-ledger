import type Database from "libsql";
import {
  countChildAccounts,
  deleteAccount as deleteAccountRow,
  findAccountById,
  insertAccount,
  insertStructuralAccount,
  TOP_LEVEL_TYPES,
  type AccountType,
  type CreateAccountInput,
} from "../db/queries/accounts.js";
import { accountHasTransactions, repointTransactions } from "../db/queries/transactions.js";

const TYPE_ROOT_NAME: Record<AccountType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  income: "Income",
  expense: "Expenses",
  equity: "Equity",
};

export function ensureTopLevelRoot(db: Database.Database, type: AccountType): void {
  if (findAccountById(db, type)) return;
  insertStructuralAccount(db, {
    id: type,
    name: TYPE_ROOT_NAME[type],
    type,
    parent_id: null,
  });
}

/**
 * Idempotently insert one of the structural accounts the system auto-creates:
 *  - `expense:uncategorized`  (suspense for unclassifiable expense entries)
 *  - `equity:adjustments`     (balancing side of `adjust_account_balance`)
 *  - `equity:opening-balance` (starting state imports)
 * The top-level root is bootstrapped first when missing.
 */
export function ensureStructuralAccount(
  db: Database.Database,
  id: "expense:uncategorized" | "equity:adjustments" | "equity:opening-balance",
): void {
  if (findAccountById(db, id)) return;
  const [type, leaf] = id.split(":") as [AccountType, string];
  ensureTopLevelRoot(db, type);
  const name = leaf === "uncategorized" ? "Uncategorized"
    : leaf === "adjustments" ? "Adjustments"
    : "Opening Balance";
  insertStructuralAccount(db, { id, name, type, parent_id: type });
}

// Throws on any violation; the caller does the INSERT.
function validateAccountHierarchy(
  db: Database.Database,
  input: CreateAccountInput,
  parentId: string | null,
): void {
  if (parentId === null) {
    if (!TOP_LEVEL_TYPES.includes(input.id as AccountType)) {
      throw new Error(
        `Account "${input.id}" has no parent_id; only top-level type roots may have a null parent (one of ${TOP_LEVEL_TYPES.join(", ")}).`,
      );
    }
    if (input.id !== input.type) {
      throw new Error(`Top-level root id "${input.id}" must equal its type "${input.type}".`);
    }
    return;
  }

  let parent = findAccountById(db, parentId);
  if (!parent && TOP_LEVEL_TYPES.includes(parentId as AccountType)) {
    ensureTopLevelRoot(db, parentId as AccountType);
    parent = findAccountById(db, parentId);
  }
  if (!parent) {
    throw new Error(`Parent account "${parentId}" does not exist; create it first.`);
  }
  if (parent.type !== input.type) {
    throw new Error(
      `Account "${input.id}" type "${input.type}" does not match parent "${parentId}" type "${parent.type}".`,
    );
  }
  if (!input.id.startsWith(parent.id + ":")) {
    throw new Error(`Account id "${input.id}" must start with parent id "${parent.id}:".`);
  }
}

/** A duplicate id surfaces as an Error with code 'ACCOUNT_EXISTS'. */
export function createAccount(db: Database.Database, input: CreateAccountInput): void {
  validateAccountHierarchy(db, input, input.parent_id ?? null);
  insertAccount(db, input);
}

interface MergeAccountsResult {
  moved: number;
  // Deleted, not moved, because re-pointing would collapse them into a
  // degenerate self-transaction (debit == credit).
  deletedSelfTransactions: number;
}

/**
 * Re-points every leg on `fromId` to `toId`, then deletes the source account.
 * Refuses if the source account still has children.
 */
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

  const children = countChildAccounts(db, fromId);
  if (children > 0) {
    throw new Error(`Account ${fromId} has ${children} child account(s); merge or delete them first.`);
  }

  const { moved, deletedSelfTransactions } = repointTransactions(db, fromId, toId);
  deleteAccountRow(db, fromId);
  return { moved, deletedSelfTransactions };
}

/** Delete an account only if no transactions reference it AND it has no children. */
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
