import type Database from "libsql";

export interface DuplicateTransactionRow {
  id: string;
  group_id: string | null;
  date: string;
  description: string;
  amount: number;
  currency: string;
  source_file_id: string | null;
  merchant_id: string | null;
  debit_account_id: string;
  credit_account_id: string;
  debit_account_name: string | null;
  credit_account_name: string | null;
}

interface FindDuplicateTransactionsOptions {
  /** Day slack when grouping by date. 0 = same-day only. Default 2. */
  toleranceDays?: number;
  /** Skip transactions below this amount (minor units). */
  minAmount?: number;
}

/**
 * Rows sharing a non-null group_id never match each other (a salary's legs aren't
 * duplicates); returns components of size >= 2.
 */
export function findDuplicateTransactions(
  db: Database.Database,
  opts: FindDuplicateTransactionsOptions = {},
): DuplicateTransactionRow[][] {
  const toleranceDays = Math.max(0, Math.floor(opts.toleranceDays ?? 2));
  const minAmount = opts.minAmount ?? 0;

  const rows = db
    .prepare(
      `SELECT t.id, t.group_id, t.date, t.description, t.amount, t.currency,
              t.source_file_id, t.merchant_id, t.debit_account_id, t.credit_account_id,
              da.name AS debit_account_name, ca.name AS credit_account_name
         FROM transactions t
         LEFT JOIN accounts da ON da.id = t.debit_account_id
         LEFT JOIN accounts ca ON ca.id = t.credit_account_id
        WHERE t.void_of IS NULL`,
    )
    .all() as DuplicateTransactionRow[];

  const buckets = new Map<string, DuplicateTransactionRow[]>();
  for (const r of rows) {
    if (r.amount < minAmount) continue;
    const key = `${r.amount}|${r.debit_account_id}|${r.credit_account_id}`;
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }

  const groups: DuplicateTransactionRow[][] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (const comp of proximityComponents(bucket, toleranceDays)) {
      if (comp.length >= 2) groups.push(comp);
    }
  }
  return groups;
}

function proximityComponents(
  bucket: DuplicateTransactionRow[],
  toleranceDays: number,
): DuplicateTransactionRow[][] {
  const n = bucket.length;
  const parent = Array.from({ length: n }, (_, i) => i);
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

  const comps = new Map<number, DuplicateTransactionRow[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const arr = comps.get(root) ?? [];
    arr.push(bucket[i]);
    comps.set(root, arr);
  }
  return [...comps.values()];
}

/** Whole-day distance between two ISO dates; +Infinity on unparseable input. */
function dayDiff(a: string, b: string): number {
  const aDate = Date.parse(a);
  const bDate = Date.parse(b);
  if (Number.isNaN(aDate) || Number.isNaN(bDate)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((bDate - aDate) / 86_400_000));
}
