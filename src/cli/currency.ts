import { config } from "../config.js";

/**
 * buildConfig() resolves these with `||` over its own non-empty defaults, so
 * config.displayLocale/displayCurrency are never empty; last-resort constants live in config.ts.
 */
export function getDisplayLocale(): string {
  return config.displayLocale;
}

export function getDisplayCurrency(): string {
  return config.displayCurrency;
}

/**
 * Signed, with each currency's own fraction digits (Intl knows the exponents:
 * THB 2, JPY 0, KWD 3). Callers may still pin digits explicitly.
 */
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
