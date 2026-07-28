export type TextLayer = "complete" | "partial" | "none";
export type OcrAvailability = "ready" | "unset";
export type Reader = "text-layer" | "ocr" | "agent";

/** The whole routing policy.
 *                  ocr ready     ocr unset
 *   complete       text-layer    text-layer
 *   partial        ocr           agent
 *   none           ocr           agent
 */
const READER: Record<`${TextLayer}/${OcrAvailability}`, Reader> = {
  "complete/ready": "text-layer",
  "complete/unset": "text-layer",
  "partial/ready": "ocr",
  "partial/unset": "agent",
  "none/ready": "ocr",
  "none/unset": "agent",
};

/**
 * File kind is deliberately not an axis: an image enters as `"none"` and routes
 * like a scan. Availability means configured, not reachable — a dead endpoint
 * fails the run loudly rather than degrading to images behind the caller's back.
 */
export function readerFor(textLayer: TextLayer, ocr: OcrAvailability): Reader {
  return READER[`${textLayer}/${ocr}`];
}

type PageContent = "text" | "scan" | "blank";

/** `hasImage` needs mupdf's `preserve-images`. */
export interface PageFacts {
  chars: number;
  hasImage: boolean;
}

// Biased toward waste over loss: a scanned page with a junk text layer under this
// bar still counts as a scan, so it gets re-read instead of silently contributing nothing.
const PAGE_TEXT_CHARS = 400;

export function classifyPage(page: PageFacts): PageContent {
  if (page.chars >= PAGE_TEXT_CHARS) return "text";
  return page.hasImage ? "scan" : "blank";
}

/**
 * Blank trailer pages don't spoil "complete"; one scanned page among text pages makes
 * it "partial", re-reading the whole document so every source_page citation matches.
 */
export function verdictOf(pages: readonly PageFacts[]): TextLayer {
  const contents = pages.map(classifyPage);
  if (!contents.includes("text")) return "none";
  return contents.includes("scan") ? "partial" : "complete";
}
