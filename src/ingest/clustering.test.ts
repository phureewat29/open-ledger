import { describe, it, expect } from "vitest";
import type { DuplicateTransactionRow } from "../db/queries/transactions.js";
import {
  bucketDuplicateCandidates,
  proximityComponents,
  clusterDuplicateCandidates,
  dayDiff,
} from "./clustering.js";

function row(over: Partial<DuplicateTransactionRow> & { id: string }): DuplicateTransactionRow {
  return {
    group_id: null,
    date: "2026-05-01",
    description: "Coffee",
    amount: 15000,
    currency: "THB",
    source_file_id: null,
    merchant_id: null,
    debit_account_id: "thb:expense:food",
    credit_account_id: "thb:asset:cash",
    debit_account_name: null,
    credit_account_name: null,
    ...over,
  };
}

describe("dayDiff", () => {
  it("is whole days regardless of direction", () => {
    expect(dayDiff("2026-05-01", "2026-05-03")).toBe(2);
    expect(dayDiff("2026-05-03", "2026-05-01")).toBe(2);
  });

  it("is +Infinity on an unparseable date", () => {
    expect(dayDiff("not-a-date", "2026-05-01")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("proximityComponents ordering", () => {
  it("returns components in first-appearance order, not union-root order", () => {
    // Row 0 unions with the last row, pushing its root to a high index while
    // the singletons keep low roots; first appearance must still come first.
    const twinA = row({ id: "tx:first", date: "2026-05-01" });
    const singles = ["2026-05-11", "2026-05-21", "2026-06-01", "2026-06-11"].map((date, i) =>
      row({ id: `tx:s${i}`, date }),
    );
    const twinB = row({ id: "tx:last", date: "2026-05-01" });

    const comps = proximityComponents([twinA, ...singles, twinB], 2);
    expect(comps).toHaveLength(5);
    expect(comps[0].map((r) => r.id)).toEqual(["tx:first", "tx:last"]);
  });
});

describe("bucketDuplicateCandidates", () => {
  it("groups only rows sharing amount, debit, and credit", () => {
    const a = row({ id: "tx:a", amount: 5000 });
    const b = row({ id: "tx:b", amount: 5000 });
    const differentAmount = row({ id: "tx:c", amount: 7000 });
    const differentAccounts = row({ id: "tx:d", amount: 5000, credit_account_id: "thb:asset:bank" });

    const buckets = bucketDuplicateCandidates([a, b, differentAmount, differentAccounts]);
    expect(buckets).toHaveLength(3);
    const withTwo = buckets.find((bucket) => bucket.length === 2);
    expect(withTwo?.map((r) => r.id).sort()).toEqual(["tx:a", "tx:b"]);
  });

  it("returns an empty bucket set for no rows", () => {
    expect(bucketDuplicateCandidates([])).toEqual([]);
  });
});

describe("proximityComponents", () => {
  it("keeps rows separate outside the tolerance window", () => {
    const a = row({ id: "tx:a", date: "2026-05-01" });
    const b = row({ id: "tx:b", date: "2026-05-05" });
    const components = proximityComponents([a, b], 2);
    expect(components).toHaveLength(2);
  });

  it("unions rows within the tolerance window", () => {
    const a = row({ id: "tx:a", date: "2026-05-01" });
    const b = row({ id: "tx:b", date: "2026-05-02" });
    const components = proximityComponents([a, b], 2);
    expect(components).toHaveLength(1);
    expect(components[0].map((r) => r.id).sort()).toEqual(["tx:a", "tx:b"]);
  });

  it("chains transitively: A~B, B~C puts all three in one component even though A!~C", () => {
    const a = row({ id: "tx:a", date: "2026-05-01" });
    const b = row({ id: "tx:b", date: "2026-05-03" });
    const c = row({ id: "tx:c", date: "2026-05-05" });
    // dayDiff(a,c) = 4, outside toleranceDays=2, so only the a-b and b-c edges union directly.
    expect(dayDiff(a.date, c.date)).toBeGreaterThan(2);

    const components = proximityComponents([a, b, c], 2);
    expect(components).toHaveLength(1);
    expect(components[0].map((r) => r.id).sort()).toEqual(["tx:a", "tx:b", "tx:c"]);
  });

  it("never unions rows sharing a non-null group_id", () => {
    const a = row({ id: "tx:a", date: "2026-05-01", group_id: "tg:1" });
    const b = row({ id: "tx:b", date: "2026-05-01", group_id: "tg:1" });
    const components = proximityComponents([a, b], 2);
    expect(components).toHaveLength(2);
  });
});

describe("clusterDuplicateCandidates", () => {
  it("drops components of size 1", () => {
    const a = row({ id: "tx:a", amount: 5000 });
    expect(clusterDuplicateCandidates([a], 2)).toEqual([]);
  });

  it("composes bucketing and proximity clustering into >=2 groups", () => {
    const a = row({ id: "tx:a", amount: 7000, date: "2026-05-01" });
    const b = row({ id: "tx:b", amount: 7000, date: "2026-05-02" });
    const lone = row({ id: "tx:c", amount: 9000, date: "2026-05-01" });

    const groups = clusterDuplicateCandidates([a, b, lone], 2);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id).sort()).toEqual(["tx:a", "tx:b"]);
  });
});
