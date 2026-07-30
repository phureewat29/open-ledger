import * as z from "zod";
import type { DatasetDefinition } from "./loader.js";

const INSTITUTION_KINDS = [
  "bank",
  "card_issuer",
  "wallet",
  "payment_rail",
  "broker",
  "crypto_exchange",
  "insurer",
  "gov",
  "telco",
  "utility",
] as const;

const institutionSchema = z.object({
  code: z.string(),
  label: z.string(),
  kind: z.enum(INSTITUTION_KINDS),
  notes: z.string().optional(),
});

/** Exported so the loader test can exercise validation directly without writing a malformed file to disk. */
export const countryFileSchema = z.object({
  country: z.string(),
  institutions: z.array(institutionSchema),
});

export const institutionsDataset: DatasetDefinition<z.infer<typeof countryFileSchema>> = {
  schema: countryFileSchema,
  flatten: (file) => file.institutions,
  sortKey: (row) => String(row.code ?? ""),
  kinds: INSTITUTION_KINDS,
};
