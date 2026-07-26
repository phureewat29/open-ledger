import * as z from "zod";
import { MODALITIES, type Modality } from "./model/capabilities.js";

export interface Config {
  baseUrl: string;
  apiKey: string;
  model: string;
  stream: boolean;
  timeoutMs: number;
  /** Set by hand; null lets the model's own window decide. */
  contextBudgetTokens: number | null;
  /** Declared by hand for an endpoint that publishes no model list; null probes instead. */
  inputModalities: Modality[] | null;
  keepWorkspace: boolean;
}

/** main reads `kind`: help prints and exits 0, usage exits 2. */
export interface ConfigFailure {
  ok: false;
  reason: "help" | "usage";
  message: string;
}

export type ConfigResult = { ok: true; value: Config } | ConfigFailure;

export const HELP = `corgi-eval — an eval of how well a model and the plasalid contract work together

  npm start [-- <flags>]

  --base-url <url>   endpoint to call (default LLM_BASE_URL)
  --model <name>     model to ask for (default LLM_MODEL)
  --keep             keep the sandbox directory instead of deleting it
  -h, --help         this text

Endpoint settings come from .env (see .env.example): LLM_BASE_URL, LLM_API_KEY,
LLM_MODEL, LLM_STREAM, LLM_TIMEOUT_MS, LLM_INPUT_MODALITIES, CONTEXT_BUDGET_TOKENS.

The model must accept image or file input, because a statement reaches it as PNG
pages or as a PDF. On OpenRouter both that and the model's window are read from
the model list; on any other endpoint set LLM_INPUT_MODALITIES=text,image.
`;

/** A comma list, so one bad value fails at startup instead of mid-run. */
const MODALITY_LIST = z
  .string()
  .transform((value) => value.split(",").map((part) => part.trim()).filter(Boolean))
  .pipe(z.array(z.enum(MODALITIES)).min(1));

const ENV_SPEC = z.object({
  LLM_BASE_URL: z.string().min(1).default("http://localhost:11434/v1"),
  LLM_API_KEY: z.string().min(1).default("unused"),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_STREAM: z.enum(["true", "false"]).default("true"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  LLM_INPUT_MODALITIES: MODALITY_LIST.optional(),
  CONTEXT_BUDGET_TOKENS: z.coerce.number().int().positive().optional(),
});

interface Flags {
  baseUrl?: string;
  model?: string;
  keepWorkspace: boolean;
}

const VALUE_FLAGS = new Set(["--base-url", "--model"]);

function usage(message: string): ConfigFailure {
  return { ok: false, reason: "usage", message };
}

function parseFlags(argv: string[]): { ok: true; value: Flags } | ConfigFailure {
  const flags: Flags = { keepWorkspace: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "-h" || arg === "--help") return { ok: false, reason: "help", message: HELP };
    if (arg === "--keep") {
      flags.keepWorkspace = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) return usage(`unknown flag: ${arg}`);

    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) return usage(`${arg} needs a value`);
    i++;
    if (arg === "--base-url") flags.baseUrl = value;
    if (arg === "--model") flags.model = value;
  }
  return { ok: true, value: flags };
}

/** Drops blank env values so a `KEY=` line in .env falls back to the default. */
function presentEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== "") out[key] = value;
  }
  return out;
}

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv): ConfigResult {
  const flags = parseFlags(argv);
  if (!flags.ok) return flags;

  const parsed = ENV_SPEC.safeParse(presentEnv(env));
  if (!parsed.success) return usage(z.prettifyError(parsed.error));

  const model = flags.value.model ?? parsed.data.LLM_MODEL;
  if (!model) return usage("no model: set LLM_MODEL in .env or pass --model");

  return {
    ok: true,
    value: {
      baseUrl: flags.value.baseUrl ?? parsed.data.LLM_BASE_URL,
      apiKey: parsed.data.LLM_API_KEY,
      model,
      stream: parsed.data.LLM_STREAM === "true",
      timeoutMs: parsed.data.LLM_TIMEOUT_MS,
      contextBudgetTokens: parsed.data.CONTEXT_BUDGET_TOKENS ?? null,
      inputModalities: parsed.data.LLM_INPUT_MODALITIES ?? null,
      keepWorkspace: flags.value.keepWorkspace,
    },
  };
}

export function modelSlug(config: Config): string {
  return (
    config.model
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "model"
  );
}
