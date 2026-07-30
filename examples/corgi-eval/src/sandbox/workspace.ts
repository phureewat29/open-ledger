import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { tryExecute, type Result } from "../core/result.js";
import type { OpenLedgerRunner } from "../oled/command.js";

// Never touches the caller's real ~/.oled: HOME and every OLED_* path point into the tree.
export interface Workspace {
  root: string;
  home: string;
  data: string;
  cwd: string;
  cache: string;
  agent: string;
  /** npm --global --prefix target for the packed CLI. */
  npm: string;
  dbPath: string;
  env: NodeJS.ProcessEnv;
}

export interface SkillPack {
  path: string;
  version: string;
  sha256: string;
  length: number;
  text: string;
}

const DIRS = ["home", "data", "cwd", "cache", "agent", "npm"] as const;

/**
 * Every OLED_* the harness reads is set here, blank included — an operator's
 * exported OCR endpoint would otherwise reroute a statement and change what the
 * model was measured on.
 */
function buildEnv(paths: Omit<Workspace, "env">): NodeJS.ProcessEnv {
  const bin = join(paths.npm, "bin");
  return {
    ...process.env,
    PATH: `${bin}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
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

export function createWorkspace(): Result<Workspace> {
  const created = tryExecute(() => {
    const root = mkdtempSync(join(tmpdir(), "corgi-eval-"));
    const paths = {
      root,
      home: join(root, "home"),
      data: join(root, "data"),
      cwd: join(root, "cwd"),
      cache: join(root, "cache"),
      agent: join(root, "agent"),
      npm: join(root, "npm"),
      dbPath: join(root, "db.sqlite"),
    };
    for (const dir of DIRS) mkdirSync(paths[dir], { recursive: true });
    return { ...paths, env: buildEnv(paths) };
  });
  if (!created.ok) return { ok: false, error: `cannot create workspace: ${created.error}` };
  return created;
}

// Only the PDFs travel: the fact files stay out of every path the model can reach.
export function seedStatements(workspace: Workspace, sourcePdfs: string[]): Result<string[]> {
  const seeded = tryExecute(() => {
    const dir = join(workspace.data, "corgi-bank");
    mkdirSync(dir, { recursive: true });
    return sourcePdfs.map((source) => {
      const dest = join(dir, basename(source));
      copyFileSync(source, dest);
      return dest;
    });
  });
  if (!seeded.ok) return { ok: false, error: `cannot seed the statements: ${seeded.error}` };
  return seeded;
}

/** The system prompt is the INSTALLED file, so its hash and length are what
 *  the report can be trusted against. */
export async function installSkillPack(
  workspace: Workspace,
  runner: OpenLedgerRunner,
): Promise<Result<SkillPack>> {
  const setup = await runner.run(["setup", "--dir", workspace.agent, "--json"]);
  if (!setup.ok) return { ok: false, error: `oled setup did not run: ${setup.message}` };
  if (setup.value.exitCode !== 0) {
    return {
      ok: false,
      error: `oled setup exited ${setup.value.exitCode}: ${setup.value.stderr.trim()}`,
    };
  }

  const dir = join(workspace.agent, "openledger");
  const pack = tryExecute(() => {
    const text = readFileSync(join(dir, "SKILL.md"), "utf8");
    return {
      path: join(dir, "SKILL.md"),
      version: readFileSync(join(dir, "VERSION"), "utf8").trim(),
      sha256: createHash("sha256").update(text).digest("hex"),
      length: text.length,
      text,
    };
  });
  if (!pack.ok) return { ok: false, error: `cannot read the installed skill: ${pack.error}` };
  return pack;
}

function disposeWorkspace(workspace: Workspace): void {
  rmSync(workspace.root, { recursive: true, force: true });
}

interface WorkspaceGuard {
  register(workspace: Workspace): void;
  /** Call on a clean finish; a kept workspace prints its path instead. */
  release(): void;
}

export function createWorkspaceGuard(keep: boolean): WorkspaceGuard {
  let workspace: Workspace | null = null;
  let released = false;

  const cleanupOnce = (): void => {
    if (released) return;
    released = true;
    if (!workspace) return;
    if (keep) {
      process.stderr.write(`\nworkspace kept at ${workspace.root}\n`);
      return;
    }
    disposeWorkspace(workspace);
  };

  process.on("exit", cleanupOnce);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cleanupOnce();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }

  return {
    register(next) {
      workspace = next;
    },
    release: cleanupOnce,
  };
}
