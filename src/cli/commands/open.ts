import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import chalk from "chalk";
import type { Command } from "commander";
import { requireConfig } from "./config.js";
import { currentMode, emit, runAction } from "../output.js";

const OPENERS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "open",
  win32: "explorer",
  linux: "xdg-open",
};

function openerCommand(): string | null {
  return OPENERS[process.platform] ?? null;
}

// Never rejects: resolves with an error message on spawn failure, else undefined.
function spawnOpener(cmd: string, dataDir: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, [dataDir], { stdio: "ignore", detached: true });
    child.once("error", (err: Error) => resolvePromise(err.message));
    child.once("spawn", () => resolvePromise(undefined));
    child.unref();
  });
}

// The path is reported even when the opener fails: it is still useful on its own.
async function openDataDir(_opts: Record<string, unknown>, command: Command): Promise<void> {
  const dataDir = requireConfig(command).dataDir;
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

export function registerOpen(program: Command): void {
  program
    .command("open")
    .description("Open the data folder in file explorer")
    .action(runAction(openDataDir));
}
