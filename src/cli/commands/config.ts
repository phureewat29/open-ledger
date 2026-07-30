import type { Command } from "commander";
import { mkdirSync } from "fs";
import { openDb } from "../db.js";
import {
  config as appConfig,
  CONFIG_SECRETS,
  getConfigPath,
  keyFingerprint,
  loadPersistedConfig,
  saveConfig,
  type OpenLedgerConfig,
} from "../../config.js";
import { findCountryDefaults, availableCountries } from "../../datasets/defaults.js";
import { getContextPath } from "../../context.js";
import { printKeyValues } from "../format.js";
import { currentMode, emit, fail, runAction, type OutputMode } from "../output.js";
import * as z from "zod";
import { parseInput, str, bool } from "../../lib/validate.js";

type SecretKey = (typeof CONFIG_SECRETS)[number];

type RedactedConfig = Omit<OpenLedgerConfig, SecretKey> &
  Record<SecretKey, { set: boolean; fingerprint?: string }>;

/** Every CONFIG_SECRETS key surfaces as {set, fingerprint}, never plaintext — config output is safe to paste into shells/logs/bug reports. */
function redactConfig(cfg: OpenLedgerConfig): RedactedConfig {
  const redacted = { ...cfg } as Record<string, unknown>;
  for (const key of CONFIG_SECRETS) {
    const value = cfg[key];
    redacted[key] = value ? { set: true, fingerprint: keyFingerprint(value) } : { set: false };
  }
  return redacted as RedactedConfig;
}

/** Redacted config plus the resolved context.md path (there's no separate `context` command). */
function showPayload(): Record<string, unknown> {
  return { ...redactConfig(appConfig), context_path: getContextPath() };
}

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

/** Every flag the bare `config` action accepts; snake_case so parseInput auto-bridges commander's camelCase opts. */
const CONVERGE_FLAGS_SPEC = z.object({
  data_dir: str().optional(),
  db: str().optional(),
  init: bool().optional(),
  locale: str().optional(),
  currency: str().optional(),
  user_name: str().optional(),
  country: str().optional(),
  ocr_url: str().optional(),
  ocr_model: str().optional(),
});

type ConvergeFlags = z.infer<typeof CONVERGE_FLAGS_SPEC>;

/** Every field converge writes from flags. `ocrApiKey` is absent by design: it is env-only (OLED_OCR_API_KEY). */
type ConvergedConfig = Pick<
  OpenLedgerConfig,
  | "dataDir"
  | "dbPath"
  | "displayLocale"
  | "displayCurrency"
  | "userName"
  | "ocrBaseUrl"
  | "ocrModel"
>;

/**
 * Precedence: flag > env var > persisted file > dataset default > code
 * default (displayLocale/currency have no env var tier). `country` defaults
 * to "th" and is validated, so an unknown name never reaches the file.
 */
function resolveConvergedConfig(flags: ConvergeFlags): ConvergedConfig {
  const country = flags.country ?? "th";
  const defaults = findCountryDefaults(country);
  if (!defaults) {
    fail("USAGE", `unknown country "${country}"`, {
      hint: `available: ${availableCountries().join(", ")}`,
    });
  }
  const persisted = loadPersistedConfig();

  return {
    dataDir: flags.data_dir ?? appConfig.dataDir,
    dbPath: flags.db ?? appConfig.dbPath,
    displayLocale: flags.locale || persisted.displayLocale || defaults.locale,
    displayCurrency: flags.currency || persisted.displayCurrency || defaults.currency,
    userName: flags.user_name ?? appConfig.userName,
    // The URL alone decides whether OCR is configured.
    ocrBaseUrl: flags.ocr_url ?? appConfig.ocrBaseUrl,
    ocrModel: flags.ocr_model ?? appConfig.ocrModel,
  };
}

async function applyConvergedConfig(converged: ConvergedConfig): Promise<void> {
  const patch: Partial<OpenLedgerConfig> = { ...converged };
  saveConfig(patch);

  // openDb() runs the migration against the (freshly) configured db path.
  const db = await openDb();

  // Seeds structural accounts the ledger auto-references so first ingest resolves them; idempotent.
  const { ensureStructuralAccount } = await import("../../accounts/accounts.js");
  for (const id of ["expense:uncategorized", "equity:adjustments", "equity:opening-balance"] as const) {
    ensureStructuralAccount(db, id);
  }

  // createContextTemplate no-ops if the file exists, so this never clobbers edits.
  const { createContextTemplate } = await import("../../context.js");
  createContextTemplate(converged.userName);
}

/**
 * Idempotent: each value resolves to an explicit flag or the already-loaded
 * singleton, so converging with no new flags is a no-op.
 */
async function convergeConfig(flags: ConvergeFlags): Promise<void> {
  const converged = resolveConvergedConfig(flags);
  mkdirSync(converged.dataDir, { recursive: true });

  await applyConvergedConfig(converged);

  printConfig(currentMode(), {
    ...redactConfig(appConfig),
    created: { config: getConfigPath(), db: converged.dbPath, data_dir: converged.dataDir },
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
    .option("--init", "create the config file, database, and data directory")
    .option("--locale <locale>", "locale")
    .option("--currency <code>", "default currency code")
    .option("--country <code>", "seed locale/currency from a country's defaults (default: th)")
    .option("--user-name <name>", "user display name")
    .option("--ocr-url <url>", "OCR endpoint base URL, e.g. http://127.0.0.1:1234/v1 (enables OCR on its own)")
    .option("--ocr-model <id>", "OCR model id served at --ocr-url; picks the built-in prompt and render profile")
    .action(runAction(configureHarness));

  configCmd
    .command("show")
    .description("Show the current configuration")
    .action(runAction(showConfig));
}
