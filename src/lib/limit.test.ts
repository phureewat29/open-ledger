import { describe, expect, it } from "vitest";
import { clampLimit } from "./limit.js";

describe("clampLimit", () => {
  it("applies the fallback, the floor of 1, and the surface's max", () => {
    expect(clampLimit(undefined, 200, 1000)).toBe(200);
    expect(clampLimit(0, 200, 1000)).toBe(1);
    expect(clampLimit(5000, 200, 1000)).toBe(1000);
    expect(clampLimit(7, 50, 500)).toBe(7);
  });
});
