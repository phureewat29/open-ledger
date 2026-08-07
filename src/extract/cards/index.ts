/** A model card pairs a model's prescribed prompt, sampling, and render spec; this folder is the only place in src/ that names a model. */

import type { RenderSpec } from "../pdf.js";
import { fallbackModelCard } from "./fallback.js";
import { typhoonModelCard } from "./typhoon-ocr1.5.js";

/** Wire names: spread straight into the request body. */
export interface OCRParams {
  temperature: number;
  top_p: number;
  max_tokens: number;
  /** Set only where a fixed seed is prescribed; endpoints that ignore it are unaffected. */
  seed?: number;
}

export interface ModelCard {
  /** The model ids this card is written for, matched against the configured id. */
  family: RegExp;
  model: string;
  prompt: string;
  params: OCRParams;
  render: RenderSpec;
}

export type ModelCardName = "typhoon" | "fallback";

/** Exhaustive by construction: a new ModelCardName breaks the build until it is listed. */
export const MODEL_CARDS: Record<ModelCardName, ModelCard> = {
  typhoon: typhoonModelCard,
  fallback: fallbackModelCard,
};

export const MODEL_CARD_NAMES = Object.keys(MODEL_CARDS) as ModelCardName[];

/** Supplies the model when none is configured. */
const DEFAULT_MODEL_CARD: ModelCardName = "typhoon";

/** Any configured id no family claims. */
const FALLBACK_MODEL_CARD: ModelCardName = "fallback";

/** An empty id reads with the default model card and its own model; an id no family claims is sent as-is with the fallback card. */
export function modelCardFor(modelId: string): { name: ModelCardName; card: ModelCard } {
  if (!modelId) return { name: DEFAULT_MODEL_CARD, card: MODEL_CARDS[DEFAULT_MODEL_CARD] };
  const name =
    MODEL_CARD_NAMES.find((key) => MODEL_CARDS[key].family.test(modelId)) ?? FALLBACK_MODEL_CARD;
  return { name, card: MODEL_CARDS[name] };
}
