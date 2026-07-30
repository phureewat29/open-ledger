import { defineConfig } from "vitest/config";

/**
 * The end-to-end suite: it spawns `dist/cli/index.js`, so `globalSetup` builds
 * once before any case runs. Kept out of `vitest.config.ts` so `npm test` stays
 * source-only and pays no build.
 */
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    globalSetup: ["./e2e/build.setup.ts"],
    // Every case is a subprocess; no single one should need a per-test override.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // A release gate reads better as one ordered log than as two interleaved ones.
    fileParallelism: false,
  },
});
