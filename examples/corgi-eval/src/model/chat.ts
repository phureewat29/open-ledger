import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { errorMessage } from "../core/result.js";
import type { Config } from "../config.js";
import type { TokenUsage } from "../report/events.js";
import { estimateTextTokens, estimateTokens } from "./tokens.js";

// Retry loop lives in the runner, not here.

interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON string from the model, validated by the tool it names. */
  args: string;
}

export interface ChatReply {
  content: string;
  toolCalls: ToolCallRequest[];
  finishReason: string | null;
  usage: TokenUsage;
  assistant: ChatCompletionAssistantMessageParam;
}

export interface ChatFailure {
  ok: false;
  /** transient is worth exactly one retry; fatal never is. */
  reason: "transient" | "fatal";
  status: number | null;
  message: string;
}

type ChatResult = { ok: true; value: ChatReply } | ChatFailure;

export interface ChatModel {
  complete(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
  ): Promise<ChatResult>;
}

const RETRYABLE_STATUS = new Set([408, 409, 429]);

function isFunctionCall(
  call: ChatCompletionMessageToolCall,
): call is Extract<ChatCompletionMessageToolCall, { type: "function" }> {
  return call.type === "function";
}

function classify(cause: unknown): ChatFailure {
  if (cause instanceof OpenAI.APIError) {
    const status = cause.status ?? null;
    const transient = status === null || status >= 500 || RETRYABLE_STATUS.has(status);
    return { ok: false, reason: transient ? "transient" : "fatal", status, message: cause.message };
  }
  return { ok: false, reason: "transient", status: null, message: errorMessage(cause) };
}

/** Declared as estimated in the report so nobody reads it as measured. */
function estimate(messages: ChatCompletionMessageParam[], reply: string): TokenUsage {
  return {
    promptTokens: estimateTokens(messages),
    completionTokens: estimateTextTokens(reply),
    estimated: true,
  };
}

function toReply(
  completion: ChatCompletion,
  messages: ChatCompletionMessageParam[],
): ChatResult {
  const choice = completion.choices[0];
  if (!choice) {
    return { ok: false, reason: "fatal", status: null, message: "the endpoint returned no choices" };
  }
  const rawCalls = (choice.message.tool_calls ?? []).filter(isFunctionCall);
  const content = choice.message.content ?? "";
  const assistant: ChatCompletionAssistantMessageParam = {
    role: "assistant",
    content: content || null,
    ...(rawCalls.length > 0 ? { tool_calls: rawCalls } : {}),
  };
  const usage = completion.usage
    ? {
        promptTokens: completion.usage.prompt_tokens,
        completionTokens: completion.usage.completion_tokens,
        estimated: false,
      }
    : estimate(messages, content + JSON.stringify(rawCalls));

  return {
    ok: true,
    value: {
      content,
      toolCalls: rawCalls.map((call) => ({
        id: call.id,
        name: call.function.name,
        args: call.function.arguments,
      })),
      finishReason: choice.finish_reason ?? null,
      usage,
      assistant,
    },
  };
}

export function createOpenAiCompatibleModel(config: Config): ChatModel {
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: 0,
  });

  const request = async (
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
  ): Promise<ChatCompletion> => {
    const body = { model: config.model, messages, tools, tool_choice: "auto" as const };
    if (!config.stream) return client.chat.completions.create({ ...body, stream: false });
    const stream = client.chat.completions.stream({
      ...body,
      stream_options: { include_usage: true },
    });
    return stream.finalChatCompletion();
  };

  return {
    complete(messages, tools) {
      // Rejection handler, not a Result: classify needs the thrown APIError itself.
      return request(messages, tools).then((completion) => toReply(completion, messages), classify);
    },
  };
}
