import "dotenv/config";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "fs";
import { createHash } from "crypto";
import { resolve } from "path";
import { homedir } from "os";

export interface OpenLedgerConfig {
  displayLocale: string;
  displayCurrency: string;
  dbPath: string;
  dbEncryptionKey: string;
  dataDir: string;
  userName: string;
}

const OLED_DIR = process.env.OLED_DIR
  ? resolve(process.env.OLED_DIR)
  : resolve(homedir(), ".oled");

/**
 * Drives both field resolution and the persisted-key list: `envVar` (when
 * present) is checked before the file value. Unknown keys on disk are
 * tolerated on read and dropped on the next write — saveConfig writes only
 * the fields listed here.
 */
const CONFIG_FIELDS: Record<keyof OpenLedgerConfig, { envVar?: string; default: string }> = {
  // Single last-resort locale/currency constants for the whole codebase,
  // overridden by `config converge`. Every other module reads the resolved
  // config value (or getDisplayCurrency) rather than hardcoding a currency.
  // A later wave seeds these from the active dataset.
  displayLocale: { default: "th-TH" },
  displayCurrency: { default: "THB" },
  dbPath: { envVar: "OLED_DB_PATH", default: resolve(OLED_DIR, "db.sqlite") },
  dbEncryptionKey: { envVar: "OLED_DB_ENCRYPTION_KEY", default: "" },
  dataDir: { envVar: "OLED_DATA_DIR", default: resolve(OLED_DIR, "data") },
  userName: { default: "User" },
};

const CONFIG_KEYS = Object.keys(CONFIG_FIELDS) as readonly (keyof OpenLedgerConfig)[];

export function getOledDir(): string {
  return OLED_DIR;
}

export function getConfigPath(): string {
  return resolve(OLED_DIR, "config.json");
}

export function getDataDir(): string {
  return config.dataDir;
}

/** Scratch space for decrypted/rasterized artifacts; env-overridable for tests. */
export function getCacheDir(): string {
  return process.env.OLED_CACHE_DIR || resolve(OLED_DIR, "cache");
}

/** Non-reversible fingerprint (`sha256:` + first 8 hex) so `config`/`status`
 *  can prove a key is set without ever printing the passphrase. */
export function keyFingerprint(key: string): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

function loadFileConfig(): Partial<OpenLedgerConfig> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // Intentional swallow: this runs at module load (via buildConfig) and from
    // saveConfig. A corrupt config file must degrade to defaults rather than
    // throw — otherwise every command, including the `config` commands that
    // would repair it, would crash on startup.
    return {};
  }
}

/** Project an arbitrary object down to just the surviving config keys. */
function pickConfigFields(obj: Record<string, unknown>): Partial<OpenLedgerConfig> {
  const out: Partial<OpenLedgerConfig> = {};
  for (const key of CONFIG_KEYS) {
    if (obj[key] !== undefined) (out as Record<string, unknown>)[key] = obj[key];
  }
  return out;
}

function buildConfig(): OpenLedgerConfig {
  const file = loadFileConfig();
  const out = {} as OpenLedgerConfig;
  // Precedence env > file > default. `||` (not `??`) so an empty-string value falls through too.
  for (const key of CONFIG_KEYS) {
    const { envVar, default: fallback } = CONFIG_FIELDS[key];
    out[key] = (envVar && process.env[envVar]) || file[key] || fallback;
  }
  return out;
}

export const config = buildConfig();

/**
 * The persisted config, projected to known keys — file values only, with neither
 * env overrides nor the hardcoded defaults folded in. Converge uses this to tell
 * an explicitly-persisted value apart from a defaulted one, so it can slot a
 * dataset-derived default between the two.
 */
export function loadPersistedConfig(): Partial<OpenLedgerConfig> {
  return pickConfigFields(loadFileConfig() as Record<string, unknown>);
}

export function saveConfig(partial: Partial<OpenLedgerConfig>): void {
  const configPath = getConfigPath();
  if (!existsSync(OLED_DIR)) mkdirSync(OLED_DIR, { recursive: true });

  const existing = loadFileConfig();
  const merged = pickConfigFields({ ...existing, ...partial });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", {
    mode: 0o600,
  });
  try {
    chmodSync(configPath, 0o600);
  } catch {}

  Object.assign(config, merged);
}
