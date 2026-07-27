import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    OLED_DB_ENCRYPTION_KEY: "",
    NO_COLOR: "1",
  };
  // Node warns on stderr when NO_COLOR and FORCE_COLOR are both set, corrupting
  // the one-JSON-object-on-stderr contract subprocess tests assert — drop both
  // rather than inherit whatever the shell/CI exported.
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

/**
 * Runs `cleanup` once on exit and SIGINT/SIGTERM (re-raising 130/143
 * afterwards), so a killed script still removes its sandbox. Script callers
 * only — vitest's `afterAll` already suffices there.
 */
export function registerProcessCleanup(cleanup: () => void): void {
  let cleanedUp = false;
  const cleanupOnce = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    cleanup();
  };

  process.on("exit", cleanupOnce);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cleanupOnce();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}
