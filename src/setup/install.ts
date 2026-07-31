import { createRequire } from "module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { DEFAULT_SKILLS_DIR, SKILL_PACK_DIR } from "./locations.js";

/** Every target receives the checked-in skills/SKILL.md verbatim: no templating, no per-agent wrapper. */

interface InstalledTarget {
  path: string;
  version: string;
}

export interface InstallOptions {
  /** Install under the home skills dir rather than the cwd. */
  global?: boolean;
  /** The skills directory to install into; the pack lands at <dir>/openledger. */
  dir?: string;
  /** Overwrite an installed skill dir whose VERSION differs. */
  force?: boolean;
}

/** Thrown when an installed skill dir is at a DIFFERENT version and --force wasn't given;
 *  the CLI maps this to exit code INVALID with a --force hint. */
export class SkillPackVersionError extends Error {
  readonly installedVersion: string;
  readonly cliVersion: string;
  readonly path: string;
  constructor(args: { installedVersion: string; cliVersion: string; path: string }) {
    super(
      `skill pack already installed at ${args.path} (version ${args.installedVersion}); ` +
        `this CLI is ${args.cliVersion}`,
    );
    this.name = "SkillPackVersionError";
    this.installedVersion = args.installedVersion;
    this.cliVersion = args.cliVersion;
    this.path = args.path;
  }
}

// Compiles to dist/setup/install.js; ../../package.json is the package root from there (same depth as src/cli/index.ts).
const require = createRequire(import.meta.url);

export function getVersion(): string {
  const { version } = require("../../package.json") as { version: string };
  return version;
}

export function skillMd(): string {
  return readFileSync(new URL("../../skills/SKILL.md", import.meta.url), "utf8");
}

// Result is always <skills dir>/openledger; --dir names the skills dir directly, else home or cwd's default.
function resolveTarget(opts: InstallOptions): string {
  const base = opts.dir
    ? resolve(opts.dir)
    : resolve(opts.global ? homedir() : process.cwd(), DEFAULT_SKILLS_DIR);
  return join(base, SKILL_PACK_DIR);
}

function readVersionFile(skillDir: string): string | null {
  const versionPath = join(skillDir, "VERSION");
  if (!existsSync(versionPath)) return null;
  return readFileSync(versionPath, "utf8").trim();
}

/** Idempotent at the same version; throws SkillPackVersionError on a clash without --force. */
export function installSkill(opts: InstallOptions = {}): InstalledTarget {
  const version = getVersion();
  const dir = resolveTarget(opts);

  const existing = readVersionFile(dir);
  if (existing !== null && existing !== version && !opts.force) {
    throw new SkillPackVersionError({ installedVersion: existing, cliVersion: version, path: dir });
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd());
  writeFileSync(join(dir, "VERSION"), version + "\n");

  return { path: dir, version };
}
