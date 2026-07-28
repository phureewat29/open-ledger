import { describe, it, expect } from "vitest";
import * as z from "zod";
import { str, num, int, bool, json, parseInput, safeParse, ValidationError } from "./validate.js";

describe("validate — defaults", () => {
  it("uses the default when the key is absent", () => {
    expect(parseInput(z.object({ currency: str().default("THB") }), {}).currency).toBe("THB");
  });

  it("prefers the provided value over the default", () => {
    expect(
      parseInput(z.object({ currency: str().default("THB") }), { currency: "USD" }).currency,
    ).toBe("USD");
  });
});

describe("validate — required accumulation", () => {
  it("lists every missing required field in one message, exact format", () => {
    const spec = z.object({ id: str(), name: str(), type: str() });
    expect(safeParse(spec, {})).toEqual({ ok: false, error: "--id, --name, --type required" });
  });

  it("honours a custom required label", () => {
    expect(safeParse(z.object({ reason: str() }), {})).toEqual({
      ok: false,
      error: "--reason required",
    });
  });

  it("derives the default label from the key (underscores to dashes)", () => {
    expect(safeParse(z.object({ due_day: int() }), {})).toEqual({
      ok: false,
      error: "--due-day required",
    });
  });

  it("accumulates coercion failures alongside missing-required, in key order", () => {
    const spec = z.object({ id: str(), amount: num() });
    expect(safeParse(spec, { amount: "abc" })).toEqual({
      ok: false,
      error: '--id required; --amount must be a number, got "abc"',
    });
  });
});

describe("validate — coercions", () => {
  it("coerces numbers and reports non-numbers", () => {
    expect(parseInput(z.object({ amount: num() }), { amount: "12.5" }).amount).toBe(12.5);
    expect(safeParse(z.object({ amount: num() }), { amount: "abc" })).toEqual({
      ok: false,
      error: '--amount must be a number, got "abc"',
    });
  });

  it("coerces integers and rejects non-integers with the integer message", () => {
    expect(parseInput(z.object({ n: int() }), { n: "7" }).n).toBe(7);
    expect(safeParse(z.object({ n: int() }), { n: "7.5" })).toEqual({
      ok: false,
      error: '--n must be an integer, got "7.5"',
    });
  });

  it("accepts real booleans and the strings true/false", () => {
    expect(parseInput(z.object({ f: bool() }), { f: true }).f).toBe(true);
    expect(parseInput(z.object({ f: bool() }), { f: "true" }).f).toBe(true);
    expect(parseInput(z.object({ f: bool() }), { f: "false" }).f).toBe(false);
    expect(safeParse(z.object({ f: bool() }), { f: "maybe" })).toEqual({
      ok: false,
      error: '--f must be a boolean, got "maybe"',
    });
  });

  it("parses JSON strings and passes already-parsed values through", () => {
    expect(parseInput(z.object({ m: json() }), { m: '{"a":1}' }).m).toEqual({ a: 1 });
    expect(parseInput(z.object({ m: json() }), { m: { a: 1 } }).m).toEqual({ a: 1 });
    const bad = safeParse(z.object({ m: json() }), { m: "{bad" });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toMatch(/^--m must be valid JSON: /);
  });
});

describe("validate — nullable", () => {
  it("passes explicit null through and does not call map", () => {
    let called = false;
    const spec = z.object({
      due_day: int()
        .transform((v) => {
          called = true;
          return v * 2;
        })
        .nullable(),
    });
    const parsed = parseInput(spec, { due_day: null });
    expect(parsed.due_day).toBeNull();
    expect(called).toBe(false);
  });

  it("treats the string \"null\" as a normal value, not null", () => {
    expect(parseInput(z.object({ name: str().nullable() }), { name: "null" }).name).toBe("null");
  });
});

describe("validate — optional", () => {
  it("omits an absent optional key entirely", () => {
    const parsed = parseInput(z.object({ name: str().optional() }), {});
    expect("name" in parsed).toBe(false);
    expect(Object.keys(parsed)).toEqual([]);
  });
});

describe("validate — oneOf", () => {
  it("accepts a member and narrows nothing at runtime", () => {
    expect(
      parseInput(z.object({ type: z.enum(["asset", "liability"]) }), { type: "asset" }).type,
    ).toBe("asset");
  });

  it("rejects a non-member with the join-formatted message", () => {
    expect(safeParse(z.object({ type: z.enum(["asset", "liability"]) }), { type: "bogus" })).toEqual({
      ok: false,
      error: '--type must be one of asset, liability, got "bogus"',
    });
  });
});

describe("validate — key resolution", () => {
  it("reads an explicit alias", () => {
    const spec = z.object({ debit_account_id: str() });
    expect(
      parseInput(spec, { debit_account: "acc:1" }, { aliases: { debit_account_id: ["debit_account"] } })
        .debit_account_id,
    ).toBe("acc:1");
  });

  it("auto-bridges a camelCase raw key to a snake_case spec key", () => {
    expect(parseInput(z.object({ due_day: int() }), { dueDay: "20" }).due_day).toBe(20);
  });
});

describe("validate — map", () => {
  it("applies map to present values", () => {
    expect(parseInput(z.object({ due_day: int().transform((v) => v * 2) }), { due_day: "10" }).due_day).toBe(
      20,
    );
  });
});

describe("validate — atLeastOne", () => {
  const spec = z.object({ name: str().optional(), due_day: int().optional() });
  const msg = "at least one of --name, --due-day is required";

  it("throws when the parsed object has no keys", () => {
    expect(() => parseInput(spec, {}, { atLeastOne: msg })).toThrowError(msg);
  });

  it("passes when at least one field is present", () => {
    expect(parseInput(spec, { name: "x" }, { atLeastOne: msg })).toEqual({ name: "x" });
  });
});

describe("validate — entry-point shapes", () => {
  it("safeParse returns an ok Result on success", () => {
    expect(safeParse(z.object({ name: str() }), { name: "x" })).toEqual({
      ok: true,
      value: { name: "x" },
    });
  });

  it("safeParse returns an error Result on failure", () => {
    expect(safeParse(z.object({ name: str() }), {})).toEqual({
      ok: false,
      error: "--name required",
    });
  });

  it("parseInput throws a ValidationError listing all failures", () => {
    const spec = z.object({ id: str(), name: str(), type: str() });
    try {
      parseInput(spec, {});
      expect.unreachable("parseInput should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("--id, --name, --type required");
    }
  });
});
