import type { Result } from "../lib/result.js";
import {
  isServerFailure,
  ocrPages,
  type OcrPageOutcome,
  type OcrSettings,
  type ServerFailure,
} from "./ocr.js";
import {
  probePdfPages,
  renderPdfPages,
  type PageImage,
  type ProbedPage,
  type RenderSpec,
} from "./pdf.js";
import { readerFor, verdictOf, type TextLayer } from "./route.js";
import type { SourceKind } from "./source.js";

/** Spec for the agent route, which hands rasters to an unknown vision model.
 *  200 dpi keeps statement glyphs legible; 1800 px on the longest side stays
 *  under common vision-model input limits. Not a neutral derivation — it is
 *  the same spec the built-in OCR preset renders at. */
export const PAGE_RENDER: RenderSpec = { dpi: 200, maxLongestDimPx: 1800 };

export interface TextPage {
  page: number;
  text: string;
}

export type Extraction =
  | {
      kind: "text";
      source: "text-layer" | "ocr";
      textLayer: TextLayer;
      model?: string;
      pages: TextPage[];
      failedPages: number[];
    }
  | {
      kind: "images";
      source: "raster" | "original";
      textLayer: TextLayer;
      dpi?: number;
      pages: PageImage[];
    };

type ExtractOutcome =
  | { ok: true; value: Extraction }
  | { ok: false; reason: "pdf_unreadable" | "ocr_unreachable" | "ocr_rejected"; message: string };

export interface ExtractInput {
  kind: SourceKind;
  mime: string;
  /** Decrypted already, for a password-protected PDF. */
  bytes: Buffer;
  path: string;
}

interface ExtractOverrides {
  /** Ignore the text layer. */
  rescan?: boolean;
  /** Ignore the endpoint, and read the images yourself. */
  noOcr?: boolean;
}

interface ExtractOptions {
  ocr: OcrSettings | null;
  overrides?: ExtractOverrides;
}

const SERVER_FAILURE: Record<ServerFailure, "ocr_unreachable" | "ocr_rejected"> = {
  unreachable: "ocr_unreachable",
  rejected: "ocr_rejected",
};

// Images have no text layer; mupdf would resample a bare image as a fake 96-dpi PDF.
async function probe(input: ExtractInput): Promise<Result<ProbedPage[]>> {
  if (input.kind === "image") return { ok: true, value: [] };
  return probePdfPages(input.bytes);
}

interface PageImages {
  source: "raster" | "original";
  dpi?: number;
  pages: PageImage[];
}

async function pageImages(input: ExtractInput, spec: RenderSpec): Promise<Result<PageImages>> {
  if (input.kind === "image") {
    return {
      ok: true,
      value: {
        source: "original",
        pages: [{ page: 1, mime: input.mime, bytes: input.bytes }],
      },
    };
  }
  const rendered = await renderPdfPages(input.bytes, spec);
  if (!rendered.ok) return rendered;
  return { ok: true, value: { source: "raster", dpi: spec.dpi, pages: rendered.value } };
}

function placeholder(page: number): string {
  return `[page ${page}: OCR failed]`;
}

/** A failed page is a hole in the document; the caller reports `failedPages` and exits PARTIAL. */
function ocrExtraction(
  outcomes: OcrPageOutcome[],
  settings: OcrSettings,
  textLayer: TextLayer,
): ExtractOutcome {
  for (const outcome of outcomes) {
    if (outcome.ok || !isServerFailure(outcome.reason)) continue;
    return {
      ok: false,
      reason: SERVER_FAILURE[outcome.reason],
      message: `page ${outcome.page}: ${outcome.message}`,
    };
  }
  return {
    ok: true,
    value: {
      kind: "text",
      source: "ocr",
      textLayer,
      model: settings.model,
      pages: outcomes.map((outcome) => ({
        page: outcome.page,
        text: outcome.ok ? outcome.text : placeholder(outcome.page),
      })),
      failedPages: outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.page),
    },
  };
}

export async function extractFile(
  input: ExtractInput,
  options: ExtractOptions,
): Promise<ExtractOutcome> {
  const probed = await probe(input);
  if (!probed.ok) return { ok: false, reason: "pdf_unreadable", message: probed.error };

  const overrides = options.overrides ?? {};
  const ocr = overrides.noOcr ? null : options.ocr;
  const textLayer = overrides.rescan ? "none" : verdictOf(probed.value);
  const reader = readerFor(textLayer, ocr ? "ready" : "unset");

  if (reader === "text-layer") {
    return {
      ok: true,
      value: {
        kind: "text",
        source: "text-layer",
        textLayer,
        pages: probed.value.map(({ page, text }) => ({ page, text })),
        failedPages: [],
      },
    };
  }

  const images = await pageImages(input, ocr ? ocr.render : PAGE_RENDER);
  if (!images.ok) return { ok: false, reason: "pdf_unreadable", message: images.error };
  // The "agent" arm: READER only reaches it with no endpoint configured.
  if (!ocr) return { ok: true, value: { kind: "images", textLayer, ...images.value } };
  return ocrExtraction(await ocrPages(images.value.pages, ocr), ocr, textLayer);
}
