import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lives beside the other fixtures rather than in src/ so it never ships in
 * the published package.
 */
export interface Sandbox {
  root: string;
  home: string;
  dbPath: string;
  dataDir: string;
  cacheDir: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/**
 * A throwaway `mkdtemp` root (with `home/`/`data/` pre-created) plus an `env`
 * that redirects HOME and every OLED_* path into it, so nothing ever
 * touches the real `~/.oled`.
 */
export function createSandbox(prefix: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const cacheDir = join(root, "cache");
  const dbPath = join(root, "db.sqlite");
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OLED_DIR: join(home, ".oled"),
    OLED_DB_PATH: dbPath,
    OLED_DATA_DIR: dataDir,
    OLED_CACHE_DIR: cacheDir,
    // Blanked so no test can reach a live OCR endpoint, and so a developer's own
    // model choice cannot leak in.
    OLED_OCR_BASE_URL: "",
    OLED_OCR_MODEL: "",
    OLED_OCR_API_KEY: "",
    NO_COLOR: "1",
  };
  /**
   * Node warns on stderr when NO_COLOR and FORCE_COLOR are both set, corrupting
   * the one-JSON-object-on-stderr contract subprocess tests assert — drop both
   * rather than inherit whatever the shell/CI exported.
   */
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;

  return {
    root,
    home,
    dbPath,
    dataDir,
    cacheDir,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** This file lives in fixtures/, so the repo root is one level up. */
export const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const cliEntry = resolve(repoRoot, "src", "cli", "index.ts");
export const distEntry = resolve(repoRoot, "dist", "cli", "index.js");

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunCliOpts {
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type CliRunner = (args: string[], opts?: RunCliOpts) => Promise<CliResult>;

/**
 * `"src"` transpiles the TypeScript entry on every spawn; `"dist"` runs the built
 * artifact a published install executes, and needs a prior build — the e2e
 * suite's globalSetup owns that.
 */
export type CliTarget = "src" | "dist";

const CLI_COMMAND: Record<CliTarget, { file: string; argv: string[] }> = {
  // Absolute entry path, so a caller can override cwd (e.g. an agent shell
  // elsewhere) without breaking tsx's entrypoint lookup.
  src: { file: "npx", argv: ["tsx", cliEntry] },
  dist: { file: process.execPath, argv: [distEntry] },
};

/**
 * Resolves with the exit code instead of rejecting, because every caller
 * asserts on it. Bound rather than passed per call: the sandbox only exists
 * from `beforeAll` onwards.
 */
export function makeRunCli(sandbox: Sandbox, target: CliTarget = "src"): CliRunner {
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
