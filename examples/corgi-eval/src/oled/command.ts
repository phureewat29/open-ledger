import { spawn } from "node:child_process";

/**
 * The only module in the walkthrough that starts a process. A non-zero exit is
 * data (`CommandOk.exitCode`), not a failure — the harness has to score it.
 * A failure is reserved for a command that never ran or never finished.
 */

export interface CommandOk {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Callers read `kind` to tell a command that never started from one that hung. */
export interface CommandFailure {
  ok: false;
  reason: "spawn_failed" | "timeout";
  message: string;
}

export type CommandResult = { ok: true; value: CommandOk } | CommandFailure;

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
}

export function execCapture(
  command: string,
  argv: string[],
  opts: ExecOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    const done = (): void => {
      if (timer) clearTimeout(timer);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      done();
      resolve({ ok: false, reason: "spawn_failed", message: err.message });
    });

    child.on("close", (code) => {
      done();
      if (timedOut) {
        resolve({ ok: false, reason: "timeout", message: `${command} exceeded ${opts.timeoutMs}ms` });
        return;
      }
      resolve({ ok: true, value: { argv, exitCode: code ?? 1, stdout, stderr } });
    });

    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

export interface OpenLedgerRunner {
  run(argv: string[], opts?: { stdin?: string }): Promise<CommandResult>;
}

export function createOpenLedgerRunner(args: {
  bin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
}): OpenLedgerRunner {
  return {
    run: (argv, opts = {}) =>
      execCapture(args.bin, argv, {
        cwd: args.cwd,
        env: args.env,
        timeoutMs: args.timeoutMs,
        ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
      }),
  };
}
