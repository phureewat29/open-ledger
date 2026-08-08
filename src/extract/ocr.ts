import * as z from "zod";
import type { OpenLedgerConfig } from "../config.js";
import { tryExecute, type Result } from "../lib/result.js";
import type { PageImage, RenderSpec } from "./pdf.js";
import { modelCardFor, type ModelCardName, type OCRParams } from "./cards/index.js";

/** A small local model can spend minutes on a dense page; this is a stuck-server bound, not a target. */
export const OCR_TIMEOUT_MS = 300_000;

// A stalled server can outlive the abort, so a second bound races it.
const TIMEOUT_GRACE_MS = 5_000;

/** A liveness check, not a read: bounded independently of the per-page timeout. */
const PROBE_TIMEOUT_MS = 5_000;

const ERROR_BODY_CHARS = 200;

export interface OCRSettings {
  /** Includes the version segment, no trailing slash: `http://127.0.0.1:1234/v1`. */
  baseUrl: string;
  /** `ocrModel` when set, otherwise the default model card's own model; `resolveServedModel` re-spells it to the served id. */
  model: string;
  /** `""` when the endpoint needs no auth (the local case). */
  apiKey: string;
  timeoutMs: number;
  /** Which model card the id selected; internal, not part of the request. */
  modelCard: ModelCardName;
  prompt: string;
  params: OCRParams;
  render: RenderSpec;
}

export type OCRConfigSource = Pick<OpenLedgerConfig, "ocrBaseUrl" | "ocrModel" | "ocrApiKey">;

/** The endpoint URL alone decides whether OCR is configured; `null` means cleanly unset. */
export function resolveOcr(source: OCRConfigSource): OCRSettings | null {
  const baseUrl = source.ocrBaseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) return null;

  const configured = source.ocrModel.trim();
  const { name, card } = modelCardFor(configured);

  return {
    baseUrl,
    model: configured || card.model,
    apiKey: source.ocrApiKey.trim(),
    timeoutMs: OCR_TIMEOUT_MS,
    modelCard: name,
    prompt: card.prompt,
    params: card.params,
    render: card.render,
  };
}

type OCRFailure = "timeout" | "bad_response" | "unreachable" | "rejected";
export type ServerFailure = Extract<OCRFailure, "unreachable" | "rejected">;

// Exhaustive by construction: a new OCRFailure must be classified here to compile.
const PAGE_LEVEL: Record<OCRFailure, boolean> = {
  timeout: true,
  bad_response: true,
  unreachable: false,
  rejected: false,
};

/** Page-level failures leave a placeholder and continue; server-level failures abort the run. */
export function isServerFailure(reason: OCRFailure): reason is ServerFailure {
  return !PAGE_LEVEL[reason];
}

export type OCRPageOutcome =
  | { ok: true; page: number; text: string }
  | { ok: false; page: number; reason: OCRFailure; message: string };

const RESPONSE = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

const MODELS = z.object({ data: z.array(z.object({ id: z.string() })) });

function headersFor(settings: OCRSettings): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Local servers reject an empty bearer token, so the header appears only when there is a key.
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

function requestBody(image: PageImage, settings: OCRSettings): string {
  return JSON.stringify({
    model: settings.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: settings.prompt },
          {
            type: "image_url",
            image_url: { url: `data:${image.mime};base64,${image.bytes.toString("base64")}` },
          },
        ],
      },
    ],
    ...settings.params,
    stream: false,
  });
}

function failed(page: number, reason: OCRFailure, message: string): OCRPageOutcome {
  return { ok: false, page, reason, message };
}

function clip(body: string): string {
  return body.length > ERROR_BODY_CHARS ? `${body.slice(0, ERROR_BODY_CHARS)}…` : body;
}

const TIMED_OUT = Symbol("ocr-timeout");

export async function ocrPage(image: PageImage, settings: OCRSettings): Promise<OCRPageOutcome> {
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), settings.timeoutMs);
  const attempt = tryExecute(async () => {
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headersFor(settings),
      body: requestBody(image, settings),
      signal: controller.signal,
    });
    return { status: response.status, body: await response.text() };
  });

  let deadline: NodeJS.Timeout | undefined;
  const bound = new Promise<typeof TIMED_OUT>((resolve) => {
    deadline = setTimeout(() => resolve(TIMED_OUT), settings.timeoutMs + TIMEOUT_GRACE_MS);
    deadline.unref();
  });
  const raced = await Promise.race([attempt, bound]);
  clearTimeout(abort);
  clearTimeout(deadline);

  if (raced === TIMED_OUT) {
    return failed(image.page, "timeout", `no response within ${settings.timeoutMs}ms`);
  }
  if (!raced.ok && controller.signal.aborted) {
    return failed(image.page, "timeout", `aborted after ${settings.timeoutMs}ms`);
  }
  if (!raced.ok) return failed(image.page, "unreachable", raced.error);

  const { status, body } = raced.value;
  if (status < 200 || status >= 300) {
    return failed(image.page, "rejected", `HTTP ${status}: ${clip(body)}`);
  }
  const json = tryExecute(() => JSON.parse(body) as unknown);
  if (!json.ok) return failed(image.page, "bad_response", json.error);
  const parsed = RESPONSE.safeParse(json.value);
  if (!parsed.success) {
    return failed(image.page, "bad_response", z.prettifyError(parsed.error));
  }
  return { ok: true, page: image.page, text: parsed.data.choices[0].message.content };
}

/**
 * Sequential: the endpoint serves one model, so parallel requests would only
 * queue. Stops early on a server-level failure.
 */
export async function ocrPages(
  images: readonly PageImage[],
  settings: OCRSettings,
): Promise<OCRPageOutcome[]> {
  const outcomes: OCRPageOutcome[] = [];
  for (const image of images) {
    const outcome = await ocrPage(image, settings);
    outcomes.push(outcome);
    if (!outcome.ok && isServerFailure(outcome.reason)) break;
  }
  return outcomes;
}

/** The model ids the endpoint serves. */
export async function probeOcrEndpoint(settings: OCRSettings): Promise<Result<string[]>> {
  const response = await tryExecute(async () => {
    const res = await fetch(`${settings.baseUrl}/models`, {
      headers: headersFor(settings),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res.json() as Promise<unknown>;
  });
  if (!response.ok) return response;

  const parsed = MODELS.safeParse(response.value);
  if (!parsed.success) {
    return { ok: false, error: `unexpected /models response: ${z.prettifyError(parsed.error)}` };
  }
  return { ok: true, value: parsed.data.data.map((model) => model.id) };
}

/** The served id the configured id selects: exact spelling first, else the first id containing it, case-insensitive. */
export function pickServedModel(configured: string, served: readonly string[]): string | null {
  if (!configured) return null;
  if (served.includes(configured)) return configured;
  const wanted = configured.toLowerCase();
  return served.find((id) => id.toLowerCase().includes(wanted)) ?? null;
}

/** Re-spells `model` to the id the endpoint serves and re-reads the card from it; unreachable or unmatched keeps the configured settings, the server stays the authority. */
export async function resolveServedModel(settings: OCRSettings): Promise<OCRSettings> {
  const served = await probeOcrEndpoint(settings);
  if (!served.ok) return settings;
  const match = pickServedModel(settings.model, served.value);
  if (!match || match === settings.model) return settings;
  const { name, card } = modelCardFor(match);
  return {
    ...settings,
    model: match,
    modelCard: name,
    prompt: card.prompt,
    params: card.params,
    render: card.render,
  };
}
