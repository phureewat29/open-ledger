import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSandbox, type Sandbox } from "../lib/sandbox.js";

// integration.test.ts lives in src/cli/ -> repo root is two levels up.
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const cliEntry = resolve(repoRoot, "src", "cli", "index.ts");

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

let sandbox: Sandbox;

beforeAll(() => {
  sandbox = createSandbox("oled-it-");
});

afterAll(() => {
  sandbox.cleanup();
});

function runCli(
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      "npx",
      ["tsx", cliEntry, ...args],
      {
        cwd: sandbox.root,
        env: { ...sandbox.env, ...(opts.env ?? {}) },
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
    if (opts.stdin != null) {
      child.stdin?.write(opts.stdin);
    }
    child.stdin?.end();
  });
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/;

describe("cli integration (subprocess)", () => {
  it("new status --json emits exactly one parseable JSON object, exit 0", async () => {
    const { stdout, code } = await runCli(["status", "--json"]);
    expect(code).toBe(0);
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]);
    expect(obj.type).toBe("status");
    expect(obj.db).toBeDefined();
    expect(obj.counts).toBeDefined();
  }, 30000);

  it("emits zero ANSI escape codes on piped (non-TTY) stdout", async () => {
    const { stdout, code } = await runCli(["status"]);
    expect(code).toBe(0);
    expect(ANSI_RE.test(stdout)).toBe(false);
  }, 30000);

  it("a guarded command without confirmation exits non-zero with a JSON error on stderr", async () => {
    // `vault rm` requires --yes; without it the shared error layer emits a
    // single JSON error object on stderr and nothing on stdout.
    const { stdout, stderr, code } = await runCli(["vault", "rm", "some-pattern", "--json"]);
    expect(code).not.toBe(0);
    expect(stdout.trim()).toBe("");
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toMatch(/^E_/);
    expect(typeof parsed.error.message).toBe("string");
  }, 30000);

  it("no-arg runs the new status in plain mode with tab-separated lines, exit 0", async () => {
    const { stdout, code } = await runCli([]);
    expect(code).toBe(0);
    expect(stdout).toContain("\t");
    expect(stdout).toMatch(/^configured\t/m);
  }, 30000);

  it("--help lists the final harness command surface", async () => {
    const { stdout, code } = await runCli(["--help"]);
    expect(code).toBe(0);
    for (const noun of [
      "status", "doctor", "setup", "config", "ingest", "files", "vault", "transactions",
      "accounts", "merchants", "questions", "report", "notes", "data",
    ]) {
      expect(stdout).toContain(noun);
    }
  }, 30000);
});
