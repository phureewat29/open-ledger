import type { Command } from "commander";
import { currentMode, emit, fail, runAction } from "../output.js";
import {
  installSkill,
  skillMd,
  SkillPackVersionError,
  type InstallOptions,
} from "../../setup/install.js";
import { SKILL_HOSTS, findHost, DEFAULT_HOST } from "../../setup/hosts.js";

interface SetupOpts {
  host?: string;
  global?: boolean;
  dir?: string;
  force?: boolean;
  print?: boolean;
}

function hostIds(): string {
  return SKILL_HOSTS.map((h) => h.id).join(", ");
}

async function setupSkill(opts: SetupOpts): Promise<void> {
  // --print dumps SKILL.md as raw markdown (not NDJSON) even when --json is set.
  if (opts.print) {
    const md = skillMd();
    process.stdout.write(md);
    if (!md.endsWith("\n")) process.stdout.write("\n");
    return;
  }

  const host = opts.host ?? DEFAULT_HOST;
  if (!findHost(host)) {
    fail("USAGE", `unknown --host ${host}`, { hint: `known hosts: ${hostIds()}` });
  }

  const installOpts: InstallOptions = {
    host,
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
    process.stdout.write(`${target.kind}\t${target.path}\t${target.version}\n`);
  }
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Install the skill for an agent CLI")
    .option("--host <id>", `target agent host: ${hostIds()}`, DEFAULT_HOST)
    .option("--global", "install under the host's home skills dir instead of the cwd")
    .option("--dir <path>", "override the install base directory")
    .option("--force", "overwrite an installed skill dir whose version differs")
    .option("--print", "print SKILL.md to stdout as raw markdown and exit (ignores --json)")
    .action(runAction(setupSkill));
}
