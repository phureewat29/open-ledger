import { describe, expect, it } from "vitest";
import { clampLimit, clampOffset } from "./limit.js";

describe("clampLimit", () => {
  it("applies the fallback, the floor of 1, and the surface's max", () => {
    expect(clampLimit(undefined, 200, 1000)).toBe(200);
    expect(clampLimit(0, 200, 1000)).toBe(1);
    expect(clampLimit(5000, 200, 1000)).toBe(1000);
    expect(clampLimit(7, 50, 500)).toBe(7);
  });
});

describe("clampOffset", () => {
  it("defaults to 0, floors negatives and fractions", () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(-5)).toBe(0);
    expect(clampOffset(2.9)).toBe(2);
    expect(clampOffset(500)).toBe(500);
  });
});
