import { extname } from "node:path";
import * as z from "zod";
import { parseNdjson } from "./ndjson.js";

// Detection only: this module recognizes the paths in oled's own output and
// nothing else, so no part of a statement is ever read here.

export interface PageImageArtifact {
  path: string;
  mediaType: string;
}

export interface OpenLedgerArtifacts {
  /** `document` from `ingest prepare`: one text file holding every page. */
  document: string | null;
  /** `pages[]` image paths in page order, from `ingest prepare` when it returns images. */
  pages: PageImageArtifact[];
  /** Pages whose text is a placeholder because OCR failed on them; the document is still usable. */
  failedPages: number[];
}

/**
 * `absent` is every command that is not `ingest prepare` — the common case, and
 * not worth a note. `unreadable` is a prepare payload this host could not read,
 * which is a host defect and must never pass silently: attaching nothing was
 * indistinguishable from a model that never asked.
 */
export type ArtifactScan =
  | { ok: true; value: OpenLedgerArtifacts }
  | { ok: false; reason: "absent" }
  | { ok: false; reason: "unreadable"; detail: string };

const TXT = /\.txt$/i;

// Recognizing a page and naming its media type come from this one table, so
// a format the host can detect is always a format it can send.
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * `ingest prepare` is the only command that names a file id beside a route kind
 * and a page count. Matching all three keeps a `questions list` row — which also
 * carries a `kind` — from being read as a prepare payload and reported unreadable.
 */
const PREPARE_ROW = z.object({
  file_id: z.string(),
  kind: z.string(),
  page_count: z.number(),
});

/** One arm per route: the text route names a document, the images route names files per page. */
const PREPARED = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    document: z.string(),
    pages: z.array(z.object({ page: z.number(), chars: z.number() })),
    /** The OCR route only: the text route with a text layer omits it. */
    failed_pages: z.array(z.number()).optional(),
  }),
  z.object({
    kind: z.literal("images"),
    pages: z.array(z.object({ page: z.number(), path: z.string() })),
  }),
]);

/** Each path is filtered by extension rather than trusted: the host carries text and images, nothing else. */
function pageImages(pages: { page: number; path: string }[]): PageImageArtifact[] {
  const found: { page: number; path: string; mediaType: string }[] = [];
  for (const page of pages) {
    const mediaType = IMAGE_MEDIA_TYPES[extname(page.path).toLowerCase()];
    if (!mediaType) continue;
    found.push({ page: page.page, path: page.path, mediaType });
  }
  found.sort((left, right) => left.page - right.page);
  return found.map(({ path, mediaType }) => ({ path, mediaType }));
}

function readPrepared(row: Record<string, unknown>): ArtifactScan {
  const parsed = PREPARED.safeParse(row);
  if (!parsed.success) {
    return { ok: false, reason: "unreadable", detail: z.prettifyError(parsed.error) };
  }

  const payload = parsed.data;
  if (payload.kind === "images") {
    const pages = pageImages(payload.pages);
    if (pages.length === 0) {
      return { ok: false, reason: "unreadable", detail: "no page image the host can send" };
    }
    return { ok: true, value: { document: null, pages, failedPages: [] } };
  }

  if (!TXT.test(payload.document)) {
    return { ok: false, reason: "unreadable", detail: `not a text document: ${payload.document}` };
  }
  return {
    ok: true,
    value: {
      document: payload.document,
      pages: [],
      failedPages: payload.failed_pages ?? [],
    },
  };
}

export function artifactsOf(stdout: string): ArtifactScan {
  for (const row of parseNdjson(stdout)) {
    if (!PREPARE_ROW.safeParse(row).success) continue;
    return readPrepared(row);
  }
  return { ok: false, reason: "absent" };
}
