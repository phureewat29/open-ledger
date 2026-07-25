import { createRequire } from "module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { findHost, DEFAULT_HOST } from "./hosts.js";

/**
 * Filesystem installer for the skill pack. Every host receives the checked-in
 * skills/SKILL.md verbatim; no templating, no per-host wrapper.
 */

export interface InstalledTarget {
  /** The host id it landed under, or "dir" for an explicit --dir install. */
  kind: string;
  path: string;
  version: string;
}

export interface InstallOptions {
  /** Target host id; defaults to DEFAULT_HOST. */
  host?: string;
  /** Install under the host's home skills dir rather than the cwd. */
  global?: boolean;
  /** Explicit base dir: the pack lands at <dir>/skills/plasalid, ignoring the host. */
  dir?: string;
  /** Overwrite an installed skill dir whose VERSION differs. */
  force?: boolean;
}

/**
 * Thrown when a skill dir already exists at a DIFFERENT version and --force was
 * not given. The CLI maps this to exit code INVALID with a --force hint.
 */
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

// install.ts compiles to dist/setup/install.js; ../../package.json from
// there is the package root (same 2-level depth as src/cli/index.ts uses).
const require = createRequire(import.meta.url);

/** The CLI/package version the installed pack should be stamped with. */
export function getVersion(): string {
  const { version } = require("../../package.json") as { version: string };
  return version;
}

/** The canonical checked-in skill document (skills/SKILL.md at the package root). */
export function skillMd(): string {
  return readFileSync(new URL("../../skills/SKILL.md", import.meta.url), "utf8");
}

/**
 * The final `plasalid` skill dir for the given options.
 *   --dir D  → resolve(D)/skills/plasalid  (host-agnostic; D is a bare base)
 *   host     → <cwd or home>/<host skills dir>/plasalid  (the dir already ends in skills)
 */
function resolveTarget(opts: InstallOptions): { kind: string; dir: string } {
  if (opts.dir) {
    return { kind: "dir", dir: join(resolve(opts.dir), "skills", "plasalid") };
  }
  const host = findHost(opts.host ?? DEFAULT_HOST);
  if (!host) throw new Error(`unknown skill host: ${opts.host}`);
  const base = opts.global ? host.globalDir() : resolve(process.cwd(), host.projectDir);
  return { kind: host.id, dir: join(base, "plasalid") };
}

function readVersionFile(skillDir: string): string | null {
  const versionPath = join(skillDir, "VERSION");
  if (!existsSync(versionPath)) return null;
  return readFileSync(versionPath, "utf8").trim();
}

/** Idempotent at the same version; throws SkillPackVersionError on a clash without --force. */
export function installSkill(opts: InstallOptions = {}): InstalledTarget {
  const version = getVersion();
  const { kind, dir } = resolveTarget(opts);

  const existing = readVersionFile(dir);
  if (existing !== null && existing !== version && !opts.force) {
    throw new SkillPackVersionError({ installedVersion: existing, cliVersion: version, path: dir });
  }
  // existing === version -> silent idempotent overwrite; different + force -> overwrite.

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd());
  writeFileSync(join(dir, "VERSION"), version + "\n");

  return { kind, path: dir, version };
}
