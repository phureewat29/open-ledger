import { chmodSync } from "node:fs";

/**
 * Owner-only mode on the files that hold financial data and secrets.
 * Windows has no POSIX modes, and a sidecar that never materialized (a WAL on a filesystem
 * that refused it) is not a permission problem — a refusal to set the mode is, so it throws.
 */
export function chmod600(path: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
