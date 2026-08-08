import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), "oled-config-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig hardening", () => {
  it("parses a config.json carrying a UTF-8 BOM (Windows editors and redirects)", () => {
    const path = resolve(dir, "bom.json");
    writeFileSync(path, "\uFEFF" + JSON.stringify({ displayCurrency: "USD" }));
    const { config, problem } = loadConfig(path);
    expect(problem).toBeNull();
    expect(config.displayCurrency).toBe("USD");
  });

  it("expands `~/` in persisted path fields instead of resolving them under the cwd", () => {
    const path = resolve(dir, "tilde.json");
    writeFileSync(path, JSON.stringify({ dataDir: "~/statements" }));
    const { config } = loadConfig(path);
    expect(config.dataDir).toBe(resolve(homedir(), "statements"));
  });
});
