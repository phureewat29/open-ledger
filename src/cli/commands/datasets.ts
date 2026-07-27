import type { Command } from "commander";
import { emitList, fail, runAction, type Column } from "../output.js";
import {
  listDatasets,
  readDataset,
  listDatasetNames,
  datasetHasKinds,
  type DatasetSummary,
  type DatasetRow,
} from "../../datasets/index.js";

const DATASET_COLUMNS: Column<DatasetSummary>[] = [
  { header: "Name", value: (d) => d.name },
  { header: "Countries", value: (d) => d.countries.join(", ") },
  { header: "Rows", value: (d) => String(d.rows), align: "right" },
];

const INSTITUTION_COLUMNS: Column<DatasetRow>[] = [
  { header: "Code", value: (r) => String(r.code ?? "") },
  { header: "Label", value: (r) => String(r.label ?? "") },
  { header: "Kind", value: (r) => String(r.kind ?? "") },
  { header: "Country", value: (r) => r.country },
];

const DEFAULTS_COLUMNS: Column<DatasetRow>[] = [
  { header: "Country", value: (r) => r.country },
  { header: "Locale", value: (r) => String(r.locale ?? "") },
  { header: "Currency", value: (r) => String(r.currency ?? "") },
];

// Human/plain columns per dataset (JSON emits the raw row regardless). Falls back
// to the generic country column so an unmapped dataset still renders something.
const COLUMNS_BY_DATASET: Record<string, Column<DatasetRow>[]> = {
  institutions: INSTITUTION_COLUMNS,
  defaults: DEFAULTS_COLUMNS,
};

const GENERIC_COLUMNS: Column<DatasetRow>[] = [{ header: "Country", value: (r) => r.country }];

interface DatasetsOpts {
  country?: string;
  kind?: string;
}

/**
 * One command, no subcommands: bare `datasets` lists the shipped datasets;
 * `datasets <name>` shows that dataset's rows, filtered by --country/--kind.
 * Filters without a name are a usage error (nothing to filter).
 */
function datasets(name: string | undefined, opts: DatasetsOpts): void {
  if (name === undefined) {
    if (opts.country || opts.kind) {
      fail("USAGE", "--country/--kind need a dataset name (e.g. `oled datasets institutions --country th`)");
    }
    emitList(listDatasets(), DATASET_COLUMNS);
    return;
  }

  const names = listDatasetNames();
  if (!names.includes(name)) {
    fail("NOT_FOUND", `unknown dataset "${name}"`, { hint: `known datasets: ${names.join(", ")}` });
  }
  if (opts.kind && !datasetHasKinds(name)) {
    fail("USAGE", `dataset "${name}" has no kinds; drop --kind`);
  }
  const rows = readDataset(name, { country: opts.country, kind: opts.kind });
  emitList(rows, COLUMNS_BY_DATASET[name] ?? GENERIC_COLUMNS);
}

export function registerDatasets(program: Command): void {
  program
    .command("datasets [name]")
    .description("Reference datasets")
    .option("--country <code>", "filter rows by country (e.g. th)")
    .option("--kind <kind>", "filter institutions by kind")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: read-only reference data, institution codes and per-country defaults behind account leaves.",
        "Typical flow: bare datasets lists them; datasets institutions --country th filters a country's institutions.",
        "Example: oled datasets institutions --country th --kind bank --json",
      ].join("\n"),
    )
    .action(runAction(datasets));
}
