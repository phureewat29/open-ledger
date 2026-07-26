import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { tryExecute, type Result } from "../core/result.js";
import type { PlasalidRunner } from "../plasalid/command.js";

/**
 * A throwaway directory tree plus the env that pins plasalid inside it. Nothing
 * here touches the caller's real ~/.plasalid: HOME is redirected and every
 * PLASALID_* path points into the tree.
 */

export interface Workspace {
  root: string;
  home: string;
  data: string;
  cwd: string;
  cache: string;
  /** `plasalid setup --dir` base; the pack lands at <agent>/skills/plasalid. */
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

/** A blank encryption key means a plain db file: reproducible across runs. */
function buildEnv(paths: Omit<Workspace, "env">): NodeJS.ProcessEnv {
  const bin = join(paths.npm, "bin");
  return {
    ...process.env,
    PATH: `${bin}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
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

/**
 * Copies each statement into <data>/corgi-bank/, the layout `ingest list`
 * discovers. Only the PDFs travel: the fact files stay in the example, out of
 * every path the model can reach.
 */
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

/**
 * Installs the skill pack the CLI ships and reads it back. The system prompt is
 * the INSTALLED file, so its hash and length are what the report can be trusted
 * against.
 */
export async function installSkillPack(
  workspace: Workspace,
  runner: PlasalidRunner,
): Promise<Result<SkillPack>> {
  const setup = await runner.run(["setup", "--dir", workspace.agent, "--json"]);
  if (!setup.ok) return { ok: false, error: `plasalid setup did not run: ${setup.message}` };
  if (setup.value.exitCode !== 0) {
    return {
      ok: false,
      error: `plasalid setup exited ${setup.value.exitCode}: ${setup.value.stderr.trim()}`,
    };
  }

  const dir = join(workspace.agent, "skills", "plasalid");
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

export function disposeWorkspace(workspace: Workspace): void {
  rmSync(workspace.root, { recursive: true, force: true });
}

export interface WorkspaceGuard {
  register(workspace: Workspace): void;
  /** Call on a clean finish; a kept workspace prints its path instead. */
  release(): void;
}

/**
 * Deletes the workspace on exit, Ctrl-C, or SIGTERM, so an aborted run cannot
 * leave a multi-megabyte npm prefix behind.
 */
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
