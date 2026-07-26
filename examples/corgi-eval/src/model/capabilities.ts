import * as z from "zod";
import { tryExecute, type Result } from "../core/result.js";

/**
 * What the endpoint says a model can take: which input types, and how big a
 * window. The host has to know both before the run starts. plasalid hands a
 * statement back as a PDF or as PNG pages, so a model that accepts neither
 * cannot be scored on this task; and a budget set above the model's real window
 * turns an endpoint error into what reads like a model failure.
 */

export const MODALITIES = ["text", "image", "file"] as const;

export type Modality = (typeof MODALITIES)[number];

/** env: declared by hand. openrouter: read from the model list. assumed: any other endpoint. */
export type ModalitySource = "env" | "openrouter" | "assumed";

export interface ModelCapabilities {
  modalities: Modality[];
  source: ModalitySource;
  /** The model's window in tokens, when the endpoint reports one. */
  contextLength: number | null;
  /** How the answer was arrived at, kept verbatim in the report. */
  detail: string;
}

export interface CapabilityQuery {
  baseUrl: string;
  model: string;
  /** LLM_INPUT_MODALITIES, which answers the question and skips the probe. */
  override: Modality[] | null;
}

export const MODALITIES_ENV = "LLM_INPUT_MODALITIES";

export const BUDGET_ENV = "CONTEXT_BUDGET_TOKENS";

/**
 * Appended to every failure to resolve the input types, so the operator always
 * has the way out. A model this host cannot deliver to is a different failure.
 */
const DECLARE_INSTEAD =
  `plasalid hands a statement back as a PDF or as PNG pages, so the eval has to know which of them the model can take. ` +
  `Set ${MODALITIES_ENV}=text,image (add file for a model that reads PDFs directly) and run again.`;

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const PROBE_TIMEOUT_MS = 15_000;
const ASSUMED: Modality[] = ["text", "image"];

const MODEL_LIST = z.object({ data: z.array(z.unknown()) });

const MODEL_ROW = z.object({
  id: z.string(),
  architecture: z.object({ input_modalities: z.array(z.string()) }),
  context_length: z.number().positive().optional(),
});

/** In MODALITIES order, without the types this host cannot send (video, audio). */
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

/**
 * A failure here means the model's limits are unknown, never that the model is
 * unfit: the two read differently and the operator acts on them differently.
 */
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

/** explicit: the operator's. derived / clamped: from the model's window. default: nothing to go on. */
export type BudgetSource = "explicit" | "derived" | "clamped" | "default";

export interface ContextBudget {
  tokens: number;
  source: BudgetSource;
  detail: string;
}

// Room for the reply, and for a chars/4 estimate that runs under the truth.
const WINDOW_SHARE = 0.8;

// Small enough to be safe on a model that reports no window at all.
const DEFAULT_BUDGET_TOKENS = 28_000;

/**
 * The budget the trimmer works against. An explicit value above the model's own
 * window is clamped rather than obeyed: overflowing the window returns an
 * endpoint error, which a report would otherwise read as the model's failure.
 */
export function resolveContextBudget(
  capabilities: ModelCapabilities,
  explicit: number | null,
): ContextBudget {
  const window = capabilities.contextLength;
  const share = (tokens: number): number => Math.floor(tokens * WINDOW_SHARE);

  if (window !== null && explicit !== null && explicit > window) {
    return {
      tokens: share(window),
      source: "clamped",
      detail: `${BUDGET_ENV}=${explicit} is over the model's ${window}-token window; clamped to ${WINDOW_SHARE * 100}% of it`,
    };
  }
  if (explicit !== null) {
    return { tokens: explicit, source: "explicit", detail: `${BUDGET_ENV}=${explicit}` };
  }
  if (window !== null) {
    return {
      tokens: share(window),
      source: "derived",
      detail: `${WINDOW_SHARE * 100}% of the model's ${window}-token window`,
    };
  }
  return {
    tokens: DEFAULT_BUDGET_TOKENS,
    source: "default",
    detail: `no window reported and no ${BUDGET_ENV}; used the ${DEFAULT_BUDGET_TOKENS}-token default`,
  };
}
