import { createRequire } from "module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { findHost, DEFAULT_HOST } from "./hosts.js";

/** Every host receives the checked-in skills/SKILL.md verbatim: no templating, no per-host wrapper. */

interface InstalledTarget {
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
  /** Explicit base dir: the pack lands at <dir>/skills/open-ledger, ignoring the host. */
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

// install.ts compiles to dist/setup/install.js; ../../package.json from there is
// the package root (same 2-level depth as src/cli/index.ts uses).
const require = createRequire(import.meta.url);

export function getVersion(): string {
  const { version } = require("../../package.json") as { version: string };
  return version;
}

export function skillMd(): string {
  return readFileSync(new URL("../../skills/SKILL.md", import.meta.url), "utf8");
}

// --dir D is host-agnostic: resolve(D)/skills/open-ledger. Otherwise <cwd or
// home>/<host skills dir>/open-ledger (the host dir already ends in skills).
function resolveTarget(opts: InstallOptions): { kind: string; dir: string } {
  if (opts.dir) {
    return { kind: "dir", dir: join(resolve(opts.dir), "skills", "open-ledger") };
  }
  const host = findHost(opts.host ?? DEFAULT_HOST);
  if (!host) throw new Error(`unknown skill host: ${opts.host}`);
  const base = opts.global ? host.globalDir() : resolve(process.cwd(), host.projectDir);
  return { kind: host.id, dir: join(base, "open-ledger") };
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

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd());
  writeFileSync(join(dir, "VERSION"), version + "\n");

  return { kind, path: dir, version };
}
