import { describe, expect, it } from "vitest";
import { formatAmount, formatFixed, toDecimalTotals } from "./currency.js";

describe("currency helpers", () => {
  it("formats THB amounts with the Thai locale", () => {
    const formatted = formatAmount(1234.5, "THB", "th-TH");
    expect(formatted).toMatch(/1,234\.50/);
    expect(formatted).toMatch(/฿|THB/);
  });

  it("uses each currency's own fraction digits, not a hardcoded two", () => {
    expect(formatAmount(1500, "JPY", "en-US")).not.toMatch(/1,500\.0/);
    expect(formatAmount(1.234, "KWD", "en-US")).toMatch(/1\.234/);
    expect(formatAmount(135, "THB", "en-US")).toMatch(/135\.00/);
  });
});

describe("formatFixed", () => {
  it("gives each currency its own digits", () => {
    expect(formatFixed(135, "THB")).toBe("135.00");
    expect(formatFixed(1500, "JPY")).toBe("1500");
    expect(formatFixed(1.234, "KWD")).toBe("1.234");
  });

  it("carries no symbol and no locale separators, unlike formatAmount", () => {
    expect(formatFixed(1234567.5, "THB")).toBe("1234567.50");
  });
});

describe("toDecimalTotals", () => {
  it("converts each key with its own exponent, and merges none of them", () => {
    expect(toDecimalTotals({ THB: 11213025, JPY: 1500, KWD: 1234 })).toEqual({
      JPY: 1500,
      KWD: 1.234,
      THB: 112130.25,
    });
  });

  it("emits ISO codes in sorted order, so the NDJSON line is stable", () => {
    expect(Object.keys(toDecimalTotals({ USD: 21000, JPY: 1500, THB: 100 }))).toEqual([
      "JPY",
      "THB",
      "USD",
    ]);
  });

  it("keeps a total exact that a decimal accumulation would have drifted", () => {
    // 0.1+0.2+0.3 is 0.6000000000000001 as a double; 10+20+30 satang is exact, converted once at the end.
    expect(toDecimalTotals({ THB: 10 + 20 + 30 })).toEqual({ THB: 0.6 });
  });

  it("has no keys when nothing contributed", () => {
    expect(toDecimalTotals({})).toEqual({});
  });
});
