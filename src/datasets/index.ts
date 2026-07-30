import { loadDatasetRows, type DatasetDefinition, type DatasetRow } from "./loader.js";
import { institutionsDataset } from "./institutions.js";
import { defaultsDataset } from "./defaults.js";

/** A dataset with a typed finder of its own (`findCountryDefaults`) exports it from its own module instead. */

// `any` here only erases the per-entry file shape (institutions vs defaults each
// have their own concrete `DatasetDefinition<...>`), which the registry doesn't need.
const REGISTRY: Record<string, DatasetDefinition<any>> = {
  institutions: institutionsDataset,
  defaults: defaultsDataset,
};

export function listDatasetNames(): string[] {
  return Object.keys(REGISTRY);
}

/** Drives the CLI `--kind` guard. */
export function datasetHasKinds(name: string): boolean {
  return !!REGISTRY[name]?.kinds;
}

export interface DatasetSummary {
  name: string;
  countries: string[];
  rows: number;
}

export function listDatasets(): DatasetSummary[] {
  return Object.entries(REGISTRY).map(([name, def]) => {
    const rows = loadDatasetRows(name, def);
    const countries = [...new Set(rows.map((r) => r.country))].sort();
    return { name, countries, rows: rows.length };
  });
}

/** Throws on an unknown name: the CLI validates the name first for a clean error. */
export function readDataset(
  name: string,
  filter: { country?: string; kind?: string } = {},
): DatasetRow[] {
  const def = REGISTRY[name];
  if (!def) throw new Error(`unknown dataset "${name}"`);
  const country = filter.country?.toUpperCase();
  const { kind } = filter;
  return loadDatasetRows(name, def).filter(
    (r) => (!country || r.country === country) && (!kind || r.kind === kind),
  );
}

export type { DatasetRow } from "./loader.js";
