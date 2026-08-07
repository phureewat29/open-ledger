import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { dirname, resolve } from "path";
import { homedir } from "os";
import { typhoonModelCard } from "./extract/cards/typhoon-ocr1.5.js";
import { chmod600 } from "./perms.js";

export interface OpenLedgerConfig {
  country: string;
  displayLocale: string;
  displayCurrency: string;
  dbPath: string;
  dataDir: string;
  cacheDir: string;
  userName: string;
  ocrBaseUrl: string;
  ocrModel: string;
  ocrApiKey: string;
}

/** What one invocation resolved: the config values plus where they came from. */
export interface ResolvedConfig extends OpenLedgerConfig {
  /** Absolute path of the file this invocation resolves to (`--config` or the default). */
  configPath: string;
  /** Freeform agent context lives beside the config file, so each profile carries its own. */
  contextPath: string;
  /** Whether the config file was present at load; data commands refuse to run without it. */
  exists: boolean;
}

export interface LoadedConfig {
  config: ResolvedConfig;
  /** File values only, no defaults folded in — lets converge tell an explicitly-persisted value from a defaulted one. */
  fileValues: Partial<OpenLedgerConfig>;
  /** Why the file is unusable, or null when it is fine or simply absent. */
  problem: string | null;
}

function defaultOledDir(): string {
  return resolve(homedir(), ".oled");
}

function defaultConfigPath(): string {
  return resolve(defaultOledDir(), "config.json");
}

/** `~` is the shell's expansion, not Node's, so a quoted `~/x` would otherwise
 *  resolve under the working directory. Keeps `status`'s home-relative paths usable as input. */
function expandHome(path: string): string {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

/** Also the persisted-key list: unknown keys on disk are tolerated on read, dropped on next write (`saveConfig` writes only these fields). */
const CONFIG_FIELDS: Record<keyof OpenLedgerConfig, { default: () => string }> = {
  /** Picks `datasets/<cc>.json`; deliberately not derived from `displayLocale`, which only formats numbers and dates. */
  country: { default: () => "TH" },
  displayLocale: { default: () => "th-TH" },
  /** Resolved value only; no module may hardcode a currency. `config --init` overrides it. */
  displayCurrency: { default: () => "THB" },
  dbPath: { default: () => resolve(defaultOledDir(), "db.sqlite") },
  dataDir: { default: () => resolve(defaultOledDir(), "data") },
  cacheDir: { default: () => resolve(defaultOledDir(), "cache") },
  userName: { default: () => "User" },
  ocrBaseUrl: { default: () => "" },
  ocrModel: { default: () => typhoonModelCard.model },
  ocrApiKey: { default: () => "" },
};

const CONFIG_KEYS = Object.keys(CONFIG_FIELDS) as readonly (keyof OpenLedgerConfig)[];

/** Fields never echoed in plaintext; `oled config` renders each as `{ set, fingerprint }` via `keyFingerprint()` instead. */
export const CONFIG_SECRETS = ["ocrApiKey"] as const;

/** Non-reversible fingerprint (`sha256:` + first 8 hex) so `oled config` can prove a secret is set without printing it. */
export function keyFingerprint(key: string): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

/** `null` and arrays parse fine but would break every `file[key]` read below. */
function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Known keys with string values only: drops `undefined` (so a patch can never
 *  delete a persisted key by accident) and hand-edited non-strings alike. */
function pickConfigFields(obj: Record<string, unknown>): Partial<OpenLedgerConfig> {
  const out: Partial<OpenLedgerConfig> = {};
  for (const key of CONFIG_KEYS) {
    if (typeof obj[key] === "string") out[key] = obj[key] as string;
  }
  return out;
}

function readFileValues(configPath: string): {
  fileValues: Partial<OpenLedgerConfig>;
  problem: string | null;
  exists: boolean;
} {
  if (!existsSync(configPath)) return { fileValues: {}, problem: null, exists: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { fileValues: {}, problem: message, exists: true };
  }
  if (!isConfigObject(parsed)) {
    return { fileValues: {}, problem: "it does not hold a JSON object", exists: true };
  }
  return { fileValues: pickConfigFields(parsed), problem: null, exists: true };
}

/** Precedence: file > default. `||`, not `??`, so an empty-string value means unset. */
function withDefaults(fileValues: Partial<OpenLedgerConfig>): OpenLedgerConfig {
  const out = {} as OpenLedgerConfig;
  for (const key of CONFIG_KEYS) {
    out[key] = fileValues[key] || CONFIG_FIELDS[key].default();
  }
  return out;
}

/** Reads the config file (default: `~/.oled/config.json`). A broken file degrades
 *  to defaults with `problem` set; the caller decides whether that is fatal. */
export function loadConfig(configPath?: string): LoadedConfig {
  const resolved = resolve(expandHome(configPath ?? defaultConfigPath()));
  const { fileValues, problem, exists } = readFileValues(resolved);
  const config: ResolvedConfig = {
    ...withDefaults(fileValues),
    configPath: resolved,
    contextPath: resolve(dirname(resolved), "context.md"),
    exists,
  };
  return { config, fileValues, problem };
}

/** Merges the file's values with the DEFINED entries of `patch`, writes 0600,
 *  and returns the merged values with defaults folded in. No module state. */
export function saveConfig(configPath: string, patch: Partial<OpenLedgerConfig>): OpenLedgerConfig {
  const dir = dirname(configPath);
  // 0700 like the cache dir: this tree holds financial data.
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  // A broken file degrades to {} here; the write below repairs it.
  const { fileValues } = readFileValues(configPath);
  const merged = { ...fileValues, ...pickConfigFields(patch) };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  chmod600(configPath);

  return withDefaults(merged);
}
