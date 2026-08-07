import { describe, it, expect } from "vitest";
import {
  OCR_TIMEOUT_MS,
  isServerFailure,
  ocrPage,
  ocrPages,
  probeOcrEndpoint,
  resolveOcr,
  type OCRConfigSource,
} from "./ocr.js";
import { MODEL_CARDS, MODEL_CARD_NAMES } from "./cards/index.js";
import type { PageImage } from "./pdf.js";
import { samplePng } from "../../fixtures/images.js";
import {
  LIVE_PAGE_TIMEOUT_MS,
  deadOcrSettings,
  liveOcr,
  requireLiveOcr,
} from "../../fixtures/ocr.js";

const png = samplePng();
const page1: PageImage = { page: 1, mime: "image/png", bytes: png };
const page2: PageImage = { page: 2, mime: "image/png", bytes: png };

// Mirrors the shipped config defaults (OCR unset).
function cfg(over: Partial<OCRConfigSource> = {}): OCRConfigSource {
  return { ocrBaseUrl: "", ocrModel: "", ocrApiKey: "", ...over };
}

const TYPHOON = MODEL_CARDS.typhoon;
const FALLBACK = MODEL_CARDS.fallback;

describe("resolveOcr", () => {
  it("reads null when no endpoint url is set", () => {
    expect(resolveOcr(cfg())).toBeNull();
  });

  it("treats a whitespace-only url as unset", () => {
    expect(resolveOcr(cfg({ ocrBaseUrl: "  " }))).toBeNull();
  });

  it("stays unset when a model is set ahead of the url", () => {
    expect(resolveOcr(cfg({ ocrModel: "some-ocr-model" }))).toBeNull();
  });

  it("builds settings from the url alone, taking the rest from the default model card", () => {
    const settings = resolveOcr(
      cfg({ ocrBaseUrl: "http://127.0.0.1:1234/v1//", ocrApiKey: "sk-test" }),
    );
    expect(settings).toEqual({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: TYPHOON.model,
      apiKey: "sk-test",
      timeoutMs: OCR_TIMEOUT_MS,
      modelCard: "typhoon",
      prompt: TYPHOON.prompt,
      params: TYPHOON.params,
      render: TYPHOON.render,
    });
  });

  it("keeps a model id from no known family, reading it with the fallback card", () => {
    expect(resolveOcr(cfg({ ocrBaseUrl: "http://x/v1", ocrModel: "test-ocr-model" }))).toMatchObject({
      model: "test-ocr-model",
      modelCard: "fallback",
      prompt: FALLBACK.prompt,
      render: FALLBACK.render,
    });
  });

  // Model ids come from the registry: spelling one out here would name a vendor.
  it("matches a family whatever the version suffix", () => {
    const model = `${TYPHOON.model}-preview-v9`;
    expect(resolveOcr(cfg({ ocrBaseUrl: "http://x/v1", ocrModel: model }))).toMatchObject({
      model,
      modelCard: "typhoon",
    });
  });

  it("matches a family case-insensitively, carrying that card's own render", () => {
    const model = TYPHOON.model.toUpperCase();
    expect(resolveOcr(cfg({ ocrBaseUrl: "http://x/v1", ocrModel: model }))).toMatchObject({
      model,
      modelCard: "typhoon",
      prompt: TYPHOON.prompt,
      params: TYPHOON.params,
      render: TYPHOON.render,
    });
  });

  // The fallback card has no id of its own; only cards with one can self-select.
  it.each(MODEL_CARD_NAMES.filter((name) => MODEL_CARDS[name].model))(
    "selects model card %s from its own model id",
    (name) => {
      const settings = resolveOcr(cfg({ ocrBaseUrl: "http://x/v1", ocrModel: MODEL_CARDS[name].model }));
      expect(settings).toMatchObject({ modelCard: name });
    },
  );
});

describe("isServerFailure", () => {
  it("treats a bad page as page-level and a bad server as fatal", () => {
    expect(isServerFailure("timeout")).toBe(false);
    expect(isServerFailure("bad_response")).toBe(false);
    expect(isServerFailure("unreachable")).toBe(true);
    expect(isServerFailure("rejected")).toBe(true);
  });
});

describe("ocrPage", () => {
  it("reports a closed port as unreachable", async () => {
    const result = await ocrPage(page1, deadOcrSettings());
    expect(result).toMatchObject({ ok: false, page: 1, reason: "unreachable" });
  });
});

describe("ocrPages", () => {
  it("stops at the first server-level failure instead of hammering a dead endpoint", async () => {
    const outcomes = await ocrPages([page1, page2], deadOcrSettings());
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ ok: false, page: 1, reason: "unreachable" });
  });
});

describe("probeOcrEndpoint", () => {
  it("fails when nothing is listening", async () => {
    const result = await probeOcrEndpoint(deadOcrSettings());
    expect(result.ok).toBe(false);
  });
});

describe.skipIf(!liveOcr)("ocrPages and probeOcrEndpoint (live OCR endpoint)", () => {
  it(
    "reads every page in order and returns one outcome per page",
    async () => {
      const outcomes = await ocrPages([page1, page2], requireLiveOcr());
      expect(outcomes).toMatchObject([
        { ok: true, page: 1, text: expect.any(String) },
        { ok: true, page: 2, text: expect.any(String) },
      ]);
    },
    2 * LIVE_PAGE_TIMEOUT_MS,
  );

  it(
    "lists the model ids the endpoint serves",
    async () => {
      const result = await probeOcrEndpoint(requireLiveOcr());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBeGreaterThan(0);
      expect(result.value.every((id) => typeof id === "string")).toBe(true);
    },
    30_000,
  );
});
