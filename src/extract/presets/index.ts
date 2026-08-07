/** A preset pairs a model's prescribed prompt, sampling, and render spec; this folder is the only place in src/ that names a model. */

import type { RenderSpec } from "../pdf.js";
import { lightonOcrPreset } from "./lighton-ocr.js";
import { typhoonOcrPreset } from "./typhoon-ocr.js";

/** Wire names: spread straight into the request body. */
export interface OCRParams {
  temperature: number;
  top_p: number;
  max_tokens: number;
  /** Set only where a fixed seed is prescribed; endpoints that ignore it are unaffected. */
  seed?: number;
}

export interface OCRPreset {
  /** The model ids this preset is written for, matched against the configured id. */
  family: RegExp;
  model: string;
  prompt: string;
  params: OCRParams;
  render: RenderSpec;
}

export type PresetName = "typhoon-ocr" | "lighton-ocr";

/** Exhaustive by construction: a new PresetName breaks the build until it is listed. */
export const PRESETS: Record<PresetName, OCRPreset> = {
  "typhoon-ocr": typhoonOcrPreset,
  "lighton-ocr": lightonOcrPreset,
};

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

const HOUSE_PRESET: PresetName = "typhoon-ocr";

/** An unrecognized (or empty) model id falls back to the house preset, using its own model id. */
export function presetForModel(modelId: string): { name: PresetName; preset: OCRPreset } {
  const name = PRESET_NAMES.find((key) => PRESETS[key].family.test(modelId)) ?? HOUSE_PRESET;
  return { name, preset: PRESETS[name] };
}
