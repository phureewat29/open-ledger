import { existsSync } from "node:fs";
import { join } from "node:path";
import { tryExecute, type Result } from "../core/result.js";
import { execCapture } from "../oled/command.js";

/** Packs and `npm install --global`s a tarball so the walkthrough scores the published artifact, not the checkout's source tree. */

export interface InstalledCli {
  binPath: string;
  version: string;
  tarball: string;
  fileCount: number;
}

interface PackEntry {
  name: string;
  version: string;
  filename: string;
  files?: unknown[];
}

const INSTALL_TIMEOUT_MS = 300_000;

function parsePackJson(stdout: string): Result<PackEntry> {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end < start) {
    return { ok: false, error: "npm pack --json printed no JSON array" };
  }
  const parsed = tryExecute(() => JSON.parse(stdout.slice(start, end + 1)) as PackEntry[]);
  if (!parsed.ok) return { ok: false, error: `npm pack --json was unreadable: ${parsed.error}` };

  const entry = parsed.value[0];
  if (!entry?.filename) return { ok: false, error: "npm pack --json listed no tarball" };
  return { ok: true, value: entry };
}

async function pack(repoRoot: string, destination: string): Promise<Result<PackEntry>> {
  const packed = await execCapture("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: repoRoot,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (!packed.ok) return { ok: false, error: `npm pack failed: ${packed.message}` };
  if (packed.value.exitCode !== 0) {
    return {
      ok: false,
      error: `npm pack exited ${packed.value.exitCode}: ${packed.value.stderr.trim()}`,
    };
  }
  return parsePackJson(packed.value.stdout);
}

/** dist/ is what the tarball ships — a missing build fails here instead of surfacing as a broken CLI mid-run. */
export async function installPackedCli(args: {
  repoRoot: string;
  tarballDir: string;
  prefix: string;
}): Promise<Result<InstalledCli>> {
  if (!existsSync(join(args.repoRoot, "dist", "cli", "index.js"))) {
    return {
      ok: false,
      error: `no dist/cli/index.js in ${args.repoRoot} — run \`npm run build\` there first`,
    };
  }

  const packed = await pack(args.repoRoot, args.tarballDir);
  if (!packed.ok) return packed;

  const entry = packed.value;
  const tarball = join(args.tarballDir, entry.filename);
  const installed = await execCapture(
    "npm",
    ["install", "--global", "--prefix", args.prefix, tarball],
    { cwd: args.tarballDir, timeoutMs: INSTALL_TIMEOUT_MS },
  );
  if (!installed.ok) return { ok: false, error: `npm install failed: ${installed.message}` };
  if (installed.value.exitCode !== 0) {
    return {
      ok: false,
      error: `npm install exited ${installed.value.exitCode}: ${installed.value.stderr.trim()}`,
    };
  }

  const binPath = join(args.prefix, "bin", "oled");
  if (!existsSync(binPath)) return { ok: false, error: `no oled binary at ${binPath}` };
  return {
    ok: true,
    value: {
      binPath,
      version: entry.version,
      tarball,
      fileCount: entry.files?.length ?? 0,
    },
  };
}
