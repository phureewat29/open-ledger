import { describe, it, expect } from "vitest";
import { generateKey } from "./encryption.js";

describe("generateKey", () => {
  it("returns a 64-character lowercase hex string", () => {
    const key = generateKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different value each call", () => {
    expect(generateKey()).not.toBe(generateKey());
  });
});
