import { describe, it, expectTypeOf } from "vitest";
import * as z from "zod";
import { str, int, json } from "./validate.js";

describe("z.infer: worked shapes", () => {
  it("optional string becomes an optional key", () => {
    const spec = z.object({ name: str().optional() });
    expectTypeOf<z.infer<typeof spec>>().toEqualTypeOf<{ name?: string }>();
  });

  it("optional + nullable integer becomes an optional `| null` key", () => {
    const spec = z.object({ due_day: int().optional().nullable() });
    expectTypeOf<z.infer<typeof spec>>().toEqualTypeOf<{ due_day?: number | null }>();
  });

  it("required strips undefined into a required key", () => {
    const spec = z.object({ reason: str() });
    expectTypeOf<z.infer<typeof spec>>().toEqualTypeOf<{ reason: string }>();
  });

  it("default strips undefined into a required key", () => {
    const spec = z.object({ currency: str().default("THB") });
    expectTypeOf<z.infer<typeof spec>>().toEqualTypeOf<{ currency: string }>();
  });

  it("json<T> carries its type parameter through optional", () => {
    const spec = z.object({ metadata: json<Record<string, unknown>>().optional() });
    expectTypeOf<z.infer<typeof spec>>().toEqualTypeOf<{ metadata?: Record<string, unknown> }>();
  });
});
