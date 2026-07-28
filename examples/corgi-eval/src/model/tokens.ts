import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// One estimator for the whole run, so the trimmer and the reported counts
// cannot disagree.

const CHARS_PER_TOKEN = 4;

// Attachments are charged flat, not per character — base64 isn't text, and
// per-character charging would make the trimmer discard real history for one image.
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
