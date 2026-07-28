/**
 * `transactions` stores amounts as integers in the currency's smallest unit
 * (THB satang, JPY has none, KWD has three) to avoid float drift. Decimal
 * conversion happens only at the CLI/pipeline boundary.
 */

const exponentCache = new Map<string, number>();

/**
 * Resolved via Intl and memoized. Falls back to 2 on an unresolvable code,
 * including empty/garbage input - which Intl rejects too.
 */
export function minorUnitExponent(currency: string): number {
  const code = currency.toUpperCase();
  const cached = exponentCache.get(code);
  if (cached !== undefined) return cached;

  let exp = 2;
  try {
    const resolved = new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
    }).resolvedOptions();
    exp = resolved.maximumFractionDigits ?? 2;
  } catch {
    exp = 2;
  }
  exponentCache.set(code, exp);
  return exp;
}

export function toMinorUnits(decimal: number, currency: string): number {
  return Math.round(decimal * 10 ** minorUnitExponent(currency));
}

export function fromMinorUnits(minor: number, currency: string): number {
  return minor / 10 ** minorUnitExponent(currency);
}
