import { config } from "../config.js";
import { fromMinorUnits, minorUnitExponent } from "../lib/money.js";
import type { CurrencyTotals } from "../accounts/balances.js";

// config.displayLocale/displayCurrency are never empty; buildConfig() falls back to its own defaults.
export function getDisplayLocale(): string {
  return config.displayLocale;
}

export function getDisplayCurrency(): string {
  return config.displayCurrency;
}

// Each currency's own fraction digits (Intl knows the exponents: THB 2, JPY 0, KWD 3);
// callers may still pin digits explicitly.
export function formatCurrencyAmount(
  amount: number,
  options: {
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
    currency?: string;
  } = {},
): string {
  const locale = getDisplayLocale();
  const currency = options.currency || getDisplayCurrency();

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: options.minimumFractionDigits,
    maximumFractionDigits: options.maximumFractionDigits,
  }).format(amount);
}

export function formatAmount(amount: number, currency?: string): string {
  return formatCurrencyAmount(amount, { currency });
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
