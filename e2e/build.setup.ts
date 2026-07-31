import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { distEntry, repoRoot } from "../fixtures/sandbox.js";

// These suites assert on the published artifact, so dist/ must match the working tree first.
// vitest awaits globalSetup before the first spec, so nothing reads dist/ while the build replaces it.
export function setup(): void {
  if (process.env.OLED_E2E_SKIP_BUILD === "1") {
    if (!existsSync(distEntry)) {
      throw new Error(
        `OLED_E2E_SKIP_BUILD=1 but ${distEntry} is missing: run \`npm run build\` first`,
      );
    }
    return;
  }

  const built = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (built.status === 0) return;
  const how = built.status === null ? `signal ${built.signal}` : `exit ${built.status}`;
  throw new Error(`e2e: npm run build failed (${how})`);
}
