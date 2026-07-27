/**
 * corgi-claude demo entry point.
 *
 * An external `claude` CLI agent works end to end with OpenLedger over a real,
 * password-protected Thai credit-card statement, using only the documented
 * `oled` CLI surface. See README.md for the full story.
 *
 * Usage:
 *   npm start --                          full demo (requires the `claude` CLI)
 *   npm start -- --skip-claude            plumbing-only check, no `claude` required
 *   npm start -- --keep-workspace         leave the isolated workspace on disk
 *   npm start -- --turn-timeout <seconds> per-turn timeout (default 900)
 *
 * TTY stdout gets the live ink dashboard (ui.tsx); piped/non-TTY stdout gets
 * flat, sequential plain-text lines (reporters.ts). Both run the same runDemo
 * orchestration (orchestrate.ts) - only how Reporter callbacks render differs.
 * This file just parses args, picks the renderer, and wires cleanup.
 */
import { parseArgs, USAGE } from "./args.js";
import { runPlain } from "./reporters.js";
import { runTty } from "./ui.js";
import { cleanupWorkspace, type WorkspacePaths } from "./workspace.js";
import type { DemoOptions } from "./orchestrate.js";

interface WorkspaceGuard {
  /** Register the run's workspace so it's cleaned up on exit (unless kept).
   *  Passed to runDemo as onWorkspaceReady; fires once the dir exists. */
  register(paths: WorkspacePaths): void;
  keepWorkspace: boolean;
}

/**
 * Owns workspace cleanup: installs exit/SIGINT/SIGTERM handlers once, removes
 * the registered workspace on exit unless --keep-workspace was passed, and
 * prints the kept path on a signal. Nothing to clean until register() runs.
 */
function createWorkspaceGuard(keepWorkspace: boolean): WorkspaceGuard {
  let paths: WorkspacePaths | null = null;
  let cleanedUp = false;

  const cleanupOnce = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (paths && !keepWorkspace) cleanupWorkspace(paths);
  };

  process.on("exit", cleanupOnce);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (keepWorkspace && paths) {
        process.stderr.write(`\nworkspace kept at ${paths.root}\n`);
      }
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }

  return {
    register(p) {
      paths = p;
    },
    keepWorkspace,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.unknown.length > 0) {
    process.stderr.write(`unknown argument(s): ${args.unknown.join(" ")}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const guard = createWorkspaceGuard(args.keepWorkspace);
  const opts: DemoOptions = { skipClaude: args.skipClaude, turnTimeoutSec: args.turnTimeoutSec };

  const code = process.stdout.isTTY
    ? await runTty(opts, guard.register, guard.keepWorkspace)
    : await runPlain(opts, guard.register, guard.keepWorkspace);
  process.exitCode = code;
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
