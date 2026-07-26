/**
 * CLI argument parsing for the corgi-claude demo: --skip-claude,
 * --keep-workspace, --turn-timeout <seconds>, and -h/--help. Pure - no I/O and
 * no process access; main() reads process.argv and acts on the result.
 */

/** Default per-turn timeout (seconds) when --turn-timeout isn't passed. Lives
 *  here because it's a CLI default; claude-stream always receives an explicit
 *  value (see runClaudeTurn's required turnTimeoutSec). */
export const DEFAULT_TURN_TIMEOUT_SEC = 900;

export const USAGE = `usage: npm start -- [--skip-claude] [--keep-workspace] [--turn-timeout <seconds>]

  --skip-claude      skip the live "claude -p" turns; only check that the
                     ingest pipeline discovers the statement (no claude CLI
                     required)
  --keep-workspace   do not delete the isolated workspace on exit; prints
                     its path instead
  --turn-timeout <seconds>
                     kill a "claude -p" turn (SIGTERM, then SIGKILL 5s later
                     if still alive) if it runs longer than this. Default:
                     ${DEFAULT_TURN_TIMEOUT_SEC}
  -h, --help         show this help text
`;

export interface CliArgs {
  skipClaude: boolean;
  keepWorkspace: boolean;
  turnTimeoutSec: number;
  help: boolean;
  unknown: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    skipClaude: false,
    keepWorkspace: false,
    turnTimeoutSec: DEFAULT_TURN_TIMEOUT_SEC,
    help: false,
    unknown: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip-claude") {
      args.skipClaude = true;
    } else if (arg === "--keep-workspace") {
      args.keepWorkspace = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--turn-timeout") {
      const raw = argv[i + 1];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        args.unknown.push(raw === undefined ? arg : `${arg} ${raw}`);
        if (raw !== undefined) i++; // consume the bad value so it isn't also flagged on its own
      } else {
        args.turnTimeoutSec = parsed;
        i++; // consume the value
      }
    } else {
      args.unknown.push(arg);
    }
  }
  return args;
}
