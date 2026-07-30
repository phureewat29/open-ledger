import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSandbox, makeRunCli, type CliRunner, type Sandbox } from "../../fixtures/sandbox.js";
import { COMMANDS } from "./program.js";

let sandbox: Sandbox;
let runCli: CliRunner;

beforeAll(() => {
  sandbox = createSandbox("oled-it-");
  runCli = makeRunCli(sandbox);
});

afterAll(() => {
  sandbox.cleanup();
});

describe("cli integration (subprocess)", () => {
  it("a guarded command without confirmation exits non-zero with a JSON error on stderr", async () => {
    // requireYes fires before the id lookup, so the nonexistent id never matters.
    const { stdout, stderr, code } = await runCli(["transactions", "delete", "tx:none", "--json"]);
    expect(code).not.toBe(0);
    expect(stdout.trim()).toBe("");
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe("E_INPUT_REQUIRED");
    expect(typeof parsed.error.message).toBe("string");
  }, 30000);

  it("no-arg runs the new status in plain mode with tab-separated lines, exit 0", async () => {
    const { stdout, code } = await runCli([]);
    expect(code).toBe(0);
    expect(stdout).toContain("\t");
    expect(stdout).toMatch(/^configured\t/m);
    // Piped, so the human renderer must not colour: chalk sees no TTY.
    expect(/\x1b\[[0-9;]*m/.test(stdout)).toBe(false);
  }, 30000);

  // Derived from COMMANDS, which consistency.test.ts pins to the registered tree.
  it("--help renders every command in the help screen", async () => {
    const { stdout, code } = await runCli(["--help"]);
    expect(code).toBe(0);
    for (const { name } of COMMANDS) expect(stdout).toContain(name);
  }, 30000);
});
