/**
 * Amounts are integers in the currency's smallest unit (THB satang, JPY none,
 * KWD three) to avoid float drift; decimal conversion happens only at the
 * CLI/pipeline boundary.
 */

const exponentCache = new Map<string, number>();

/** Resolved via Intl and memoized; falls back to 2 on an unresolvable (or empty/garbage) code. */
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

/**
 * Moves the decimal point in the literal instead of multiplying the double:
 * `1.005 * 100` is 100.49999999999999, while re-parsing "1.005e2" is exactly
 * 100.5. Exact only while the shifted value stays below 2^51 (above that the
 * re-parse itself rounds) — unreachable through the CLI, since the schema caps
 * stored amounts at 2^53-1 minor units.
 */
function shiftPoint(value: number, places: number): number {
  const [mantissa, exponent = "0"] = String(value).split("e");
  return Number(`${mantissa}e${Number(exponent) + places}`);
}

/**
 * Rounds half away from zero (Math.round ties toward +Infinity: 100.5->101 but
 * -100.5->-100). Signed input is real: `adjustAccountBalance` converts a signed target balance.
 */
export function toMinorUnits(decimal: number, currency: string): number {
  const shifted = shiftPoint(decimal, minorUnitExponent(currency));
  return Math.sign(shifted) * Math.round(Math.abs(shifted));
}

export function fromMinorUnits(minor: number, currency: string): number {
  return minor / 10 ** minorUnitExponent(currency);
}
