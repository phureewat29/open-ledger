/** The one network-reaching doctor check; everything else is fs/db state already covered by the system integration test. */

import { describe, it, expect } from "vitest";
import {
  DEAD_OCR_BASE_URL,
  liveOcr,
  requireLiveOcr,
  requireLiveOcrSource,
} from "../../../fixtures/ocr.js";
import { probeOcrEndpoint, type OCRConfigSource } from "../../extract/ocr.js";
import { ocrEndpointCheck } from "./doctor.js";

/** An explicit model override, so the detail line never depends on a shipped model id. */
function ocrSource(over: Partial<OCRConfigSource> = {}): OCRConfigSource {
  return { ocrBaseUrl: "", ocrModel: "test-ocr-model", ocrApiKey: "", ...over };
}

describe("ocrEndpointCheck", () => {
  it("passes without probing anything when no endpoint is configured", async () => {
    expect(await ocrEndpointCheck(ocrSource({ ocrBaseUrl: "" }))).toEqual({
      name: "ocr_endpoint",
      ok: true,
      detail: "off (set --ocr-base-url to enable)",
    });
  });

  it("fails when nothing is listening, naming the url it tried", async () => {
    const check = await ocrEndpointCheck(ocrSource({ ocrBaseUrl: DEAD_OCR_BASE_URL }));
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(DEAD_OCR_BASE_URL);
  });
});

describe.skipIf(!liveOcr)("ocrEndpointCheck (live OCR endpoint)", () => {
  it(
    "fails when the model is not served, listing what is",
    async () => {
      const check = await ocrEndpointCheck(
        ocrSource({ ...requireLiveOcrSource(), ocrModel: "oled-doctor-bogus-model" }),
      );
      expect(check.ok).toBe(false);
      expect(check.detail).toContain("oled-doctor-bogus-model");
      expect(check.detail).toContain(requireLiveOcr().baseUrl);
    },
    30_000,
  );

  it(
    "passes naming the model and url once the model is served",
    async () => {
      const served = await probeOcrEndpoint(requireLiveOcr());
      expect(served.ok).toBe(true);
      if (!served.ok) return;
      const servedId = served.value[0];

      const check = await ocrEndpointCheck(ocrSource({ ...requireLiveOcrSource(), ocrModel: servedId }));
      expect(check.ok).toBe(true);
      expect(check.detail).toContain(servedId);
      expect(check.detail).toContain(requireLiveOcr().baseUrl);
    },
    30_000,
  );

  it(
    "resolves a family-level id to the served spelling and shows the re-spelling",
    async () => {
      const served = await probeOcrEndpoint(requireLiveOcr());
      expect(served.ok).toBe(true);
      if (!served.ok) return;
      const servedId = served.value[0];

      const check = await ocrEndpointCheck(
        ocrSource({ ...requireLiveOcrSource(), ocrModel: servedId.slice(0, -1) }),
      );
      expect(check.ok).toBe(true);
      expect(check.detail).toContain(`→ ${servedId}`);
    },
    30_000,
  );
});
