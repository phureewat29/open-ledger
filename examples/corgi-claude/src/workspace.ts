/** Workspace setup/teardown for the corgi-claude demo. */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WorkspacePaths {
  /** Workspace root (a fresh mkdtemp directory). */
  root: string;
  /** Redirected HOME/USERPROFILE - keeps ~/.plasalid (and ~/.claude) isolated. */
  home: string;
  /** PLASALID_DATA_DIR - where statements get placed for discovery. */
  data: string;
  /** Working directory the demo (and `claude`) run from. */
  cwd: string;
  /** Holds the `plasalid` bin shim, put on PATH. */
  bin: string;
  /** PLASALID_CACHE_DIR - scratch space for prepared/decrypted documents. */
  cache: string;
  /** PLASALID_DB_PATH - sqlite db file (does not need to pre-exist). */
  dbPath: string;
  /** Where `plasalid setup` installs the skill pack (.claude under cwd).
   *  Created by setup, not pre-made by createWorkspace. */
  skillDir: string;
}

/** Create a fresh workspace directory tree (mktemp-style). Pure filesystem
 *  setup - no env/PATH side effects (see buildEnv / writeBinShim). */
export function createWorkspace(): WorkspacePaths {
  const root = mkdtempSync(join(tmpdir(), "corgi-claude-"));
  const cwd = join(root, "cwd");
  const paths: WorkspacePaths = {
    root,
    home: join(root, "home"),
    data: join(root, "data"),
    cwd,
    bin: join(root, "bin"),
    cache: join(root, "cache"),
    dbPath: join(root, "db.sqlite"),
    skillDir: join(cwd, ".claude"),
  };
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.cwd, { recursive: true });
  mkdirSync(paths.bin, { recursive: true });
  mkdirSync(paths.cache, { recursive: true });
  return paths;
}

/** Write a `plasalid` shim into the workspace bin dir that execs this
 *  checkout's freshly-built dist/cli/index.js. */
export function writeBinShim(paths: WorkspacePaths, repoRoot: string): void {
  const shimPath = join(paths.bin, "plasalid");
  const distEntry = join(repoRoot, "dist", "cli", "index.js");
  const script = `#!/bin/sh\nexec node "${distEntry}" "$@"\n`;
  writeFileSync(shimPath, script, { mode: 0o755 });
  chmodSync(shimPath, 0o755);
}

/** Build the isolation env: HOME/USERPROFILE, PLASALID_* paths, a blank
 *  encryption key (plain db, reproducible), NO_COLOR, and PATH prefixed with
 *  the workspace bin dir so `plasalid` resolves to the shim above. */
export function buildEnv(
  paths: WorkspacePaths,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    PATH: `${paths.bin}${base.PATH ? `:${base.PATH}` : ""}`,
    HOME: paths.home,
    USERPROFILE: paths.home,
    PLASALID_DIR: join(paths.home, ".plasalid"),
    PLASALID_DB_PATH: paths.dbPath,
    PLASALID_DATA_DIR: paths.data,
    PLASALID_CACHE_DIR: paths.cache,
    PLASALID_DB_ENCRYPTION_KEY: "",
    NO_COLOR: "1",
  };
}

/** Copy the bundled card statement into the workspace data dir
 *  (data/corgi-bank/), same relative layout `plasalid ingest list` expects to
 *  discover. Returns the destination path. */
export function placeStatement(
  paths: WorkspacePaths,
  sourcePdfPath: string,
): string {
  const destDir = join(paths.data, "corgi-bank");
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, "card-statement-2026-05.pdf");
  copyFileSync(sourcePdfPath, dest);
  return dest;
}

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn a command, capture stdout/stderr in full (no streaming) and resolve
 *  once it exits. Shared by every non-interactive step below. */
export function runCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      resolve({ ok: false, code: null, stdout, stderr: stderr || err.message });
    });

    child.on("close", (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });

    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** `npm run build` at the repo root - builds dist/cli/index.js for the bin
 *  shim to exec. */
export function buildPlasalid(repoRoot: string): Promise<RunResult> {
  return runCommand("npm", ["run", "build"], { cwd: repoRoot });
}

/** Run a `plasalid` subcommand through the workspace bin shim (resolved via
 *  the isolation env's PATH). */
export function runPlasalid(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<RunResult> {
  return runCommand("plasalid", args, { cwd, env });
}

/** Installs the plasalid skill pack into `paths.skillDir` (via `plasalid
 *  setup`) so `claude` can discover the harness. */
export function installSkill(
  paths: WorkspacePaths,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return runPlasalid(
    ["setup", "--dir", paths.skillDir, "--json"],
    env,
    paths.cwd,
  );
}

/** `plasalid vault add <pattern> --password-stdin --json`, piping the
 *  password over stdin (never as an argv value). */
export function vaultAddPassword(
  pattern: string,
  password: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<RunResult> {
  return runCommand(
    "plasalid",
    ["vault", "add", pattern, "--password-stdin", "--json"],
    {
      cwd,
      env,
      input: password,
    },
  );
}

/** Parse NDJSON stdout into per-line objects, ignoring blank lines. Invalid
 *  lines are skipped defensively rather than throwing. */
export function parseNdjson(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // ignore malformed/partial lines
    }
  }
  return out;
}

/** Best-effort check that `claude` resolves and runs (installed, on PATH),
 *  so the demo fails with a friendly message instead of a raw ENOENT later. */
export function checkClaudeCli(
  env: NodeJS.ProcessEnv,
  timeoutMs = 5000,
): boolean {
  const res = spawnSync("claude", ["--version"], {
    env,
    timeout: timeoutMs,
    stdio: "ignore",
  });
  return res.error == null && res.status === 0;
}

/** Remove the workspace directory tree. Safe to call more than once. */
export function cleanupWorkspace(paths: WorkspacePaths): void {
  rmSync(paths.root, { recursive: true, force: true });
}
