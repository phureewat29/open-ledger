import * as z from "zod";
import { parseNdjson } from "./ndjson.js";

/**
 * What a command reported producing for its caller to read. Detection only: this
 * module recognizes the paths in plasalid's own output and nothing else, so no
 * part of a statement is ever read here.
 */

export interface PlasalidArtifacts {
  /** `document` from `ingest prepare`, when it is a PDF. */
  document: string | null;
  /** `pages[]` PNG paths in page order, from `ingest prepare --format png`. */
  pages: string[];
}

const PDF = /\.pdf$/i;
const PNG = /\.png$/i;

/**
 * Both fields are optional, so a row matches only when it carries one of them.
 * `--format pdf` lists the document itself under `pages`, which is why pages are
 * filtered by extension rather than trusted.
 */
const PREPARED = z.object({
  document: z.string().optional(),
  pages: z.array(z.object({ page: z.number(), path: z.string() })).optional(),
});

export function artifactsOf(stdout: string): PlasalidArtifacts | null {
  for (const row of parseNdjson(stdout)) {
    const parsed = PREPARED.safeParse(row);
    if (!parsed.success) continue;

    const document = parsed.data.document ?? "";
    const pages = (parsed.data.pages ?? [])
      .filter((page) => PNG.test(page.path))
      .sort((left, right) => left.page - right.page)
      .map((page) => page.path);
    if (!PDF.test(document) && pages.length === 0) continue;

    return { document: PDF.test(document) ? document : null, pages };
  }
  return null;
}
