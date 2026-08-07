/**
 * Suites needing a real OCR endpoint run under `describe.skipIf(!liveOcr)`:
 *
 *     TEST_OCR_BASE_URL=http://127.0.0.1:1234/v1 TEST_OCR_MODEL=<served-id> npm test
 *
 * Toolchain vars, read only by tests: the CLI itself reads no env configuration.
 */

import { resolveOcr, type OCRConfigSource, type OCRSettings } from "../src/extract/ocr.js";

const liveOcrSource: OCRConfigSource = {
  ocrBaseUrl: process.env.TEST_OCR_BASE_URL || "",
  ocrModel: process.env.TEST_OCR_MODEL || "",
  ocrApiKey: process.env.TEST_OCR_API_KEY || "",
};

export const liveOcr: OCRSettings | null = resolveOcr(liveOcrSource);

/** The url alone decides whether OCR is configured; half-set env is a mistake and must not read as a clean skip. */
if (!liveOcr && liveOcrSource.ocrModel) {
  throw new Error("TEST_OCR_MODEL is set without TEST_OCR_BASE_URL: the live OCR suites would skip silently");
}

/** `skipIf` does not narrow `liveOcr`, so the live cases reach it through here. */
export function requireLiveOcr(): OCRSettings {
  if (!liveOcr) throw new Error("no live OCR endpoint: set TEST_OCR_BASE_URL");
  return liveOcr;
}

/** Live subprocess suites merge this into the sandbox's config.json (writeConfig); there is no env to inject. */
export function requireLiveOcrSource(): OCRConfigSource {
  requireLiveOcr();
  return liveOcrSource;
}

/** Binding port 1 needs root, so a connect there is reliably refused. */
export const DEAD_OCR_BASE_URL = "http://127.0.0.1:1/v1";

/** Short timeout so a test pointed at the dead endpoint fails fast. */
export function deadOcrSettings(over: Partial<OCRSettings> = {}): OCRSettings {
  return {
    baseUrl: DEAD_OCR_BASE_URL,
    model: "test-ocr-model",
    apiKey: "",
    timeoutMs: 2_000,
    modelCard: "typhoon",
    prompt: "read the page",
    params: { temperature: 0, top_p: 1, max_tokens: 256, seed: 7 },
    render: { dpi: 72, maxLongestDimPx: 1024 },
    ...over,
  };
}

/** A small local model can spend minutes on one dense page. */
export const LIVE_PAGE_TIMEOUT_MS = 180_000;
