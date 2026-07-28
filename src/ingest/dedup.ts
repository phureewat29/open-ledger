import type Database from "libsql";
import { deleteTransaction } from "../db/queries/transactions.js";
import {
  findDuplicateTransactions,
  type DuplicateTransactionRow,
} from "../db/queries/transactions-dedup.js";

/**
 * Within each group, keeps the earliest transaction and deletes exact
 * matches on merchant, file, date, and amount (integer minor units, no
 * rounding needed). The group finder already excludes linked legs.
 */
export function autoMergeStrictDuplicateTransactions(db: Database.Database): { merged: number } {
  let merged = 0;
  for (const group of findDuplicateTransactions(db)) {
    merged += autoMergeStrictGroup(db, group);
  }
  return { merged };
}

function autoMergeStrictGroup(db: Database.Database, group: DuplicateTransactionRow[]): number {
  const sorted = [...group].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  const head = sorted[0];
  if (!head.merchant_id || !head.source_file_id) return 0;

  let deleted = 0;
  for (let i = 1; i < sorted.length; i++) {
    const cand = sorted[i];
    if (
      cand.merchant_id === head.merchant_id &&
      cand.source_file_id === head.source_file_id &&
      cand.date === head.date &&
      cand.amount === head.amount
    ) {
      deleteTransaction(db, cand.id);
      deleted++;
    }
  }
  return deleted;
}
