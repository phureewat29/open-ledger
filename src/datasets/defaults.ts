// Locale + currency read from the top level of `datasets/<cc>.json`.

import * as z from "zod";
import { loadDatasetRows, type DatasetDefinition } from "./loader.js";

const countryDefaultsSchema = z.object({
  country: z.string(),
  locale: z.string(),
  currency: z.string(),
});

type CountryDefaults = z.infer<typeof countryDefaultsSchema>;

export const defaultsDataset: DatasetDefinition<CountryDefaults> = {
  schema: countryDefaultsSchema,
  // `country` is re-added by the loader (uppercased); the row carries only the display fields here.
  flatten: (file) => [{ locale: file.locale, currency: file.currency }],
  sortKey: (row) => row.country,
};

function all(): CountryDefaults[] {
  return loadDatasetRows("defaults", defaultsDataset) as unknown as CountryDefaults[];
}

/** Case-insensitive lookup; null when the country has no defaults. */
export function findCountryDefaults(country: string): CountryDefaults | null {
  const cc = country.toUpperCase();
  return all().find((r) => r.country === cc) ?? null;
}

/** Uppercased country codes that have defaults, sorted, for "unknown country" hints. */
export function availableCountries(): string[] {
  return all().map((r) => r.country);
}
