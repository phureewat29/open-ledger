import * as z from "zod";
import { tryExecute, type Result } from "../core/result.js";

/**
 * Modalities and context budget must both be known before the run starts:
 * getting either wrong misattributes an endpoint failure to the model.
 */

export const MODALITIES = ["text", "image"] as const;

export type Modality = (typeof MODALITIES)[number];

/** env: declared by hand. openrouter: read from the model list. assumed: any other endpoint. */
export type ModalitySource = "env" | "openrouter" | "assumed";

export interface ModelCapabilities {
  modalities: Modality[];
  source: ModalitySource;
  contextLength: number | null;
  detail: string;
}

export interface CapabilityQuery {
  baseUrl: string;
  model: string;
  /** LLM_INPUT_MODALITIES, which answers the question and skips the probe. */
  override: Modality[] | null;
}

export const MODALITIES_ENV = "LLM_INPUT_MODALITIES";

// Appended to every resolution failure, so the operator always has a way out.
const DECLARE_INSTEAD =
  `OpenLedger hands a statement back as extracted text or as page images, so the eval has to know which of them the model can take. ` +
  `Set ${MODALITIES_ENV}=text,image and run again.`;

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const PROBE_TIMEOUT_MS = 15_000;
const ASSUMED: Modality[] = ["text", "image"];

const MODEL_LIST = z.object({ data: z.array(z.unknown()) });

const MODEL_ROW = z.object({
  id: z.string(),
  architecture: z.object({ input_modalities: z.array(z.string()) }),
  context_length: z.number().positive().optional(),
});

// Ordered per MODALITIES; drops types this host can't send (file, audio, video).
function known(values: string[]): Modality[] {
  return MODALITIES.filter((modality) => values.includes(modality));
}

/** OpenRouter serves variants as `<id>:free`; a variant's architecture is the base model's. */
function baseId(model: string): string {
  return model.split(":")[0] ?? model;
}

function isOpenRouter(baseUrl: string): boolean {
  return baseUrl.includes("openrouter.ai");
}

async function fetchModelList(): Promise<Result<unknown[]>> {
  const response = await tryExecute(() =>
    fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
  );
  if (!response.ok) return { ok: false, error: `the model list did not answer: ${response.error}` };
  if (!response.value.ok) {
    return { ok: false, error: `the model list answered ${response.value.status}` };
  }

  const body = await tryExecute(() => response.value.json());
  if (!body.ok) return { ok: false, error: `the model list was unreadable: ${body.error}` };

  const parsed = MODEL_LIST.safeParse(body.value);
  if (!parsed.success) {
    return {
      ok: false,
      error: `the model list had an unexpected shape: ${z.prettifyError(parsed.error)}`,
    };
  }
  return { ok: true, value: parsed.data.data };
}

type ModelRow = z.infer<typeof MODEL_ROW>;

/** Rows are parsed one at a time: a single odd entry among hundreds must not lose the answer. */
function findRow(rows: unknown[], model: string): ModelRow | null {
  for (const row of rows) {
    const parsed = MODEL_ROW.safeParse(row);
    if (!parsed.success) continue;
    if (baseId(parsed.data.id) !== baseId(model)) continue;
    return parsed.data;
  }
  return null;
}

// A failure here means the model's limits are unknown, never that it's unfit — the operator acts on those differently.
export async function resolveCapabilities(
  query: CapabilityQuery,
): Promise<Result<ModelCapabilities>> {
  if (query.override) {
    return {
      ok: true,
      value: {
        modalities: query.override,
        source: "env",
        contextLength: null,
        detail: `declared by ${MODALITIES_ENV}`,
      },
    };
  }

  if (!isOpenRouter(query.baseUrl)) {
    return {
      ok: true,
      value: {
        modalities: ASSUMED,
        source: "assumed",
        contextLength: null,
        detail: `${query.baseUrl} publishes no model list; assumed text and image, override with ${MODALITIES_ENV}`,
      },
    };
  }

  const rows = await fetchModelList();
  if (!rows.ok) {
    return {
      ok: false,
      error: `cannot tell what input types ${query.model} accepts: ${rows.error}. ${DECLARE_INSTEAD}`,
    };
  }

  const row = findRow(rows.value, query.model);
  if (!row) {
    return {
      ok: false,
      error: `cannot tell what input types ${query.model} accepts: OpenRouter lists ${rows.value.length} models and none carries that id, so check it for a typo. ${DECLARE_INSTEAD}`,
    };
  }

  return {
    ok: true,
    value: {
      modalities: known(row.architecture.input_modalities),
      source: "openrouter",
      contextLength: row.context_length ?? null,
      detail: "read from the OpenRouter model list",
    },
  };
}

/** explicit: declared by hand. derived: a share of the model's own window. default: the endpoint reported none. */
export type BudgetSource = "explicit" | "derived" | "default";

export interface ContextBudget {
  tokens: number;
  source: BudgetSource;
  detail: string;
}

export const BUDGET_ENV = "CONTEXT_BUDGET_TOKENS";

// Room for the reply, and for a chars/4 estimate that runs under the truth.
const WINDOW_SHARE = 0.8;

// Small enough to be safe on a model that reports no window at all.
const DEFAULT_BUDGET_TOKENS = 28_000;

/**
 * The model's own window decides where one is published. An explicit value is
 * obeyed rather than checked against it: an endpoint that publishes no window
 * falls to the default, which a smaller model overflows with no other way out.
 */
export function resolveContextBudget(
  capabilities: ModelCapabilities,
  explicit: number | null,
): ContextBudget {
  if (explicit !== null) {
    return { tokens: explicit, source: "explicit", detail: `${BUDGET_ENV}=${explicit}` };
  }

  const window = capabilities.contextLength;
  if (window === null) {
    return {
      tokens: DEFAULT_BUDGET_TOKENS,
      source: "default",
      detail: `${capabilities.detail}, so no window to derive from; used the ${DEFAULT_BUDGET_TOKENS}-token default`,
    };
  }
  return {
    tokens: Math.floor(window * WINDOW_SHARE),
    source: "derived",
    detail: `${WINDOW_SHARE * 100}% of the model's ${window}-token window`,
  };
}
