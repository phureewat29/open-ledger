import type { OcrPreset } from "./index.js";

// The prompt is the model card's, kept per-preset so a card revision only touches this file.

const PROMPT = `Extract all text from the image.

Instructions:
- Only return the clean Markdown.
- Do not include any explanation or extra text.
- You must include all information on the page.

Formatting Rules:
- Tables: Render tables using <table>...</table> in clean HTML format.
- Equations: Render equations using LaTeX syntax with inline ($...$) and block ($$...$$).
- Images/Charts/Diagrams: Wrap any clearly defined visual areas in: <figure>Describe...</figure>
- Page Numbers: Wrap page numbers in <page_number>...</page_number>
- Checkboxes: Use ☐ for unchecked and ☑ for checked boxes.`;

export const typhoonOcrPreset: OcrPreset = {
  // Every release so far carries the family name, whatever the version suffix.
  family: /typhoon/i,
  model: "typhoon-ocr1.5",
  prompt: PROMPT,
  params: { temperature: 0.1, top_p: 0.6, max_tokens: 4096, seed: 42 },
  // The card trains images at 1800 px on the longest side.
  render: { dpi: 200, maxLongestDimPx: 1800 },
};
