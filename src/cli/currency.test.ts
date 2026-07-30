import { afterEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import {
  formatAmount,
  formatCurrencyAmount,
  getDisplayCurrency,
  getDisplayLocale,
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
