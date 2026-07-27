import type { Command } from "commander";
import { existsSync, mkdirSync } from "fs";
import { openDb } from "../db.js";
import {
  config as appConfig,
  getConfigPath,
  keyFingerprint,
  loadPersistedConfig,
  saveConfig,
  type OpenLedgerConfig,
} from "../../config.js";
import { findCountryDefaults, availableCountries } from "../../datasets/defaults.js";
import { generateKey } from "../../db/encryption.js";
import { getContextPath } from "../../context.js";
import { printKeyValues } from "../format.js";
import { currentMode, emit, fail, readSecretFromStdin, runAction, type OutputMode } from "../output.js";
import * as z from "zod";
import { parseInput, str, bool } from "../../lib/validate.js";

type RedactedConfig = Omit<OpenLedgerConfig, "dbEncryptionKey"> & {
  dbEncryptionKey: { set: boolean; fingerprint?: string };
};

// dbEncryptionKey is the only secret in config; surface {set, fingerprint}
// rather than the passphrase itself, which would land in shells/logs/bug reports.
function redactConfig(cfg: OpenLedgerConfig): RedactedConfig {
  const key = cfg.dbEncryptionKey;
  const dbEncryptionKey = key
    ? { set: true, fingerprint: keyFingerprint(key) }
    : { set: false };
  return { ...cfg, dbEncryptionKey };
}

/** Redacted config plus the resolved context.md path (there's no separate `context` command). */
function showPayload(): Record<string, unknown> {
  return { ...redactConfig(appConfig), context_path: getContextPath() };
}

/** Flatten a (possibly one-level-nested) object into label/value rows for human display. */
function flattenRows(obj: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        rows.push([`${k}.${nk}`, String(nv)]);
      }
    } else {
      rows.push([k, String(v)]);
    }
  }
  return rows;
}

function printConfig(mode: OutputMode, data: Record<string, unknown>): void {
  if (mode.json) {
    emit(data);
    return;
  }
  printKeyValues(mode, flattenRows(data));
}

/** Every flag the bare `config` action accepts, keyed to auto-bridge commander's
 *  camelCase opts (parseInput tries each key's camelCase/snake_case form). */
const CONVERGE_FLAGS_SPEC = z.object({
  data_dir: str().optional(),
  db: str().optional(),
  generate_key: bool().optional(),
  encryption_key_stdin: bool().optional(),
  locale: str().optional(),
  currency: str().optional(),
  user_name: str().optional(),
  country: str().optional(),
});

type ConvergeFlags = z.infer<typeof CONVERGE_FLAGS_SPEC>;

/**
 * Idempotent configure: ensures the data dir, persists settings, migrates the
 * db, seeds context.md if absent. Each value resolves to an explicit flag or
 * the already-loaded singleton value, so re-writing unchanged values is a no-op.
 */
async function convergeConfig(flags: ConvergeFlags): Promise<void> {
  if (flags.generate_key && flags.encryption_key_stdin) {
    fail("USAGE", "--generate-key and --encryption-key-stdin are mutually exclusive");
  }

  const dataDir: string = flags.data_dir ?? appConfig.dataDir;
  const dbPath: string = flags.db ?? appConfig.dbPath;

  // Seed locale/currency from the chosen country's dataset defaults, but only
  // where the user hasn't already spoken. Precedence: explicit flag > env var >
  // persisted file value > dataset default > code default. displayLocale/
  // displayCurrency have no env var today, so that tier is currently a no-op; a
  // persisted value still wins over the dataset, and the dataset default replaces
  // the code default as the last resort (country defaults to "th", whose dataset
  // matches the old hardcoded th-TH/THB).
  const country = flags.country ?? "th";
  const defaults = findCountryDefaults(country);
  if (!defaults) {
    fail("USAGE", `unknown country "${country}"`, {
      hint: `available: ${availableCountries().join(", ")}`,
    });
  }
  const persisted = loadPersistedConfig();
  const displayLocale: string = flags.locale || persisted.displayLocale || defaults.locale;
  const displayCurrency: string = flags.currency || persisted.displayCurrency || defaults.currency;

  const userName: string = flags.user_name ?? appConfig.userName;

  mkdirSync(dataDir, { recursive: true });

  const patch: Partial<OpenLedgerConfig> = {
    dataDir,
    dbPath,
    displayLocale,
    displayCurrency,
    userName,
  };
  if (flags.generate_key) {
    // "Ensure a key exists": minting a new one over a live key would orphan the encrypted db.
    if (!appConfig.dbEncryptionKey) patch.dbEncryptionKey = generateKey();
  } else if (flags.encryption_key_stdin) {
    patch.dbEncryptionKey = await readSecretFromStdin();
  }

  // No re-encryption path exists, so refuse before saveConfig — a bad request
  // must leave both the config file and the database untouched.
  if (
    patch.dbEncryptionKey !== undefined &&
    patch.dbEncryptionKey !== appConfig.dbEncryptionKey &&
    existsSync(dbPath)
  ) {
    fail("INVALID", `database ${dbPath} already exists; changing the encryption key would make it unreadable`, {
      hint: "keep the current key (drop --generate-key / --encryption-key-stdin), or move the database file aside first",
    });
  }

  saveConfig(patch);

  // Open once to run the migration against the (freshly) configured db path.
  const db = await openDb();

  // Seed the structural accounts the ledger auto-references, so the first
  // ingest resolves them by exact match. Idempotent: no-ops if already present.
  const { ensureStructuralAccount } = await import("../../accounts/accounts.js");
  for (const id of ["expense:uncategorized", "equity:adjustments", "equity:opening-balance"] as const) {
    ensureStructuralAccount(db, id);
  }

  // Seed the context template only when absent — createContextTemplate is a
  // no-op if the file already exists, so a converge never clobbers edits.
  const { createContextTemplate } = await import("../../context.js");
  createContextTemplate(userName);

  printConfig(currentMode(), {
    ...redactConfig(appConfig),
    created: { config: getConfigPath(), db: dbPath, data_dir: dataDir },
  });
}

async function configureHarness(opts: Record<string, unknown>): Promise<void> {
  const flags = parseInput(CONVERGE_FLAGS_SPEC, opts);
  if (Object.keys(flags).length > 0) {
    await convergeConfig(flags);
  } else {
    printConfig(currentMode(), showPayload());
  }
}

function showConfig(): void {
  printConfig(currentMode(), showPayload());
}

export function registerConfig(program: Command): void {
  const configCmd = program
    .command("config")
    .enablePositionalOptions()
    .description("Configuration")
    .option("--data-dir <dir>", "data directory")
    .option("--db <path>", "database path")
    .option("--generate-key", "generate a new encryption key")
    .option("--encryption-key-stdin", "read an encryption key from stdin")
    .option("--locale <locale>", "locale")
    .option("--currency <code>", "default currency code")
    .option("--country <code>", "seed locale/currency from a country's defaults (default: th)")
    .option("--user-name <name>", "user display name")
    .action(runAction(configureHarness));

  configCmd
    .command("show")
    .description("Show the current configuration")
    .action(runAction(showConfig));
}
