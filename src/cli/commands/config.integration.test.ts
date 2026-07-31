import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createSandbox, makeRunCLI, type CLIRunner, type Sandbox } from "../../../fixtures/sandbox.js";

let sandbox: Sandbox;
let runCLI: CLIRunner;

beforeAll(() => {
  sandbox = createSandbox("oled-config-it-");
  runCLI = makeRunCLI(sandbox);
});

afterAll(() => {
  sandbox.cleanup();
});

describe("config --currency (subprocess)", () => {
  it("refuses a code that could never name a ledger, before anything is persisted", async () => {
    const { stderr, code } = await runCLI(["config", "--init", "--currency", "us", "--json"]);
    expect(code).toBe(2); // EXIT.USAGE

    const { error } = JSON.parse(stderr.trim());
    expect(error.code).toBe("E_USAGE");
    expect(error.message).toBe("--currency must be a 3-letter currency code, e.g. THB");
    // Persisting it would abort every later converge on `us:expense:uncategorized`, an id the CHECK rejects.
    expect(existsSync(join(sandbox.home, ".oled", "config.json"))).toBe(false);
  }, 30000);
});
