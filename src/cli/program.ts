import { Command, Help, type CommanderError } from "commander";
import { createRequire } from "module";
// Side-effect import: loads .env and resolves the config singleton first.
import "../config.js";
import { helpScreen } from "./format.js";
import { fail, jsonRequested, runAction } from "./output.js";

import { registerStatus, showStatus } from "./commands/status.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerSetup } from "./commands/setup.js";
import { registerConfig } from "./commands/config.js";
import { registerIngest } from "./commands/ingest.js";
import { registerFiles } from "./commands/files.js";
import { registerTransactions } from "./commands/transactions.js";
import { registerAccounts } from "./commands/accounts.js";
import { registerMerchants } from "./commands/merchants.js";
import { registerQuestions } from "./commands/questions.js";
import { registerReport } from "./commands/report.js";
import { registerNotes } from "./commands/notes.js";
import { registerDatasets } from "./commands/datasets.js";
import { registerOpen } from "./commands/open.js";

export const COMMANDS = [
  { name: "status", desc: "Status: config, database, ledger counts, net worth (default)" },
  { name: "doctor", desc: "Diagnose the harness environment" },
  { name: "setup", desc: "Install the skill for an agent CLI (--dir <path>)" },
  { name: "config", desc: "Configuration" },
  { name: "ingest", desc: "Ingest pipeline: list / prepare / commit / done / fail" },
  { name: "files", desc: "Browse ingested files (list / show / drop)" },
  { name: "transactions", desc: "Transactions: list / show / add / update / delete / recategorize / dedupe / merge" },
  { name: "accounts", desc: "Manage the chart of accounts" },
  { name: "merchants", desc: "Manage merchants and their default accounts" },
  { name: "questions", desc: "List, answer, and defer open questions" },
  { name: "report", desc: "Income, expenses, and net" },
  { name: "notes", desc: "Manage freeform notes" },
  { name: "datasets", desc: "Reference datasets" },
  { name: "open", desc: "Open the data folder in file explorer" },
];

const GLOBAL_OPTIONS = [
  { name: "--json", desc: "Emit NDJSON (machine-readable) instead of human output" },
  { name: "--no-color", desc: "Disable ANSI color output" },
];

/** `oled ingest list` for a leaf, `oled` for the root: the command whose help answers the error. */
function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

/**
 * Parse failures never reach runAction, so they are mapped onto the same error
 * contract here — USAGE, with the erroring command's own help as the hint.
 * --help and --version already printed and keep their exit code.
 */
function parseFailureHandler(cmd: Command): (err: CommanderError) => void {
  return (err) => {
    if (err.exitCode === 0) return;
    // A noun reached without a verb: commander printed the noun's help screen,
    // which is the answer for a human. --json promised one error line instead.
    if (err.code === "commander.help") {
      if (!jsonRequested()) return;
      fail("USAGE", `${commandPath(cmd)} needs a subcommand`, {
        hint: `one of: ${cmd.commands.map((sub) => sub.name()).join(", ")}`,
      });
    }
    // The root takes no positional argument, so a stray one is a mistyped command.
    if (err.code === "commander.excessArguments" && !cmd.parent) {
      fail("USAGE", `unknown command '${cmd.args[0]}'`, {
        hint: "run `oled --help` for the list of commands",
      });
    }
    fail("USAGE", err.message.replace(/^error:\s*/, ""), {
      hint: `run \`${commandPath(cmd)} --help\` for its flags and usage`,
    });
  };
}

/** Builds the full commander program: pure construction — callers own `.parse()` / `.parseAsync()`. */
export function buildProgram(): Command {
  const require = createRequire(import.meta.url);
  const { version } = require("../../package.json");

  const program = new Command();

  // Required so a command with BOTH a bare action and subcommands (config)
  // dispatches the subcommand instead of swallowing its options into the bare action.
  program.enablePositionalOptions();

  program
    .name("oled")
    .description("The Harness Layer for Personal Finance")
    .version(version)
    .addHelpCommand(false)
    // Bare `oled` reports harness status — the same action as `status`, which
    // redacts by default; `oled status --no-redact` is the way to opt out.
    .action(runAction(showStatus));

  registerOpen(program);
  registerStatus(program);
  registerDoctor(program);
  registerSetup(program);
  registerConfig(program);
  registerIngest(program);
  registerFiles(program);
  registerTransactions(program);
  registerAccounts(program);
  registerMerchants(program);
  registerQuestions(program);
  registerReport(program);
  registerNotes(program);
  registerDatasets(program);

  // --json/--no-color on every command so they work before or after the
  // subcommand name (getOutputMode() OR-walks the chain to find them), and an
  // exit override per command so a parse failure names its own help.
  function configureEveryLevel(cmd: Command): void {
    cmd
      .option("--json", "Emit NDJSON (machine-readable) instead of human output")
      .option("--no-color", "Disable ANSI color output")
      .exitOverride(parseFailureHandler(cmd))
      // Commander writes its own plain-text error line, and a help screen for a
      // verbless noun, before exiting; under --json the CliError contract is the
      // only thing allowed on stderr.
      .configureOutput({
        outputError: () => {},
        writeErr: (str) => {
          if (!jsonRequested()) process.stderr.write(str);
        },
      });
    for (const sub of cmd.commands) configureEveryLevel(sub);
  }
  configureEveryLevel(program);

  program.configureHelp({
    // configureHelp is inherited by subcommands, so guard explicitly: only the
    // root gets the branded screen; subcommands keep commander's default formatter.
    formatHelp: (cmd, helper) =>
      cmd === program
        ? helpScreen(COMMANDS, GLOBAL_OPTIONS)
        : Help.prototype.formatHelp.call(helper, cmd, helper),
  });

  return program;
}
