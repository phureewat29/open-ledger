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
  country: string;
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

/** Also the persisted-key list: unknown keys on disk are tolerated on read, dropped on next write (`saveConfig` writes only these fields). */
const CONFIG_FIELDS: Record<keyof OpenLedgerConfig, { envVar?: string; default: string }> = {
  // Overridden by `config --init`; other modules should read the resolved value, not hardcode a currency.
  /** Picks `src/datasets/` reference data; deliberately not derived from `displayLocale` (which only formats numbers/dates). */
  country: { default: "TH" },
  displayLocale: { default: "th-TH" },
  displayCurrency: { default: "THB" },
  dbPath: { envVar: "OLED_DB_PATH", default: resolve(OLED_DIR, "db.sqlite") },
  dataDir: { envVar: "OLED_DATA_DIR", default: resolve(OLED_DIR, "data") },
  userName: { default: "User" },
  ocrBaseUrl: { envVar: "OLED_OCR_BASE_URL", default: "" },
  // Duplicates typhoonOcrPreset.model (src/extract/presets/typhoon-ocr.ts), which
  // .env.example, README, and the --ocr-model help repeat; change all five together.
  ocrModel: { envVar: "OLED_OCR_MODEL", default: "typhoon-ocr1.5" },
  ocrApiKey: { envVar: "OLED_OCR_API_KEY", default: "" },
};

const CONFIG_KEYS = Object.keys(CONFIG_FIELDS) as readonly (keyof OpenLedgerConfig)[];

/** Fields never echoed in plaintext; `config show` renders each as `{ set, fingerprint }` via `keyFingerprint()` instead. */
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

/** Non-reversible fingerprint (`sha256:` + first 8 hex) so `config show` can prove a secret is set without printing it. */
export function keyFingerprint(key: string): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

function loadFileConfig(): Partial<OpenLedgerConfig> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // Must degrade to defaults, not throw, or every command (including repair ones) would crash at startup.
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

/** File values only, no env or defaults folded in — lets converge tell an explicitly-persisted value from a defaulted one. */
export function loadPersistedConfig(): Partial<OpenLedgerConfig> {
  return pickConfigFields(loadFileConfig() as Record<string, unknown>);
}

export function saveConfig(partial: Partial<OpenLedgerConfig>): void {
  const configPath = getConfigPath();
  // 0700 like the cache dir: this tree holds financial data.
  if (!existsSync(OLED_DIR)) mkdirSync(OLED_DIR, { recursive: true, mode: 0o700 });

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
