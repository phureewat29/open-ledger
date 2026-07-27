import type { Command } from "commander";
import type Database from "libsql";
import chalk from "chalk";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { getConfigPath, getDataDir } from "../../config.js";
import { openDb } from "../db.js";
import { getVersion } from "../../setup/install.js";
import { SKILL_HOSTS } from "../../setup/hosts.js";
import { EXIT, currentMode, emit, emitList, runAction, type Column } from "../output.js";
import { errorMessage } from "../../lib/result.js";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const HARD_CHECKS = new Set(["db_open", "schema_tables_present"]);
const REQUIRED_TABLES = ["accounts", "transactions", "questions"];

function configCheck(): Check {
  return { name: "config_exists", ok: existsSync(getConfigPath()) };
}

async function dbOpenCheck(): Promise<{ check: Check; db: Database.Database | null }> {
  try {
    const db = await openDb();
    return { check: { name: "db_open", ok: true }, db };
  } catch (err) {
    return { check: { name: "db_open", ok: false, detail: errorMessage(err) }, db: null };
  }
}

function dataDirWritableCheck(): Check {
  try {
    const dir = getDataDir();
    mkdirSync(dir, { recursive: true });
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
  if (!db) return { name: "schema_tables_present", ok: false, detail: "database not open" };

  try {
    const placeholders = REQUIRED_TABLES.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
      .all(...REQUIRED_TABLES) as { name: string }[];
    const present = new Set(rows.map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    return {
      name: "schema_tables_present",
      ok: missing.length === 0,
      detail: missing.length ? `missing: ${missing.join(", ")}` : undefined,
    };
  } catch (err) {
    return { name: "schema_tables_present", ok: false, detail: errorMessage(err) };
  }
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

  return checks;
}

// Informational only; never a HARD_CHECK.
function skillPackCheck(): Check {
  const candidates: { host: string; scope: string; path: string }[] = [];
  for (const host of SKILL_HOSTS) {
    candidates.push({
      host: host.id,
      scope: "project",
      path: join(resolve(process.cwd(), host.projectDir), "open-ledger", "VERSION"),
    });
  }
  for (const host of SKILL_HOSTS) {
    candidates.push({
      host: host.id,
      scope: "global",
      path: join(host.globalDir(), "open-ledger", "VERSION"),
    });
  }

  const found = candidates.find((c) => existsSync(c.path));
  if (!found) return { name: "skill_pack", ok: true, detail: "not installed" };

  const installed = readFileSync(found.path, "utf8").trim();
  const where = `${found.host}, ${found.scope}`;
  const cli = getVersion();
  if (installed !== cli) {
    return {
      name: "skill_pack",
      ok: false,
      detail: `installed ${installed} (${where}), cli ${cli} — refresh the skill (oled setup --force) or upgrade the CLI (npm install -g open-ledger@latest)`,
    };
  }
  return { name: "skill_pack", ok: true, detail: `installed ${installed} (${where})` };
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
