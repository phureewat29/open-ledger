import type { OcrPreset } from "./index.js";

/** LightOnOCR-2-1B: 11 languages, Thai not among them. Plain markdown, no wrapper. Card prescribes 200 DPI, 1540px longest side. */
export const lightonOcrPreset: OcrPreset = {
  family: /lighton/i,
  model: "lightonocr-2-1b",
  prompt:
    "Convert this page to markdown. Preserve all text, numbers, and tables exactly as they appear.",
  // The card prescribes greedy decoding, which leaves top_p at the API default and needs no seed.
  params: { temperature: 0, top_p: 1, max_tokens: 4096 },
  render: { dpi: 200, maxLongestDimPx: 1540 },
};
