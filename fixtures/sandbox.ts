/** Lives beside the other fixtures, not in src/, so it never ships in the published package. */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Sandbox {
  root: string;
  home: string;
  /** `<home>/.oled` — where the default config path and every default location resolve. */
  oledDir: string;
  configPath: string;
  dbPath: string;
  dataDir: string;
  cacheDir: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/** A throwaway `mkdtemp` root plus an `env` that redirects HOME into it, so the
 *  default `~/.oled` tree lands in the sandbox and nothing touches the real one. */
export function createSandbox(prefix: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const oledDir = join(home, ".oled");
  const dataDir = join(oledDir, "data");
  mkdirSync(dataDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
  };
  // Node warns on stderr when NO_COLOR and FORCE_COLOR are both set, corrupting the
  // one-JSON-object-on-stderr contract subprocess tests assert; drop both rather than inherit them.
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;

  return {
    root,
    home,
    oledDir,
    configPath: join(oledDir, "config.json"),
    dbPath: join(oledDir, "db.sqlite"),
    dataDir,
    cacheDir: join(oledDir, "cache"),
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Seeds the sandbox's config.json so gated commands run without a prior `config --init`. */
export function writeConfig(sandbox: Sandbox, values: Record<string, unknown>): void {
  mkdirSync(sandbox.oledDir, { recursive: true });
  writeFileSync(sandbox.configPath, JSON.stringify(values, null, 2) + "\n");
}

/** This file lives in fixtures/, so the repo root is one level up. */
export const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const cliEntry = resolve(repoRoot, "src", "cli", "index.ts");
export const distEntry = resolve(repoRoot, "dist", "cli", "index.js");

export interface CLIResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RunCLIOpts {
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type CLIRunner = (args: string[], opts?: RunCLIOpts) => Promise<CLIResult>;

/** `"src"` transpiles the TypeScript entry per spawn; `"dist"` runs the built artifact (needs a prior build; the e2e suite's globalSetup owns that). */
type CLITarget = "src" | "dist";

const CLI_COMMAND: Record<CLITarget, { file: string; argv: string[] }> = {
  // Absolute entry path so a caller can override cwd without breaking tsx's entrypoint lookup.
  src: { file: "npx", argv: ["tsx", cliEntry] },
  dist: { file: process.execPath, argv: [distEntry] },
};

/** Resolves with the exit code instead of rejecting, since every caller asserts on it. */
export function makeRunCLI(sandbox: Sandbox, target: CLITarget = "src"): CLIRunner {
  const { file, argv } = CLI_COMMAND[target];
  return (args, opts = {}) =>
    new Promise((resolvePromise) => {
      const child = execFile(
        file,
        [...argv, ...args],
        {
          cwd: opts.cwd ?? sandbox.root,
          env: opts.env ?? sandbox.env,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : error
                ? 1
                : 0;
          resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code });
        },
      );
      if (opts.stdin != null) child.stdin?.write(opts.stdin);
      child.stdin?.end();
    });
}

export function parseNdjson(stdout: string): any[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The single JSON object a one-result command emits; throws when it emitted more. */
export function parseOne(stdout: string): any {
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`expected exactly 1 NDJSON line, got ${lines.length}: ${stdout.slice(0, 500)}`);
  }
  return JSON.parse(lines[0]);
}
