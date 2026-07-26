import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Result } from "../core/result.js";
import type { ChatFailure, ChatModel, ChatReply } from "../model/chat.js";
import { estimateTokens } from "../model/tokens.js";
import type { Phase } from "../scenario.js";
import type { EventSink, PhaseExit, PhaseId } from "../report/events.js";
import { attachArtifacts, type TransportPlan } from "./attach.js";
import { findTool, toolSpecs, unknownToolResult, type Tool } from "./tools.js";

/**
 * The turn loop. It emits what the model tried and what came back; the three
 * things it does — one retry, one stall prod, and handing back the files a
 * command produced — are emitted as operational events, which the eval excludes
 * by design.
 */

/**
 * Run-level, never per phase: friction is read across the whole run, and a count
 * that restarted would make two phases' calls look like one turn.
 */
export interface TurnCounter {
  count: number;
}

export interface RunnerDeps {
  model: ChatModel;
  tools: Tool[];
  /** How what plasalid produces reaches this model. */
  transport: TransportPlan;
  emit: EventSink;
  contextBudgetTokens: number;
  turns: TurnCounter;
}

const MAX_CALLS_PER_PHASE = 32;
const MAX_STALL_PRODS = 2;
const CONTINUE_PROMPT = "Continue. Use a tool or give your answer.";
const MAX_REPLY_ECHO = 4_000;
const TRIMMED_PLACEHOLDER = "[tool result dropped by the context guard]";

/**
 * Drops the OLDEST tool results first, replacing the content instead of removing
 * the message so every tool_call still has its answer. The system prompt and the
 * user's turns are never touched, which is what keeps an attachment out of reach:
 * the statement the host handed over stays for the whole run.
 */
function trimContext(
  deps: RunnerDeps,
  messages: ChatCompletionMessageParam[],
  phase: PhaseId,
): void {
  while (estimateTokens(messages) > deps.contextBudgetTokens) {
    const index = messages.findIndex(
      (message) => message.role === "tool" && message.content !== TRIMMED_PLACEHOLDER,
    );
    const message = messages[index];
    if (index < 0 || message?.role !== "tool") return;
    messages[index] = { ...message, content: TRIMMED_PLACEHOLDER };
    deps.emit({ type: "context_trim", phase });
  }
}

function describe(phase: PhaseId, err: ChatFailure): string {
  return `${phase}: the endpoint failed (${err.status ?? "no status"}): ${err.message}`;
}

/** One retry, and only for a transient failure. */
async function complete(
  deps: RunnerDeps,
  messages: ChatCompletionMessageParam[],
  phase: PhaseId,
): Promise<Result<ChatReply>> {
  const specs = toolSpecs(deps.tools);
  const first = await deps.model.complete(messages, specs);
  if (first.ok) return first;
  if (first.reason !== "transient") return { ok: false, error: describe(phase, first) };

  deps.emit({
    type: "operational",
    phase,
    operation: "endpoint_retry",
    detail: `retried after ${first.status ?? "no"} status: ${first.message}`,
  });
  const second = await deps.model.complete(messages, specs);
  if (!second.ok) return { ok: false, error: describe(phase, second) };
  return second;
}

interface Invoked {
  answer: ChatCompletionMessageParam;
  /** What the host carried back, pushed only once every tool_call has its answer. */
  attachment: ChatCompletionMessageParam | null;
}

async function runToolCall(
  deps: RunnerDeps,
  phase: PhaseId,
  turn: number,
  call: { id: string; name: string; args: string },
): Promise<Invoked> {
  const tool = findTool(deps.tools, call.name);
  const result = tool
    ? await tool.invoke(call.args)
    : unknownToolResult(
        call.name,
        deps.tools.map((known) => known.name),
      );
  deps.emit({ type: "tool_call", phase, turn, ...result.observation });

  const answer: ChatCompletionMessageParam = {
    role: "tool",
    tool_call_id: call.id,
    content: result.content,
  };
  if (!result.artifacts) return { answer, attachment: null };

  const attached = await attachArtifacts(deps.transport, result.artifacts);
  for (const note of attached.notes) deps.emit({ type: "operational", phase, ...note });
  return { answer, attachment: attached.message };
}

/**
 * Runs one phase against the shared message history. A failure means the
 * endpoint itself is unusable; everything the model gets wrong is recorded,
 * not raised.
 */
export async function runPhase(
  deps: RunnerDeps,
  messages: ChatCompletionMessageParam[],
  phase: Phase,
): Promise<Result<string>> {
  deps.emit({ type: "phase_start", phase: phase.id, title: phase.title });
  messages.push({ role: "user", content: phase.prompt });

  let reply = "";
  let prods = 0;
  // Only a loop that runs out of calls leaves this untouched.
  let exit: PhaseExit = "call_cap";
  for (let call = 0; call < MAX_CALLS_PER_PHASE; call++) {
    trimContext(deps, messages, phase.id);
    const completion = await complete(deps, messages, phase.id);
    if (!completion.ok) return completion;

    const answer = completion.value;
    deps.turns.count += 1;
    const turn = deps.turns.count;
    deps.emit({
      type: "llm_call",
      phase: phase.id,
      turn,
      content: answer.content.trim().slice(0, MAX_REPLY_ECHO),
      finishReason: answer.finishReason,
      toolCalls: answer.toolCalls.length,
      usage: answer.usage,
    });
    messages.push(answer.assistant);
    if (answer.content.trim()) reply = answer.content.trim();

    if (answer.toolCalls.length > 0) {
      const attachments: ChatCompletionMessageParam[] = [];
      for (const toolCall of answer.toolCalls) {
        const invoked = await runToolCall(deps, phase.id, turn, toolCall);
        messages.push(invoked.answer);
        if (invoked.attachment) attachments.push(invoked.attachment);
      }
      // After the answers, never between them: a user turn in the middle would
      // leave a tool_call unanswered and the endpoint rejects the request.
      messages.push(...attachments);
      continue;
    }

    if (answer.content.trim()) {
      exit = "answered";
      break;
    }
    if (prods >= MAX_STALL_PRODS) {
      exit = "stalled";
      break;
    }
    prods += 1;
    deps.emit({
      type: "operational",
      phase: phase.id,
      operation: "stall_prod",
      detail: `prod ${prods}: empty reply with no tool call`,
    });
    messages.push({ role: "user", content: CONTINUE_PROMPT });
  }

  deps.emit({ type: "phase_end", phase: phase.id, reply, exit });
  return { ok: true, value: reply };
}
