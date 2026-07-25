import { Command, Help } from "commander";
import { createRequire } from "module";
import { config } from "../config.js";
import { helpScreen } from "./format.js";
import { runAction } from "./output.js";

// Harness command modules. Each registers its own noun + subcommand tree.
import { registerStatus, showStatus } from "./commands/status.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerSetup } from "./commands/setup.js";
import { registerConfig } from "./commands/config.js";
import { registerIngest } from "./commands/ingest.js";
import { registerFiles } from "./commands/files.js";
import { registerVault } from "./commands/vault.js";
import { registerTransactions } from "./commands/transactions.js";
import { registerAccounts } from "./commands/accounts.js";
import { registerMerchants } from "./commands/merchants.js";
import { registerQuestions } from "./commands/questions.js";
import { registerReport } from "./commands/report.js";
import { registerNotes } from "./commands/notes.js";
import { registerDatasets } from "./commands/datasets.js";
import { registerData } from "./commands/data.js";

export const COMMANDS = [
  { name: "status", desc: "Status: config, database, ledger counts, net worth (default)" },
  { name: "doctor", desc: "Diagnose the harness environment" },
  { name: "setup", desc: "Install the skill for an agent CLI (--host <id> | --dir <path>)" },
  { name: "config", desc: "Configuration" },
  { name: "ingest", desc: "Ingest pipeline: list / prepare / commit / done / fail" },
  { name: "files", desc: "Browse ingested files (list / show / drop)" },
  { name: "vault", desc: "Manage file-password patterns for encrypted statements" },
  { name: "transactions", desc: "Transactions: list / show / add / update / delete / recategorize / dedupe" },
  { name: "accounts", desc: "Manage the chart of accounts" },
  { name: "merchants", desc: "Manage merchants and their default accounts" },
  { name: "questions", desc: "List, answer, and defer open questions" },
  { name: "report", desc: "Income, expenses, and net" },
  { name: "notes", desc: "Manage freeform notes" },
  { name: "datasets", desc: "Reference datasets" },
  { name: "data", desc: "Open the data folder in file explorer (alias: open)" },
];

const GLOBAL_OPTIONS = [
  { name: "--json", desc: "Emit NDJSON (machine-readable) instead of human output" },
  { name: "--no-color", desc: "Disable ANSI color output" },
];

/** Builds the full commander program. Pure construction — never parses argv
 *  or executes an action; callers own `.parse()` / `.parseAsync()`. */
export function buildProgram(): Command {
  const require = createRequire(import.meta.url);
  const { version } = require("../../package.json");

  const program = new Command();

  // Required so a command with BOTH a bare action and subcommands (config)
  // dispatches the subcommand instead of swallowing its options into the bare action.
  program.enablePositionalOptions();

  program
    .name("plasalid")
    .description("The Harness Layer for Personal Finance")
    .version(version)
    .addHelpCommand(false)
    .showHelpAfterError("Run `plasalid --help` for the list of commands.")
    // Bare `plasalid` reports harness status (same implementation as `status`).
    .action(
      runAction(async () => {
        await showStatus();
      }),
    );

  registerData(program);
  registerStatus(program);
  registerDoctor(program);
  registerSetup(program);
  registerConfig(program);
  registerIngest(program);
  registerFiles(program);
  registerVault(program);
  registerTransactions(program);
  registerAccounts(program);
  registerMerchants(program);
  registerQuestions(program);
  registerReport(program);
  registerNotes(program);
  registerDatasets(program);

  // On every command so --json/--no-color work before or after the subcommand
  // name; getOutputMode() OR-walks the chain to find them wherever they land.
  function addGlobalOptions(cmd: Command): void {
    cmd
      .option("--json", "Emit NDJSON (machine-readable) instead of human output")
      .option("--no-color", "Disable ANSI color output");
    for (const sub of cmd.commands) addGlobalOptions(sub);
  }
  addGlobalOptions(program);

  program.configureHelp({
    // configureHelp is inherited by subcommands, so guard explicitly: only the
    // root gets the branded screen; subcommands keep commander's default formatter.
    formatHelp: (cmd, helper) =>
      cmd === program
        ? helpScreen(COMMANDS, GLOBAL_OPTIONS)
        : Help.prototype.formatHelp.call(helper, cmd, helper),
  });

  void config; // keep config import live so dotenv loads
  return program;
}
