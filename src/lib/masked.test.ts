import { describe, it, expect } from "vitest";
import { accountNumberKey, normalizeMaskedAccountNumber } from "./masked.js";

describe("accountNumberKey", () => {
  it("strips separators and a trailing check digit to the last 4 digits", () => {
    expect(accountNumberKey("••7652")).toBe("7652");
    expect(accountNumberKey("••7652-0")).toBe("7652");
    expect(accountNumberKey("xxx-7652-0")).toBe("7652");
    expect(accountNumberKey("1234")).toBe("1234");
    expect(accountNumberKey(null)).toBe("");
    expect(accountNumberKey("••")).toBe("");
  });

  it("uses the literal trailing digits after a mask run, without dropping one as a check digit", () => {
    expect(accountNumberKey("470686XXXXXX9483")).toBe("9483");
    expect(accountNumberKey("470686XXXXXX483")).toBe("483");
    expect(accountNumberKey("76520")).toBe("7652");
  });
});

describe("normalizeMaskedAccountNumber", () => {
  it("collapses check-digit variants to one masked value", () => {
    expect(normalizeMaskedAccountNumber("••7652-0")).toBe("••7652");
    expect(normalizeMaskedAccountNumber("••76520")).toBe("••7652");
    expect(normalizeMaskedAccountNumber("••7652")).toBe("••7652");
    expect(normalizeMaskedAccountNumber(null)).toBeNull();
    expect(normalizeMaskedAccountNumber("••")).toBe("••");
    // A number that opens with digits has no prefix to keep, so it gets the default one.
    expect(normalizeMaskedAccountNumber("470686XXXXXX9483")).toBe("••9483");
  });
});
