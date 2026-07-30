import * as z from "zod";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generic loader for the shipped reference datasets: one `<cc>.json` per
 * country under `datasets/`, each holding every dataset's slice for that
 * country. Adding a country is a new file, not a code change; dataset-specific
 * shape lives in the per-dataset modules (institutions.ts, defaults.ts).
 */

// Two levels below the package root either way (src/datasets/ under tsx, dist/datasets/
// built); the uncompiled datasets/ dir is reached by the same relative walk in both.
const DATASETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../datasets");

/** A flattened dataset row, always tagged with the (uppercased) country it loaded from. */
export type DatasetRow = Record<string, unknown> & { country: string };

/**
 * Describes one dataset for the generic loader. `schema` validates a whole
 * `<cc>.json` locale file, of which this dataset owns one slice; unknown
 * sibling keys are ignored, so each schema names only what it reads. `flatten`
 * turns the file into base rows (the loader adds `country`); a dataset absent
 * from a locale flattens to no rows. `sortKey` is the within-country tiebreak;
 * `kinds` lists the `kind` values a `--kind` filter may police.
 */
export interface DatasetDefinition<F extends { country: string } = { country: string }> {
  schema: z.ZodType<F>;
  flatten: (file: F) => Record<string, unknown>[];
  sortKey?: (row: DatasetRow) => string;
  kinds?: readonly string[];
}

// Memoized per dataset name so importing a dataset module does no file I/O.
const cache = new Map<string, DatasetRow[]>();

const parsedFiles = new Map<string, unknown>();

function readJson(file: string): unknown {
  const path = resolve(DATASETS_DIR, file);
  if (parsedFiles.has(path)) return parsedFiles.get(path);
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    parsedFiles.set(path, raw);
    return raw;
  } catch (err) {
    // A shipped dataset file that won't parse is a packaging defect, not user
    // input; surface it loudly rather than degrading to an empty registry.
    throw new Error(`dataset file ${file} is not valid JSON: ${(err as Error).message}`);
  }
}

function readCountryFile<F extends { country: string }>(
  def: DatasetDefinition<F>,
  file: string,
): DatasetRow[] {
  const parsed = def.schema.safeParse(readJson(file));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`dataset file ${file} has an invalid shape: ${detail}`);
  }
  const country = parsed.data.country.toUpperCase();
  return def.flatten(parsed.data).map((row) => ({ ...row, country }));
}

function loadAll<F extends { country: string }>(def: DatasetDefinition<F>): DatasetRow[] {
  const files = readdirSync(DATASETS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const rows = files.flatMap((f) => readCountryFile(def, f));
  rows.sort(
    (a, b) =>
      a.country.localeCompare(b.country) ||
      (def.sortKey ? def.sortKey(a).localeCompare(def.sortKey(b)) : 0),
  );
  return rows;
}

/**
 * Every row of a named dataset, sorted by country then the sort key. Returns
 * the shared memoized array: callers must copy before mutating it.
 */
export function loadDatasetRows<F extends { country: string }>(
  name: string,
  def: DatasetDefinition<F>,
): DatasetRow[] {
  const cached = cache.get(name);
  if (cached) return cached;
  const rows = loadAll(def);
  cache.set(name, rows);
  return rows;
}
