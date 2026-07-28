import { describe, it, expect } from "vitest";
import { PAGE_RENDER, extractFile, type ExtractInput } from "./extract.js";
import { corruptPdf, mixedPdf, pdfOf, scanPdf, textPdf } from "../../fixtures/pdf.js";
import { samplePng } from "../../fixtures/images.js";
import {
  LIVE_PAGE_TIMEOUT_MS,
  deadOcrSettings,
  liveOcr,
  requireLiveOcr,
} from "../../fixtures/ocr-endpoint.js";

const NO_OCR = { ocr: null };

function pdfInput(bytes: Buffer): ExtractInput {
  return { kind: "pdf", mime: "application/pdf", bytes, path: "/data/statement.pdf" };
}

const png = samplePng();

function imageInput(): ExtractInput {
  return { kind: "image", mime: "image/png", bytes: png, path: "/data/receipt.png" };
}

describe("extractFile: text-layer route", () => {
  it("returns the probe's own text for a complete text layer", async () => {
    const outcome = await extractFile(pdfInput(textPdf()), NO_OCR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      kind: "text",
      source: "text-layer",
      textLayer: "complete",
      failedPages: [],
    });
    expect(outcome.value.kind === "text" && outcome.value.pages[0]).toEqual({
      page: 1,
      text: expect.stringContaining("1234.56 THB DEBIT ACME"),
    });
  });

  it("prefers the text layer over a configured endpoint, without calling it", async () => {
    // Reaching the endpoint at all would fail the run as ocr_unreachable.
    const outcome = await extractFile(pdfInput(textPdf()), { ocr: deadOcrSettings() });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.source).toBe("text-layer");
  });
});

describe("extractFile: agent route", () => {
  it("rasterizes a scanned PDF at the render spec when no endpoint is set", async () => {
    const outcome = await extractFile(pdfInput(scanPdf()), NO_OCR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.value.kind !== "images") return;
    expect(outcome.value).toMatchObject({
      kind: "images",
      source: "raster",
      textLayer: "none",
      dpi: PAGE_RENDER.dpi,
    });
    expect(outcome.value.pages).toHaveLength(1);
    expect(outcome.value.pages[0]).toMatchObject({ page: 1, mime: "image/png" });
    expect(outcome.value.pages[0].bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  it("hands back a mixed document as images rather than dropping its scanned page", async () => {
    const outcome = await extractFile(pdfInput(mixedPdf()), NO_OCR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({ kind: "images", source: "raster", textLayer: "partial" });
    expect(outcome.value.pages.map((page) => page.page)).toEqual([1, 2, 3]);
  });

  it("passes an image through as its own bytes, with no dpi and no mupdf", async () => {
    const input = imageInput();
    const outcome = await extractFile(input, NO_OCR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.value.kind !== "images") return;
    expect(outcome.value).toMatchObject({ source: "original", textLayer: "none" });
    expect(outcome.value.dpi).toBeUndefined();
    expect(outcome.value.pages).toEqual([
      { page: 1, mime: "image/png", bytes: input.bytes, path: input.path },
    ]);
  });
});

describe("extractFile: ocr route", () => {
  it("fails the run when nothing is listening, rather than degrading to images", async () => {
    const outcome = await extractFile(pdfInput(scanPdf()), { ocr: deadOcrSettings() });
    expect(outcome).toMatchObject({ ok: false, reason: "ocr_unreachable" });
  });
});

describe.skipIf(!liveOcr)("extractFile: ocr route (live OCR endpoint)", () => {
  it(
    "reads a scanned PDF through the endpoint and names the model",
    async () => {
      const settings = requireLiveOcr();
      const outcome = await extractFile(pdfInput(scanPdf()), { ocr: settings });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value).toMatchObject({
        kind: "text",
        source: "ocr",
        textLayer: "none",
        model: settings.model,
        failedPages: [],
      });
      expect(outcome.value.kind === "text" && outcome.value.pages).toEqual([
        { page: 1, text: expect.any(String) },
      ]);
    },
    LIVE_PAGE_TIMEOUT_MS,
  );

  it(
    "re-reads a partial document whole, so every page cites one source",
    async () => {
      const outcome = await extractFile(pdfInput(pdfOf(["text", "image"])), {
        ocr: requireLiveOcr(),
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value).toMatchObject({ kind: "text", source: "ocr", textLayer: "partial" });
      expect(outcome.value.pages.map((page) => page.page)).toEqual([1, 2]);
    },
    2 * LIVE_PAGE_TIMEOUT_MS,
  );

  it(
    "reads an image through the endpoint when one is configured",
    async () => {
      const outcome = await extractFile(imageInput(), { ocr: requireLiveOcr() });
      expect(outcome.ok && outcome.value).toMatchObject({ kind: "text", source: "ocr" });
    },
    LIVE_PAGE_TIMEOUT_MS,
  );
});

describe("extractFile: overrides", () => {
  it("--rescan ignores a complete text layer and rasterizes instead", async () => {
    const outcome = await extractFile(pdfInput(textPdf()), {
      ocr: null,
      overrides: { rescan: true },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toMatchObject({ kind: "images", source: "raster", textLayer: "none" });
    }
  });

  it("--no-ocr ignores a configured endpoint and returns images", async () => {
    const outcome = await extractFile(pdfInput(scanPdf()), {
      ocr: deadOcrSettings(),
      overrides: { noOcr: true },
    });
    expect(outcome.ok && outcome.value).toMatchObject({ kind: "images", source: "raster" });
  });

  it("both overrides together always yield images", async () => {
    const outcome = await extractFile(pdfInput(textPdf()), {
      ocr: deadOcrSettings(),
      overrides: { rescan: true, noOcr: true },
    });
    expect(outcome.ok && outcome.value).toMatchObject({
      kind: "images",
      source: "raster",
      textLayer: "none",
    });
  });
});

describe.skipIf(!liveOcr)("extractFile: overrides (live OCR endpoint)", () => {
  it(
    "--rescan sends a text PDF to the endpoint when one is configured",
    async () => {
      const outcome = await extractFile(pdfInput(textPdf()), {
        ocr: requireLiveOcr(),
        overrides: { rescan: true },
      });
      expect(outcome.ok && outcome.value).toMatchObject({
        kind: "text",
        source: "ocr",
        textLayer: "none",
      });
    },
    LIVE_PAGE_TIMEOUT_MS,
  );
});

describe("extractFile: unreadable input", () => {
  it("reports bytes mupdf cannot open as pdf_unreadable", async () => {
    const outcome = await extractFile(pdfInput(corruptPdf()), NO_OCR);
    expect(outcome).toMatchObject({ ok: false, reason: "pdf_unreadable" });
    if (!outcome.ok) expect(outcome.message).toBeTruthy();
  });
});
