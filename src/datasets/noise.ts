import * as z from "zod";
import { loadDatasetRows, type DatasetDefinition } from "./loader.js";

/** Place words only, seen on a real statement; `normalizeDescriptor` (src/db/queries/merchants.ts) owns the locale-free half and strips both together. */
const countryFileSchema = z.object({
  country: z.string(),
  noise: z.array(z.string()).optional(),
});

type NoiseFile = z.infer<typeof countryFileSchema>;

export const noiseDataset: DatasetDefinition<NoiseFile> = {
  schema: countryFileSchema,
  flatten: (file) => (file.noise ?? []).map((token) => ({ token })),
  sortKey: (row) => String(row.token ?? ""),
};

export function noiseTokens(country: string): string[] {
  const cc = country.toUpperCase();
  return loadDatasetRows("noise", noiseDataset)
    .filter((row) => row.country === cc)
    .map((row) => String(row.token));
}
