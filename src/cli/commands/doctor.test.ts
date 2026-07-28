import { describe, it, expect, afterEach } from "vitest";
import { config } from "../../config.js";
import {
  DEAD_OCR_BASE_URL,
  liveOcr,
  requireLiveOcr,
  requireLiveOcrSource,
} from "../../../fixtures/ocr-endpoint.js";
import { probeOcrEndpoint } from "../../extract/ocr.js";
import { ocrEndpointCheck } from "./doctor.js";

/** The one network-reaching doctor check; everything else is fs/db state already covered by the system integration test. */

type OcrConfig = Pick<typeof config, "ocrBaseUrl" | "ocrModel" | "ocrApiKey">;

const SAVED: OcrConfig = {
  ocrBaseUrl: config.ocrBaseUrl,
  ocrModel: config.ocrModel,
  ocrApiKey: config.ocrApiKey,
};

/** An explicit model override, so the detail line never depends on a shipped model id. */
function configureOcr(over: Partial<OcrConfig>): void {
  Object.assign(config, {
    ocrBaseUrl: "",
    ocrModel: "test-ocr-model",
    ocrApiKey: "",
    ...over,
  });
}

afterEach(() => {
  Object.assign(config, SAVED);
});

describe("ocrEndpointCheck", () => {
  it("passes without probing anything when no endpoint is configured", async () => {
    configureOcr({ ocrBaseUrl: "" });
    expect(await ocrEndpointCheck()).toEqual({
      name: "ocr_endpoint",
      ok: true,
      detail: "not configured",
    });
  });

  it("fails when nothing is listening, naming the url it tried", async () => {
    configureOcr({ ocrBaseUrl: DEAD_OCR_BASE_URL });
    const check = await ocrEndpointCheck();
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(DEAD_OCR_BASE_URL);
  });
});

describe.skipIf(!liveOcr)("ocrEndpointCheck (live OCR endpoint)", () => {
  it(
    "fails when the model is not served, listing what is",
    async () => {
      configureOcr({ ...requireLiveOcrSource(), ocrModel: "oled-doctor-bogus-model" });
      const check = await ocrEndpointCheck();
      expect(check.ok).toBe(false);
      expect(check.detail).toContain("oled-doctor-bogus-model");
      expect(check.detail).toContain(requireLiveOcr().baseUrl);
    },
    30_000,
  );

  it(
    "passes naming the preset, model and url once the model is served",
    async () => {
      const served = await probeOcrEndpoint(requireLiveOcr());
      expect(served.ok).toBe(true);
      if (!served.ok) return;
      const servedId = served.value[0];

      configureOcr({ ...requireLiveOcrSource(), ocrModel: servedId });
      const check = await ocrEndpointCheck();
      expect(check.ok).toBe(true);
      expect(check.detail).toContain(servedId);
      expect(check.detail).toContain(requireLiveOcr().baseUrl);
    },
    30_000,
  );
});
