import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveContextBudget, type ModelCapabilities } from "./capabilities.js";

function capabilities(contextLength: number | null): ModelCapabilities {
  return {
    modalities: ["text"],
    source: contextLength === null ? "assumed" : "openrouter",
    contextLength,
    detail: "test",
  };
}

test("a published window decides the budget", () => {
  const budget = resolveContextBudget(capabilities(100_000), null);
  assert.equal(budget.source, "derived");
  assert.equal(budget.tokens, 80_000);
});

test("no published window falls to the default", () => {
  const budget = resolveContextBudget(capabilities(null), null);
  assert.equal(budget.source, "default");
  assert.equal(budget.tokens, 28_000);
});

/** The escape hatch: without it a small model behind a silent endpoint overflows the default. */
test("an explicit budget outranks both the window and the default", () => {
  for (const window of [100_000, null]) {
    const budget = resolveContextBudget(capabilities(window), 4_096);
    assert.equal(budget.source, "explicit", `window ${window}`);
    assert.equal(budget.tokens, 4_096, `window ${window}`);
  }
});
