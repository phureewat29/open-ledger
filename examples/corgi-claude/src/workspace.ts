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

/** How much of a command's output a one-line step detail may carry. */
export const DETAIL_MAX = 200;

const CLAUDE_VERSION_TIMEOUT_MS = 5000;

export interface WorkspacePaths {
  root: string;
  /** Redirected HOME/USERPROFILE; keeps ~/.oled and ~/.claude isolated. */
  home: string;
  data: string;
  cwd: string;
  bin: string;
  /** Under cwd so the agent reads prepared documents without leaving its workspace. */
  cache: string;
  dbPath: string;
}

/** Creates the directory tree only; env/PATH setup happens in buildEnv/writeBinShim. */
export function createWorkspace(): WorkspacePaths {
  const root = mkdtempSync(join(tmpdir(), "corgi-claude-"));
  const cwd = join(root, "cwd");
  const paths: WorkspacePaths = {
    root,
    home: join(root, "home"),
    data: join(root, "data"),
    cwd,
    bin: join(root, "bin"),
    cache: join(cwd, "cache"),
    dbPath: join(root, "db.sqlite"),
  };
  for (const dir of [paths.home, paths.data, paths.cwd, paths.bin, paths.cache]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export function writeBinShim(paths: WorkspacePaths, repoRoot: string): void {
  const shimPath = join(paths.bin, "oled");
  const distEntry = join(repoRoot, "dist", "cli", "index.js");
  const script = `#!/bin/sh\nexec node "${distEntry}" "$@"\n`;
  writeFileSync(shimPath, script, { mode: 0o755 });
  chmodSync(shimPath, 0o755);
}

/**
 * PATH is prefixed so `oled` resolves to the shim. Every OLED_* the harness
 * reads is set here, blank included: an operator's exported OCR endpoint would
 * otherwise reach the demo.
 */
export function buildEnv(paths: WorkspacePaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${paths.bin}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
    HOME: paths.home,
    USERPROFILE: paths.home,
    OLED_DIR: join(paths.home, ".oled"),
    OLED_DB_PATH: paths.dbPath,
    OLED_DATA_DIR: paths.data,
    OLED_CACHE_DIR: paths.cache,
    OLED_OCR_BASE_URL: "",
    OLED_OCR_MODEL: "",
    OLED_OCR_API_KEY: "",
    NO_COLOR: "1",
  };
}

/** Uses the relative layout `oled ingest list` expects to discover statements. */
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

interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A step outcome: nothing branches on the failure kind, it is only reported. */
export interface StepResult {
  ok: boolean;
  detail?: string;
}

function runCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
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

    child.stdin.end();
  });
}

/** Collapses whitespace so a multi-line command or error fits one report line. */
export function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 3))}...` : oneLine;
}

/** Detail line for a failed `oled` run: the exit code plus the head of stderr. */
export function failureDetail(res: RunResult): string {
  return `exit ${res.code}: ${truncate(res.stderr, DETAIL_MAX)}`;
}

/** For steps whose whole assertion is the exit code. */
export function exitStatus(res: RunResult): StepResult {
  return { ok: res.ok, detail: res.ok ? undefined : failureDetail(res) };
}

/** Builds dist/cli/index.js, which the bin shim (writeBinShim) execs. */
export function buildOpenLedger(repoRoot: string): Promise<RunResult> {
  return runCommand("npm", ["run", "build"], { cwd: repoRoot });
}

export function runOpenLedger(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<RunResult> {
  return runCommand("oled", args, { cwd, env });
}

/** Doctor and status never create the ledger, so the runner initializes it
 *  deterministically instead of leaving that to the agent's first turn. */
export async function initLedger(env: NodeJS.ProcessEnv, cwd: string): Promise<StepResult> {
  const res = await runOpenLedger(["config", "--init", "--json"], env, cwd);
  if (!res.ok) return exitStatus(res);
  return { ok: true, detail: "config, db and data dir created" };
}

/** `--dir .claude/skills` resolves against the run's cwd, landing the pack at
 *  `<cwd>/.claude/skills/openledger`, where `claude` discovers it; the reported
 *  path is the one setup says it wrote. */
export async function installSkill(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<StepResult> {
  const res = await runOpenLedger(["setup", "--dir", ".claude/skills", "--json"], env, cwd);
  if (!res.ok) return exitStatus(res);

  const [payload] = parseNdjson(res.stdout);
  const installed = payload?.installed;
  const path = Array.isArray(installed) ? stringField(installed[0], "path") : "";
  if (!path) return { ok: false, detail: `no installed path in ${truncate(res.stdout, DETAIL_MAX)}` };
  return { ok: true, detail: path };
}

/** Invalid lines are skipped rather than throwing. */
export function parseNdjson(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // ignore
    }
  }
  return out;
}

function walk(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** "" for a missing or non-string field; never throws. */
export function stringField(obj: unknown, ...path: string[]): string {
  const v = walk(obj, path);
  return typeof v === "string" ? v : "";
}

/** 0 for a missing or non-number field; never throws. */
export function numberField(obj: unknown, ...path: string[]): number {
  const v = walk(obj, path);
  return typeof v === "number" ? v : 0;
}

/** Best-effort check that `claude` resolves and runs (installed, on PATH),
 *  so the demo fails with a friendly message instead of a raw ENOENT later. */
export function checkClaudeCli(env: NodeJS.ProcessEnv): boolean {
  const res = spawnSync("claude", ["--version"], {
    env,
    timeout: CLAUDE_VERSION_TIMEOUT_MS,
    stdio: "ignore",
  });
  return res.error == null && res.status === 0;
}

/** Safe to call more than once. */
export function cleanupWorkspace(paths: WorkspacePaths): void {
  rmSync(paths.root, { recursive: true, force: true });
}
