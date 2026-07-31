import assert from "node:assert/strict";
import { test } from "node:test";
import { tallyMoney } from "./ledger.js";

function row(debit: string, credit: string, amount: number) {
  return { debit_account_id: debit, credit_account_id: credit, amount };
}

const CHARGE = row("thb:expense:food", "thb:liability:card:ktc", 250.5);
const REFUND = row("thb:liability:card:ktc", "thb:expense:food", 50.25);
const PAYMENT = row("thb:liability:card:ktc", "thb:asset:bank:kbank", 1000);

test("groups by direction and totals one ledger exactly", () => {
  const money = tallyMoney([CHARGE, CHARGE, REFUND, PAYMENT]);
  assert.deepEqual(money, {
    charges: { count: 2, total: 501 },
    refunds: { count: 1, total: 50.25 },
    payments: { count: 1, total: 1000 },
  });
});

test("ignores a row that belongs to no group", () => {
  const opening = row("thb:asset:bank:kbank", "thb:equity:openingbalance", 5000);
  assert.deepEqual(tallyMoney([CHARGE, opening]).charges, { count: 1, total: 250.5 });
});

test("reports no total once a second ledger is in the tally, and keeps the counts", () => {
  const yenCharge = row("jpy:expense:food", "jpy:liability:card:jcb", 1500);
  const money = tallyMoney([CHARGE, yenCharge, PAYMENT]);
  // 250.50 baht + 1500 yen is not 1750.50 of anything.
  assert.deepEqual(money.charges, { count: 2, total: 0 });
  assert.deepEqual(money.payments, { count: 1, total: 0 });
});
