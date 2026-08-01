import { groupBy, range } from "es-toolkit";
import type { DuplicateTransactionRow } from "../db/queries/transactions.js";

/** Groups by same amount and account pair; a bucket of size 1 can't duplicate anything. */
export function bucketDuplicateCandidates(
  rows: DuplicateTransactionRow[],
): DuplicateTransactionRow[][] {
  const buckets = groupBy(rows, (r) => `${r.amount}|${r.debit_account_id}|${r.credit_account_id}`);
  return Object.values(buckets);
}

/** Two rows join a component when within `toleranceDays` and not already
 *  sharing a group_id. Components chain transitively. */
export function proximityComponents(
  bucket: DuplicateTransactionRow[],
  toleranceDays: number,
): DuplicateTransactionRow[][] {
  const n = bucket.length;
  const parent = range(n);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = bucket[i];
      const b = bucket[j];
      if (dayDiff(a.date, b.date) > toleranceDays) continue;
      if (a.group_id && b.group_id && a.group_id === b.group_id) continue;
      union(i, j);
    }
  }

  // Not groupBy: a Record hoists the numeric root keys into ascending order,
  // while cluster order on the wire must follow first appearance.
  const comps = new Map<number, DuplicateTransactionRow[]>();
  bucket.forEach((row, i) => {
    const root = find(i);
    const rows = comps.get(root) ?? [];
    rows.push(row);
    comps.set(root, rows);
  });
  return [...comps.values()];
}

/** Whole-day distance between two ISO dates; +Infinity on unparseable input. */
export function dayDiff(a: string, b: string): number {
  const aDate = Date.parse(a);
  const bDate = Date.parse(b);
  if (Number.isNaN(aDate) || Number.isNaN(bDate)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((bDate - aDate) / 86_400_000));
}

/** Keeps only components of size >= 2; a lone candidate isn't a duplicate. */
export function clusterDuplicateCandidates(
  rows: DuplicateTransactionRow[],
  toleranceDays: number,
): DuplicateTransactionRow[][] {
  const groups: DuplicateTransactionRow[][] = [];
  for (const bucket of bucketDuplicateCandidates(rows)) {
    if (bucket.length < 2) continue;
    for (const comp of proximityComponents(bucket, toleranceDays)) {
      if (comp.length >= 2) groups.push(comp);
    }
  }
  return groups;
}
