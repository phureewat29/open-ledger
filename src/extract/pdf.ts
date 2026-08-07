import type { Document, StructuredText } from "mupdf";
import { tryExecute, type Result } from "../lib/result.js";
import type { PageFacts } from "./route.js";

type Mupdf = typeof import("mupdf");
let mupdfPromise: Promise<Mupdf> | null = null;

// Lazy: WASM module isn't loaded until first call.
function getMupdf(): Promise<Mupdf> {
  if (!mupdfPromise) mupdfPromise = import("mupdf");
  return mupdfPromise;
}

const PDF_MIME = "application/pdf";

// mupdf's authenticatePassword returns 0 on a wrong password, non-zero on success.
const MUPDF_AUTH_FAILED = 0;

export type UnlockFailureReason = "unsupported_document" | "wrong_password";

type UnlockResult = { ok: true; decrypted: Buffer } | { ok: false; reason: UnlockFailureReason };

export async function isEncryptedPdf(bytes: Buffer): Promise<boolean> {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(bytes, PDF_MIME);
  try {
    return doc.needsPassword();
  } finally {
    doc.destroy();
  }
}

export async function unlockPdf(bytes: Buffer, password: string): Promise<UnlockResult> {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(bytes, PDF_MIME);
  try {
    if (!(doc instanceof mupdf.PDFDocument)) {
      return { ok: false, reason: "unsupported_document" };
    }
    if (!doc.needsPassword()) {
      return { ok: true, decrypted: bytes };
    }
    if (doc.authenticatePassword(password) === MUPDF_AUTH_FAILED) {
      return { ok: false, reason: "wrong_password" };
    }
    const out = doc.saveToBuffer("encrypt=none");
    return { ok: true, decrypted: Buffer.from(out.asUint8Array()) };
  } finally {
    doc.destroy();
  }
}

/** `text` is the extraction itself, not a sample. */
export interface ProbedPage extends PageFacts {
  page: number;
  text: string;
}

// preserve-images makes image blocks visible to the walker; without it a scan looks blank.
const STEXT_FLAGS = "preserve-whitespace,preserve-images";

function hasImageBlock(stext: StructuredText): boolean {
  let found = false;
  stext.walk({
    onImageBlock: () => {
      found = true;
    },
  });
  return found;
}

function probeOne(doc: Document, index: number): ProbedPage {
  const page = doc.loadPage(index);
  try {
    const stext = page.toStructuredText(STEXT_FLAGS);
    try {
      const text = stext.asText().replace(/\n{3,}/g, "\n\n").trim();
      return { page: index + 1, chars: text.length, hasImage: hasImageBlock(stext), text };
    } finally {
      stext.destroy();
    }
  } finally {
    page.destroy();
  }
}

/** Measures and extracts the text layer in one pass, so no page opens twice. */
export async function probePdfPages(bytes: Buffer): Promise<Result<ProbedPage[]>> {
  const mupdf = await getMupdf();
  return tryExecute(() => {
    const doc = mupdf.Document.openDocument(bytes, PDF_MIME);
    try {
      const pages: ProbedPage[] = [];
      for (let index = 0; index < doc.countPages(); index++) {
        pages.push(probeOne(doc, index));
      }
      return pages;
    } finally {
      doc.destroy();
    }
  });
}

export interface RenderSpec {
  dpi: number;
  /** Cap on the longest side in pixels, which is how vision models state their input limit. */
  maxLongestDimPx: number;
}

/** One page as image bytes, 1-based. */
export interface PageImage {
  page: number;
  mime: string;
  bytes: Buffer;
}

function renderOne(mupdf: Mupdf, doc: Document, index: number, spec: RenderSpec): PageImage {
  const page = doc.loadPage(index);
  try {
    const [x0, y0, x1, y1] = page.getBounds();
    const longestPt = Math.max(x1 - x0, y1 - y0);
    const scale = Math.min(spec.dpi / 72, spec.maxLongestDimPx / longestPt);
    // Statements assume paper; alpha:false renders on white.
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(scale, scale),
      mupdf.ColorSpace.DeviceRGB,
      false,
    );
    try {
      return { page: index + 1, mime: "image/png", bytes: Buffer.from(pixmap.asPNG()) };
    } finally {
      pixmap.destroy();
    }
  } finally {
    page.destroy();
  }
}

export async function renderPdfPages(
  bytes: Buffer,
  spec: RenderSpec,
): Promise<Result<PageImage[]>> {
  const mupdf = await getMupdf();
  return tryExecute(() => {
    const doc = mupdf.Document.openDocument(bytes, PDF_MIME);
    try {
      const pages: PageImage[] = [];
      for (let index = 0; index < doc.countPages(); index++) {
        pages.push(renderOne(mupdf, doc, index, spec));
      }
      return pages;
    } finally {
      doc.destroy();
    }
  });
}
