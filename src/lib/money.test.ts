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

  it("scales through the decimal literal, so a representable half is a half", () => {
    // A float multiply makes each of these land just under .5 and lose a satang.
    expect(toMinorUnits(1.005, "THB")).toBe(101);
    expect(toMinorUnits(8.165, "THB")).toBe(817);
    expect(toMinorUnits(1.015, "THB")).toBe(102);
  });

  it("rounds halves away from zero, not toward +Infinity", () => {
    expect(toMinorUnits(-1.005, "THB")).toBe(-101);
    expect(toMinorUnits(-8.165, "THB")).toBe(-817);
    expect(toMinorUnits(-1.2345, "KWD")).toBe(-1235);
  });

  it("accepts input String() prints in exponential notation", () => {
    expect(toMinorUnits(1e-2, "THB")).toBe(1);
    expect(toMinorUnits(1.5e3, "THB")).toBe(150000);
    expect(toMinorUnits(1e-7, "THB")).toBe(0);
    expect(toMinorUnits(1e21, "JPY")).toBe(1e21);
  });

  it("scales by the currency's own exponent", () => {
    expect(toMinorUnits(1500.6, "JPY")).toBe(1501);
    expect(toMinorUnits(1.2345, "KWD")).toBe(1235);
  });

  it("round-trips decimal -> minor -> decimal", () => {
    expect(fromMinorUnits(toMinorUnits(135.0, "THB"), "THB")).toBe(135);
    expect(fromMinorUnits(toMinorUnits(1500, "JPY"), "JPY")).toBe(1500);
    expect(fromMinorUnits(toMinorUnits(1.234, "KWD"), "KWD")).toBe(1.234);
  });
});
