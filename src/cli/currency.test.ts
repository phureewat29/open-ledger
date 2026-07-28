import { afterEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import {
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
});
