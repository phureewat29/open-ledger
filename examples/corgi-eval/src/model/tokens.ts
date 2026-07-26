import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * One estimator for the whole run, so the trimmer and the reported token counts
 * cannot disagree. Attached bytes are counted at a flat rate per part: base64 is
 * not text, and charging it by the character would have the trimmer throw away
 * the model's own history to pay for one page image.
 */

const CHARS_PER_TOKEN = 4;

// A statement page at 200 dpi costs roughly this much as an image; its base64
// text is about ten times longer.
const TOKENS_PER_ATTACHED_PART = 1_600;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function partTokens(part: { type: string; text?: string }): number {
  if (part.type === "text") return estimateTextTokens(part.text ?? "");
  return TOKENS_PER_ATTACHED_PART;
}

function messageTokens(message: ChatCompletionMessageParam): number {
  const content = message.content;
  if (!Array.isArray(content)) return estimateTextTokens(JSON.stringify(message));
  return content.reduce((sum, part) => sum + partTokens(part), 0);
}

export function estimateTokens(messages: ChatCompletionMessageParam[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}
