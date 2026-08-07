import type { ModelCard } from "./index.js";

/** Fallback for any model no family claims: a plain markdown ask, greedy decoding. */
export const fallbackModelCard: ModelCard = {
  // Reached by fallback only; this family can never claim an id.
  family: /(?!)/,
  // No id of its own: the configured id is always sent as-is.
  model: "",
  prompt:
    "Convert this page to markdown. Preserve all text, numbers, and tables exactly as they appear.",
  params: { temperature: 0, top_p: 1, max_tokens: 4096 },
  render: { dpi: 200, maxLongestDimPx: 1800 },
};
