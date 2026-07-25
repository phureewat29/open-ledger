import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import chalk from "chalk";
import type { Command } from "commander";
import { getDataDir } from "../../config.js";
import { currentMode, emit, runAction } from "../output.js";

function openerCommand(): string | null {
  switch (process.platform) {
    case "darwin": return "open";
    case "win32":  return "explorer";
    case "linux":  return "xdg-open";
    default:       return null;
  }
}

/**
 * Spawns the OS file-manager opener, detached. Never rejects: resolves with
 * an error message on spawn failure (e.g. missing binary), else undefined.
 */
function spawnOpener(cmd: string, dataDir: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, [dataDir], { stdio: "ignore", detached: true });
    child.once("error", (err: Error) => resolvePromise(err.message));
    child.once("spawn", () => resolvePromise(undefined));
    child.unref();
  });
}

/**
 * Opens the data folder in the OS file explorer. `--json` emits
 * `{"path": <dataDir>}` (plus `spawn_error` on failure); piped emits a bare
 * path. An opener failure is reported, never thrown — the path is still useful.
 */
async function openDataDir(): Promise<void> {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const cmd = openerCommand();
  const spawnError = cmd
    ? await spawnOpener(cmd, dataDir)
    : `don't know how to open the file manager on ${process.platform}`;

  const mode = currentMode();
  if (mode.json) {
    const result: { path: string; spawn_error?: string } = { path: dataDir };
    if (spawnError) result.spawn_error = spawnError;
    emit(result);
    return;
  }

  if (!mode.tty) {
    process.stdout.write(dataDir + "\n");
    return;
  }

  console.log(chalk.dim(`Data folder: ${dataDir}`));
  if (spawnError) {
    console.log(
      chalk.yellow(`Couldn't open the folder automatically: ${spawnError}. Open it manually with the path above.`),
    );
  }
}

export function registerData(program: Command): void {
  // `data` opens the OS file explorer at the data dir; a thin, db-free command.
  program
    .command("data")
    .alias("open")
    .description("Open the data folder in file explorer")
    .action(runAction(openDataDir));
}
