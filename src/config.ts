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
  dataDir: string;
  userName: string;
  ocrBaseUrl: string;
  ocrModel: string;
  ocrApiKey: string;
}

const OLED_DIR = process.env.OLED_DIR
  ? resolve(process.env.OLED_DIR)
  : resolve(homedir(), ".oled");

/**
 * Also drives the persisted-key list: unknown keys on disk are tolerated on
 * read and dropped on the next write — `saveConfig` writes only the fields
 * listed here.
 */
const CONFIG_FIELDS: Record<keyof OpenLedgerConfig, { envVar?: string; default: string }> = {
  // Last-resort constants; `config converge` overrides them — other modules
  // should read the resolved value, not hardcode a currency.
  displayLocale: { default: "th-TH" },
  displayCurrency: { default: "THB" },
  dbPath: { envVar: "OLED_DB_PATH", default: resolve(OLED_DIR, "db.sqlite") },
  dataDir: { envVar: "OLED_DATA_DIR", default: resolve(OLED_DIR, "data") },
  userName: { default: "User" },
  ocrBaseUrl: { envVar: "OLED_OCR_BASE_URL", default: "" },
  // Blank means the preset registry's own default model; src/extract/presets/ owns the id.
  ocrModel: { envVar: "OLED_OCR_MODEL", default: "" },
  ocrApiKey: { envVar: "OLED_OCR_API_KEY", default: "" },
};

const CONFIG_KEYS = Object.keys(CONFIG_FIELDS) as readonly (keyof OpenLedgerConfig)[];

/** Config fields whose value must never be echoed in plaintext; `config show`
 *  renders each as `{ set, fingerprint }` via `keyFingerprint()` instead. */
export const CONFIG_SECRETS = ["ocrApiKey"] as const;

export function getOledDir(): string {
  return OLED_DIR;
}

export function getConfigPath(): string {
  return resolve(OLED_DIR, "config.json");
}

export function getDataDir(): string {
  return config.dataDir;
}

/** Scratch space for extracted text and page images; env-overridable for tests. */
export function getCacheDir(): string {
  return process.env.OLED_CACHE_DIR || resolve(OLED_DIR, "cache");
}

/** Non-reversible fingerprint (`sha256:` + first 8 hex) so `config show` can
 *  prove a secret is set without ever printing it. */
export function keyFingerprint(key: string): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

function loadFileConfig(): Partial<OpenLedgerConfig> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // Must degrade to defaults, not throw — every command, including the
    // ones that would repair the file, would crash at startup otherwise.
    return {};
  }
}

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
 * File values only — no env overrides, no defaults folded in. Converge uses
 * this to tell an explicitly-persisted value apart from a defaulted one, so
 * it can slot a dataset-derived default between the two.
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
