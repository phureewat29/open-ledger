import type { Command } from "commander";
import { currentMode, emit, fail, runAction } from "../output.js";
import {
  installSkill,
  skillMd,
  SkillPackVersionError,
  type InstallOptions,
} from "../../setup/install.js";
import { DEFAULT_SKILLS_DIR } from "../../setup/locations.js";

interface SetupOpts {
  global?: boolean;
  dir?: string;
  force?: boolean;
  print?: boolean;
}

async function setupSkill(opts: SetupOpts): Promise<void> {
  // --print dumps SKILL.md as raw markdown (not NDJSON) even when --json is set.
  if (opts.print) {
    const md = skillMd();
    process.stdout.write(md);
    if (!md.endsWith("\n")) process.stdout.write("\n");
    return;
  }

  if (opts.global && opts.dir) {
    fail("USAGE", "--global and --dir are mutually exclusive", {
      hint: "pass --dir with the exact skills directory, or --global for ~/.agents/skills",
    });
  }

  const installOpts: InstallOptions = {
    global: opts.global,
    dir: opts.dir,
    force: opts.force,
  };

  let target;
  try {
    target = installSkill(installOpts);
  } catch (err) {
    if (err instanceof SkillPackVersionError) {
      fail("INVALID", err.message, {
        hint: "re-run with --force to overwrite the installed skill pack",
        details: {
          installed_version: err.installedVersion,
          cli_version: err.cliVersion,
          path: err.path,
        },
      });
    }
    throw err;
  }

  const mode = currentMode();
  if (mode.json) {
    emit({ installed: [target] });
  } else {
    process.stdout.write(`${target.path}\t${target.version}\n`);
  }
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Install the skill for an agent CLI")
    .option("--global", `install under ~/${DEFAULT_SKILLS_DIR} instead of the cwd`)
    .option("--dir <path>", "skills directory to install into; the pack lands at <path>/openledger")
    .option("--force", "overwrite an installed skill dir whose version differs")
    .option("--print", "print SKILL.md to stdout as raw markdown and exit (ignores --json)")
    .action(runAction(setupSkill));
}
