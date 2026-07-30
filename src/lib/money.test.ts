import { describe, expect, it } from "vitest";
import { minorUnitExponent, toMinorUnits, fromMinorUnits } from "./money.js";

describe("minorUnitExponent", () => {
  it("resolves known currencies", () => {
    expect(minorUnitExponent("THB")).toBe(2);
    expect(minorUnitExponent("JPY")).toBe(0);
    expect(minorUnitExponent("KWD")).toBe(3);
  });

  it("is case-insensitive", () => {
    expect(minorUnitExponent("thb")).toBe(2);
    expect(minorUnitExponent("jpy")).toBe(0);
  });

  it("falls back to 2 for a malformed / empty code", () => {
    expect(minorUnitExponent("not-a-currency")).toBe(2);
    expect(minorUnitExponent("")).toBe(2);
  });
});

describe("toMinorUnits / fromMinorUnits", () => {
  it("converts decimals to minor units per the currency exponent", () => {
    expect(toMinorUnits(135.0, "THB")).toBe(13500);
    expect(toMinorUnits(1500, "JPY")).toBe(1500);
    expect(toMinorUnits(1.234, "KWD")).toBe(1234);
  });

  it("rounds to the nearest minor unit", () => {
    expect(toMinorUnits(135.005, "THB")).toBe(13501);
    expect(toMinorUnits(135.004, "THB")).toBe(13500);
  });

  it("round-trips decimal -> minor -> decimal", () => {
    expect(fromMinorUnits(toMinorUnits(135.0, "THB"), "THB")).toBe(135);
    expect(fromMinorUnits(toMinorUnits(1500, "JPY"), "JPY")).toBe(1500);
    expect(fromMinorUnits(toMinorUnits(1.234, "KWD"), "KWD")).toBe(1.234);
  });
});
