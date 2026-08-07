/**
 * Suites needing a real OCR endpoint run under `describe.skipIf(!liveOcr)`:
 *
 *     OLED_OCR_BASE_URL=http://127.0.0.1:1234/v1 OLED_OCR_MODEL=<served-id> npm test
 */

import { resolveOcr, type OCRConfigSource, type OCRSettings } from "../src/extract/ocr.js";

/** Env only: a persisted `~/.oled/config.json` must not silently turn the live suites on. */
const liveOcrSource: OCRConfigSource = {
  ocrBaseUrl: process.env.OLED_OCR_BASE_URL || "",
  ocrModel: process.env.OLED_OCR_MODEL || "",
  ocrApiKey: process.env.OLED_OCR_API_KEY || "",
};

export const liveOcr: OCRSettings | null = resolveOcr(liveOcrSource);

/** The url alone decides whether OCR is configured; half-set env is a mistake and must not read as a clean skip. */
if (!liveOcr && liveOcrSource.ocrModel) {
  throw new Error("OLED_OCR_MODEL is set without OLED_OCR_BASE_URL: the live OCR suites would skip silently");
}

/** `skipIf` does not narrow `liveOcr`, so the live cases reach it through here. */
export function requireLiveOcr(): OCRSettings {
  if (!liveOcr) throw new Error("no live OCR endpoint: set OLED_OCR_BASE_URL");
  return liveOcr;
}

export function requireLiveOcrSource(): OCRConfigSource {
  requireLiveOcr();
  return liveOcrSource;
}

export function liveOcrEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const live = requireLiveOcrSource();
  return {
    ...base,
    OLED_OCR_BASE_URL: live.ocrBaseUrl,
    OLED_OCR_MODEL: live.ocrModel,
    OLED_OCR_API_KEY: live.ocrApiKey,
  };
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
    preset: "typhoon-ocr",
    prompt: "read the page",
    params: { temperature: 0, top_p: 1, max_tokens: 256, seed: 7 },
    render: { dpi: 72, maxLongestDimPx: 1024 },
    ...over,
  };
}

/** A small local model can spend minutes on one dense page. */
export const LIVE_PAGE_TIMEOUT_MS = 180_000;
