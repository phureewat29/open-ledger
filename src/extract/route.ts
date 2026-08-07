export type TextLayer = "complete" | "partial" | "none";
export type OCRAvailability = "ready" | "unset";
export type Reader = "text-layer" | "ocr" | "agent";

const READER: Record<`${TextLayer}/${OCRAvailability}`, Reader> = {
  "complete/ready": "text-layer",
  "complete/unset": "text-layer",
  "partial/ready": "ocr",
  "partial/unset": "agent",
  "none/ready": "ocr",
  "none/unset": "agent",
};

/**
 * File kind isn't an axis: an image enters as `"none"` and routes like a scan.
 * `ocr` means configured, not reachable: a dead endpoint aborts loudly.
 */
export function readerFor(textLayer: TextLayer, ocr: OCRAvailability): Reader {
  return READER[`${textLayer}/${ocr}`];
}

type PageContent = "text" | "scan" | "blank";

/** `hasImage` needs mupdf's `preserve-images`. */
export interface PageFacts {
  chars: number;
  hasImage: boolean;
}

// Biased toward waste over loss: a junk text layer under this bar still counts as a scan.
const PAGE_TEXT_CHARS = 400;

export function classifyPage(page: PageFacts): PageContent {
  if (page.chars >= PAGE_TEXT_CHARS) return "text";
  return page.hasImage ? "scan" : "blank";
}

/** A blank trailer page doesn't spoil "complete"; one scanned page among text pages makes it "partial". */
export function verdictOf(pages: readonly PageFacts[]): TextLayer {
  const contents = pages.map(classifyPage);
  if (!contents.includes("text")) return "none";
  return contents.includes("scan") ? "partial" : "complete";
}
