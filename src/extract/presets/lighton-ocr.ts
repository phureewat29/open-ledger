import type { OcrPreset } from "./index.js";

/**
 * LightOnOCR-2-1B: trained on 11 languages, Thai not among them. Answers in plain
 * markdown (no wrapper to unwrap); its card prescribes 200 DPI, longest side 1540px.
 */
export const lightonOcrPreset: OcrPreset = {
  family: /lighton/i,
  model: "lightonocr-2-1b",
  prompt:
    "Convert this page to markdown. Preserve all text, numbers, and tables exactly as they appear.",
  // The card prescribes greedy decoding, which leaves top_p at the API default and needs no seed.
  params: { temperature: 0, top_p: 1, max_tokens: 4096 },
  render: { dpi: 200, maxLongestDimPx: 1540 },
};
