import type { Command } from "commander";
import { existsSync, mkdirSync } from "fs";
import { openDb } from "../db.js";
import { STRUCTURAL_ACCOUNTS, ensureStructuralAccount } from "../../accounts/accounts.js";
import {
  CONFIG_SECRETS,
  keyFingerprint,
  loadConfig,
  saveConfig,
  type LoadedConfig,
  type OpenLedgerConfig,
  type ResolvedConfig,
} from "../../config.js";
import { findCountryDefaults, availableCountries } from "../../datasets/defaults.js";
import { createContextTemplate } from "../../context.js";
import { typhoonModelCard } from "../../extract/cards/typhoon-ocr1.5.js";
import { printKeyValues } from "../format.js";
import { currentMode, emit, fail, runAction, type OutputMode } from "../output.js";
import * as z from "zod";
import { parseInput, str, bool } from "../../lib/validate.js";

/** Nearest `--conf` wins: commander leaves a global flag on whichever command consumed it (same walk as resolveMode). */
function resolveConfPath(cmd: Command): string | undefined {
  for (let c: Command | undefined = cmd; c; c = c.parent ?? undefined) {
    const conf = c.opts().conf;
    if (typeof conf === "string") return conf;
  }
  return undefined;
}

/** For commands that operate on the ledger: no config file, no ledger. */
export function requireConfig(cmd: Command): ResolvedConfig {
  const { config, problem } = loadConfig(resolveConfPath(cmd));
  if (problem) {
    fail("NOT_READY", `config file ${config.confPath} is unusable: ${problem}`, {
      hint: "fix or remove it, then run `oled config --init`",
    });
  }
  if (!config.exists) {
    fail("NOT_READY", `no config file at ${config.confPath}`, {
      hint: "run `oled config --init`, or pass --conf <path>",
    });
  }
  return config;
}

/** For status, doctor, and config itself, which must run on virgin or broken setups. */
export function lenientConfig(cmd: Command): LoadedConfig {
  return loadConfig(resolveConfPath(cmd));
}

type SecretKey = (typeof CONFIG_SECRETS)[number];

type RedactedConfig = Omit<OpenLedgerConfig, SecretKey> &
  Record<SecretKey, { set: boolean; fingerprint?: string }>;

/** Every CONFIG_SECRETS key surfaces as {set, fingerprint}, never plaintext: config output is safe to paste into shells/logs/bug reports. */
function redactConfig(cfg: OpenLedgerConfig): RedactedConfig {
  const redacted = { ...cfg } as Record<string, unknown>;
  for (const key of CONFIG_SECRETS) {
    const value = cfg[key];
    redacted[key] = value ? { set: true, fingerprint: keyFingerprint(value) } : { set: false };
  }
  return redacted as RedactedConfig;
}

/** The 10 value keys without the resolution fields; those render as their own snake_case rows. */
function configValues(cfg: ResolvedConfig): OpenLedgerConfig {
  const { confPath, contextPath, exists, ...values } = cfg;
  return values;
}

function showPayload(loaded: LoadedConfig): Record<string, unknown> {
  const cfg = loaded.config;
  return {
    ...redactConfig(configValues(cfg)),
    conf_path: cfg.confPath,
    context_path: cfg.contextPath,
    // A broken file degrades to defaults; the payload must say so, not imply them.
    ...(loaded.problem ? { problem: loaded.problem } : {}),
  };
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

/** The display currency names a ledger (`<currency>:<type>`), so anything but three
 *  letters can never become one. */
const CURRENCY_CODE_RE = /^[a-z]{3}$/i;

/** Every flag the `config` action accepts; snake_case so parseInput auto-bridges commander's camelCase opts. */
const CONVERGE_FLAGS_SPEC = z.object({
  data_dir: str().optional(),
  db: str().optional(),
  cache_dir: str().optional(),
  init: bool().optional(),
  locale: str().optional(),
  // Not str(): must fail USAGE before saveConfig persists a bad code.
  currency: z
    .string()
    .regex(CURRENCY_CODE_RE, "must be a 3-letter currency code, e.g. THB")
    // Rows derive currency as uppercase from the id prefix.
    .transform((code) => code.toUpperCase())
    .optional(),
  user_name: str().optional(),
  country: str().optional(),
  ocr_base_url: str().optional(),
  ocr_model: str().optional(),
  ocr_api_key: str().optional(),
});

type ConvergeFlags = z.infer<typeof CONVERGE_FLAGS_SPEC>;

type SettingFlags = Omit<ConvergeFlags, "init">;

// ocrApiKey may be undefined here; saveConfig drops undefined entries, so an
// absent flag can never clear a persisted key.
type ConvergedConfig = Omit<OpenLedgerConfig, "ocrApiKey"> & { ocrApiKey?: string };

// Precedence: flag > file > default; country is validated first so an unknown
// name never reaches the file.
function resolveConvergedConfig(flags: SettingFlags, loaded: LoadedConfig): ConvergedConfig {
  const current = loaded.config;
  const country = flags.country ?? current.country;
  const defaults = findCountryDefaults(country);
  if (!defaults) {
    fail("USAGE", `unknown country "${country}"`, {
      hint: `available: ${availableCountries().join(", ")}`,
    });
  }
  const persisted = loaded.fileValues;

  return {
    country: defaults.country,
    dataDir: flags.data_dir ?? current.dataDir,
    dbPath: flags.db ?? current.dbPath,
    cacheDir: flags.cache_dir ?? current.cacheDir,
    displayLocale: flags.locale || persisted.displayLocale || defaults.locale,
    displayCurrency: flags.currency || persisted.displayCurrency || defaults.currency,
    userName: flags.user_name ?? current.userName,
    // The URL alone decides whether OCR is enabled.
    ocrBaseUrl: flags.ocr_base_url ?? current.ocrBaseUrl,
    ocrModel: flags.ocr_model ?? current.ocrModel,
    ocrApiKey: flags.ocr_api_key,
  };
}

// Idempotent: each value resolves to an explicit flag, the file, or a default.
async function convergeConfig(flags: SettingFlags, loaded: LoadedConfig): Promise<void> {
  const converged = resolveConvergedConfig(flags, loaded);
  // 0700: the data dir holds the raw statements, the most sensitive files here.
  mkdirSync(converged.dataDir, { recursive: true, mode: 0o700 });

  const confPath = loaded.config.confPath;
  const merged = saveConfig(confPath, converged);

  // After saveConfig, and from the returned values, so the migration lands on the new db path.
  const db = await openDb(merged.dbPath);

  // Seeds the display-currency ledger's structural accounts so first ingest resolves them.
  for (const kind of Object.keys(STRUCTURAL_ACCOUNTS) as (keyof typeof STRUCTURAL_ACCOUNTS)[]) {
    ensureStructuralAccount(db, merged.displayCurrency, kind);
  }

  // createContextTemplate no-ops if the file exists, so this never clobbers edits.
  createContextTemplate(loaded.config.contextPath, merged.userName);

  printConfig(currentMode(), {
    ...redactConfig(merged),
    conf_path: confPath,
    context_path: loaded.config.contextPath,
    created: { config: confPath, db: merged.dbPath, data_dir: merged.dataDir },
  });
}

/** `--init` asserts a fresh setup; a missing db or data dir is a recovery case it may rebuild. */
function fullyInitialized(cfg: ResolvedConfig): boolean {
  return cfg.exists && existsSync(cfg.dbPath) && existsSync(cfg.dataDir);
}

// One verb, three moods: bare shows, setting flags write (creating the file on
// first touch), --init asserts the setup is being created fresh.
async function configureHarness(
  conf: string | undefined,
  opts: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const flags = parseInput(CONVERGE_FLAGS_SPEC, opts);
  const explicit = conf ?? resolveConfPath(command);
  const loaded = loadConfig(explicit);
  const { init, ...settings } = flags;
  const writing = init || Object.keys(settings).length > 0;

  if (!writing) {
    // Naming a file that does not exist is a mistake, not a defaults view:
    // `config show` muscle memory would otherwise read a file named "show".
    if (explicit && !loaded.config.exists) {
      fail("NOT_FOUND", `no config file at ${loaded.config.confPath}`, {
        hint: "create it with `oled config <path> --init`",
      });
    }
    printConfig(currentMode(), showPayload(loaded));
    return;
  }

  // A file that exists but does not parse never converges: writing would
  // silently discard whatever the user hand-edited into it.
  if (loaded.problem) {
    fail("NOT_READY", `config file ${loaded.config.confPath} is unusable: ${loaded.problem}`, {
      hint: "fix or remove it, then try again",
    });
  }
  if (init && fullyInitialized(loaded.config)) {
    fail("INVALID", `already initialized: ${loaded.config.confPath}`, {
      hint: "drop --init to change settings",
    });
  }
  await convergeConfig(settings, loaded);
}

export function registerConfig(program: Command): void {
  program
    .command("config")
    .description("Configuration")
    .argument("[conf]", "config file to read or write (default ~/.oled/config.json)")
    .option("--data-dir <dir>", "drop statement files here; oled open opens it")
    .option("--db <path>", "database path")
    .option("--cache-dir <dir>", "extracted text and page images land here")
    .option("--init", "create the config file, database, and data dir; refuses a config that already exists")
    .option("--locale <locale>", "locale used to format money, e.g. th-TH")
    .option("--currency <code>", "display currency; also seeds that ledger's structural accounts")
    .option("--country <code>", "country whose reference data applies; also seeds locale/currency (default: TH)")
    .option("--user-name <name>", "your name; config shows it and redaction masks it")
    .option("--ocr-base-url <url>", "OCR endpoint base URL, e.g. http://127.0.0.1:1234/v1; OCR is off until this is set")
    .option("--ocr-model <id>", `model id sent to the OCR endpoint (default ${typhoonModelCard.model}); does nothing until --ocr-base-url is set`)
    .option("--ocr-api-key <key>", 'API key for the OCR endpoint; saved to the config file (0600), shown only as a fingerprint; "" clears it')
    .addHelpText(
      "after",
      [
        "",
        "Bare `oled config` shows the current settings; any setting flag writes",
        "them, creating the file on first touch. The positional argument names the",
        "config file (default ~/.oled/config.json); every other oled command",
        "reaches the same config file with --conf <path>."
      ].join("\n"),
    )
    .action(runAction(configureHarness));
}
