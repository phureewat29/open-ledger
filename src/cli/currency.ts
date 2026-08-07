import { fromMinorUnits, minorUnitExponent } from "../lib/money.js";
import type { CurrencyTotals } from "../accounts/balances.js";

// Each currency's own fraction digits (Intl knows the exponents: THB 2, JPY 0, KWD 3).
export function formatAmount(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
}

// No symbol or locale separators, so a column of amounts stays machine-sliceable.
export function formatFixed(amount: number, currency: string): string {
  return amount.toFixed(minorUnitExponent(currency));
}

// Keys sorted so the emitted object's key order is stable across runs; each converts with its own exponent.
export function toDecimalTotals(totals: CurrencyTotals): Record<string, number> {
  const out: Record<string, number> = {};
  for (const currency of Object.keys(totals).sort()) {
    out[currency] = fromMinorUnits(totals[currency], currency);
  }
  return out;
}
