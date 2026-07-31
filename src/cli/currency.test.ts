import { afterEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import {
  formatAmount,
  formatCurrencyAmount,
  formatFixed,
  getDisplayCurrency,
  getDisplayLocale,
  toDecimalTotals,
} from "./currency.js";

const ORIGINAL_LOCALE = config.displayLocale;
const ORIGINAL_CURRENCY = config.displayCurrency;

describe("currency helpers", () => {
  afterEach(() => {
    config.displayLocale = ORIGINAL_LOCALE;
    config.displayCurrency = ORIGINAL_CURRENCY;
  });

  it("defaults to Thai locale and THB", () => {
    // buildConfig() guarantees non-empty values, so these helpers just trust config.
    expect(getDisplayLocale()).toBe("th-TH");
    expect(getDisplayCurrency()).toBe("THB");
  });

  it("respects explicit overrides", () => {
    config.displayLocale = "en-US";
    config.displayCurrency = "USD";
    expect(getDisplayLocale()).toBe("en-US");
    expect(getDisplayCurrency()).toBe("USD");
  });

  it("formats THB amounts with the Thai locale", () => {
    config.displayLocale = "th-TH";
    config.displayCurrency = "THB";
    const formatted = formatCurrencyAmount(1234.5, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(formatted).toMatch(/1,234\.50/);
    expect(formatted).toMatch(/฿|THB/);
  });

  it("keeps the sign: negative amounts render negative", () => {
    config.displayLocale = "th-TH";
    config.displayCurrency = "THB";
    expect(formatAmount(-150)).toMatch(/-[^\d]*150/);
  });

  it("uses each currency's own fraction digits, not a hardcoded two", () => {
    config.displayLocale = "en-US";
    expect(formatAmount(1500, "JPY")).not.toMatch(/1,500\.0/);
    expect(formatAmount(1.234, "KWD")).toMatch(/1\.234/);
    expect(formatAmount(135, "THB")).toMatch(/135\.00/);
  });
});

describe("formatFixed", () => {
  it("gives each currency its own digits", () => {
    expect(formatFixed(135, "THB")).toBe("135.00");
    expect(formatFixed(1500, "JPY")).toBe("1500");
    expect(formatFixed(1.234, "KWD")).toBe("1.234");
  });

  it("carries no symbol and no locale separators, unlike formatAmount", () => {
    config.displayLocale = "th-TH";
    config.displayCurrency = "THB";
    expect(formatFixed(1234567.5, "THB")).toBe("1234567.50");
  });

  it("keeps the sign", () => {
    expect(formatFixed(-150, "THB")).toBe("-150.00");
  });

  it("ignores the display currency: the row's own code decides", () => {
    config.displayCurrency = "THB";
    expect(formatFixed(1500, "JPY")).toBe("1500");
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
