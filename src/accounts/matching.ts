import type Database from "libsql";
import { listAccounts, type AccountRow } from "../db/queries/accounts.js";
import { accountNumberKey, tailAfterMask } from "../lib/masked.js";

export interface FuzzyAccountMatch {
  account: AccountRow;
  similarity: number;
}

// A mask in the text (`470686XXXXXX9483`) is authoritative: its tail wins over the
// longest-digit-run fallback, which would prefer the longer unmasked prefix.
function queryNumberKey(text: string): string {
  const tail = tailAfterMask(text);
  if (tail !== text) return accountNumberKey(tail);

  const runs = text.match(/\d+/g);
  if (!runs) return "";
  const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
  return accountNumberKey(longest);
}

/** Substring hits get a 0.85 floor ("ttb saving" finds "TTB Savings ••1234" despite
 *  mediocre Levenshtein), and a query carrying an account number matches the row's
 *  masked number — callers confirm before acting, so a same-last-4 collision is recoverable. */
export function findAccountsByFuzzyName(
  db: Database.Database,
  query: string,
  threshold = 0.5,
): FuzzyAccountMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qKey = queryNumberKey(q);
  const rows = listAccounts(db);
  const out: FuzzyAccountMatch[] = [];
  for (const row of rows) {
    const name = row.name.toLowerCase();
    let score = similarity(q, name);
    if (name.includes(q) || q.includes(name)) score = Math.max(score, 0.85);
    if (qKey) {
      const rowKey = row.account_number_masked
        ? accountNumberKey(row.account_number_masked)
        : queryNumberKey(name);
      if (rowKey && rowKey === qKey) score = Math.max(score, 0.9);
    }
    if (score >= threshold) {
      out.push({ account: row, similarity: Math.round(score * 1000) / 1000 });
    }
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev: number[] = new Array(n + 1);
  const curr: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}
