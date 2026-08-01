import type { Command } from "commander";
import type Database from "libsql";
import chalk from "chalk";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { config, getConfigPath, getDataDir } from "../../config.js";
import { listMissingTables } from "../../db/schema.js";
import { openDb } from "../db.js";
import { getVersion } from "../../setup/install.js";
import { SKILL_DIRS, SKILL_PACK_DIR } from "../../setup/locations.js";
import { EXIT, currentMode, emit, emitList, runAction, type Column } from "../output.js";
import { errorMessage } from "../../lib/result.js";
import { probeOcrEndpoint, resolveOcr } from "../../extract/ocr.js";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const HARD_CHECKS = new Set(["db_open", "schema_tables_present"]);
const REQUIRED_TABLES = ["accounts", "transactions", "questions"];

// Diagnosing must not provision: doctor reports what's missing and points at `config --init`.
const INIT_HINT = "run `oled config --init` to create it";

function configCheck(): Check {
  const ok = existsSync(getConfigPath());
  return ok ? { name: "config_exists", ok } : { name: "config_exists", ok, detail: INIT_HINT };
}

async function dbOpenCheck(): Promise<{ check: Check; db: Database.Database | null }> {
  if (!existsSync(config.dbPath)) {
    return { check: { name: "db_open", ok: false, detail: `no ledger yet: ${INIT_HINT}` }, db: null };
  }
  try {
    const db = await openDb();
    return { check: { name: "db_open", ok: true }, db };
  } catch (err) {
    return { check: { name: "db_open", ok: false, detail: errorMessage(err) }, db: null };
  }
}

function dataDirWritableCheck(): Check {
  const dir = getDataDir();
  if (!existsSync(dir)) {
    return { name: "data_dir_writable", ok: false, detail: `missing: ${INIT_HINT}` };
  }
  try {
    const probe = join(dir, `.doctor-probe-${randomUUID()}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return { name: "data_dir_writable", ok: true };
  } catch (err) {
    return { name: "data_dir_writable", ok: false, detail: errorMessage(err) };
  }
}

async function mupdfCheck(): Promise<Check> {
  try {
    await import("mupdf");
    return { name: "mupdf_loads", ok: true };
  } catch (err) {
    return { name: "mupdf_loads", ok: false, detail: errorMessage(err) };
  }
}

function schemaTablesCheck(db: Database.Database | null): Check {
  const name = "schema_tables_present";
  if (!db) return { name, ok: false, detail: "database not open" };

  try {
    const missing = listMissingTables(db, REQUIRED_TABLES);
    return {
      name,
      ok: missing.length === 0,
      detail: missing.length ? `missing: ${missing.join(", ")}` : undefined,
    };
  } catch (err) {
    return { name, ok: false, detail: errorMessage(err) };
  }
}

export async function ocrEndpointCheck(): Promise<Check> {
  const name = "ocr_endpoint";
  const settings = resolveOcr();
  if (!settings) return { name, ok: true, detail: "off (set --ocr-url to enable)" };

  const { baseUrl, model } = settings;
  const served = await probeOcrEndpoint(settings);
  if (!served.ok) return { name, ok: false, detail: `${baseUrl}: ${served.error}` };
  if (!served.value.includes(model)) {
    return {
      name,
      ok: false,
      detail: `${baseUrl} does not serve ${model} (serving: ${served.value.join(", ") || "nothing"})`,
    };
  }
  return { name, ok: true, detail: `${model} at ${baseUrl}` };
}

async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  checks.push(configCheck());

  const { check: dbCheck, db } = await dbOpenCheck();
  checks.push(dbCheck);

  checks.push(dataDirWritableCheck());
  checks.push(await mupdfCheck());
  checks.push(schemaTablesCheck(db));
  checks.push(skillPackCheck());
  checks.push(await ocrEndpointCheck());

  return checks;
}

/** Informational only; never a HARD_CHECK. */
function skillPackCheck(): Check {
  const name = "skill_pack";
  // Probes conventional dirs only; a pack installed via `setup --dir` elsewhere reads as not installed.
  const candidates: { dir: string; scope: string; path: string }[] = [];
  for (const [scope, base] of [
    ["project", process.cwd()],
    ["global", homedir()],
  ] as const) {
    for (const dir of SKILL_DIRS) {
      candidates.push({
        dir,
        scope,
        path: join(resolve(base, dir), SKILL_PACK_DIR, "VERSION"),
      });
    }
  }

  const found = candidates.find((c) => existsSync(c.path));
  if (!found) return { name, ok: true, detail: "not installed" };

  const installed = readFileSync(found.path, "utf8").trim();
  const where = `${found.dir}, ${found.scope}`;
  const cli = getVersion();
  if (installed !== cli) {
    return {
      name,
      ok: false,
      detail: `installed ${installed} (${where}), cli ${cli}: refresh the skill (oled setup --force) or upgrade the CLI (npm install -g @aquartier/openledger@latest)`,
    };
  }
  return { name, ok: true, detail: `installed ${installed} (${where})` };
}

const CHECK_COLUMNS: Column<Check>[] = [
  { header: "Check", value: (r) => r.name },
  { header: "OK", value: (r) => (r.ok ? "yes" : "no") },
  { header: "Detail", value: (r) => r.detail ?? "" },
];

async function diagnoseEnvironment(): Promise<void> {
  const checks = await runChecks();
  const ok = checks.filter((c) => HARD_CHECKS.has(c.name)).every((c) => c.ok);

  const mode = currentMode();
  if (mode.json) {
    emit({ checks, ok });
  } else {
    emitList(checks, CHECK_COLUMNS);
    const line = `overall: ${ok ? "ready" : "not ready"}`;
    process.stdout.write((mode.color ? (ok ? chalk.green(line) : chalk.red(line)) : line) + "\n");
  }
  if (!ok) process.exitCode = EXIT.NOT_READY;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose the harness environment")
    .action(runAction(diagnoseEnvironment));
}
