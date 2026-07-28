/**
 * corgi-claude demo entry point.
 *
 * An external `claude` CLI agent works end to end with OpenLedger over a
 * synthetic, password-protected credit-card statement, using only the
 * documented `oled` CLI surface. See README.md for the full story.
 *
 * Usage:
 *   npm start --                          full demo (requires the `claude` CLI)
 *   npm start -- --skip-claude            plumbing-only check, no `claude` required
 *   npm start -- --keep-workspace         leave the isolated workspace on disk
 *   npm start -- --turn-timeout <seconds> per-turn timeout (default 900)
 *
 * Output is flat, sequential plain text (reporters.ts) whether stdout is a
 * terminal or a pipe. This file just parses args, wires cleanup, and hands off
 * to the orchestration (orchestrate.ts).
 */
import { parseArgs, USAGE } from "./args.js";
import { runPlain } from "./reporters.js";
import { cleanupWorkspace, type WorkspacePaths } from "./workspace.js";
import type { DemoOptions } from "./orchestrate.js";

/**
 * Installs exit/SIGINT/SIGTERM handlers once and returns the hook that arms
 * them: there is nothing to clean up until the workspace exists. On exit the
 * registered workspace is removed unless --keep-workspace was passed, in which
 * case a signal prints the kept path instead.
 */
function createWorkspaceGuard(keepWorkspace: boolean): (paths: WorkspacePaths) => void {
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

  return (p) => {
    paths = p;
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

  const onWorkspaceReady = createWorkspaceGuard(args.keepWorkspace);
  const opts: DemoOptions = { skipClaude: args.skipClaude, turnTimeoutSec: args.turnTimeoutSec };
  process.exitCode = await runPlain(opts, onWorkspaceReady, args.keepWorkspace);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
