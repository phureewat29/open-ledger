import { describe, it, expect } from "vitest";
import { buildPatch, type PatchField } from "./patch.js";

interface Row {
  id: string;
  due_day: number | null;
  bank_name: string | null;
  masked: string | null;
}

function freshRow(overrides: Partial<Row> = {}): Row {
  return { id: "acct-1", due_day: 15, bank_name: "ktc", masked: "••1234", ...overrides };
}

describe("buildPatch", () => {
  it("skips an absent field entirely", () => {
    const spec: Record<string, PatchField> = { due_day: {} };
    const result = buildPatch(spec, freshRow(), {});
    expect(result).toEqual({ sets: [], params: [], before: {}, after: {} });
  });

  it("lets an explicit null through and binds SQL null", () => {
    const spec: Record<string, PatchField> = { due_day: {} };
    const result = buildPatch(spec, freshRow(), { due_day: null });
    expect(result.sets).toEqual(["due_day = ?"]);
    expect(result.params).toEqual([null]);
    expect(result.before.due_day).toBe(15);
    expect(result.after.due_day).toBeNull();
  });

  it("applies transform for the bound param and after value, leaving before untouched", () => {
    const spec: Record<string, PatchField> = {
      bank_name: { transform: (v) => (v == null ? null : String(v).toUpperCase()) },
    };
    const result = buildPatch(spec, freshRow({ bank_name: "ktc" }), { bank_name: "scb" });
    expect(result.before.bank_name).toBe("ktc");
    expect(result.after.bank_name).toBe("SCB");
    expect(result.params).toEqual(["SCB"]);
  });

  it("maps a key to a different column via `column`, while before reads that column", () => {
    const spec: Record<string, PatchField> = {
      masked: { column: "account_number_masked" },
    };
    const row = { id: "acct-1", account_number_masked: "••9999" } as unknown as Row;
    const result = buildPatch(spec, row, { masked: "••1111" });
    expect(result.sets).toEqual(["account_number_masked = ?"]);
    expect(result.before.masked).toBe("••9999");
    expect(result.after.masked).toBe("••1111");
  });

  it("never puts undefined into params, even if a transform returns it", () => {
    const spec: Record<string, PatchField> = {
      due_day: { transform: () => undefined },
    };
    const result = buildPatch(spec, freshRow(), { due_day: 20 });
    expect(result.params).toEqual([null]);
  });
});
