import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type {
  ChatCompletionContentPart,
  ChatCompletionUserMessageParam,
} from "openai/resources/chat/completions";
import { tryExecute, type Result } from "../core/result.js";
import {
  resolveCapabilities,
  type CapabilityQuery,
  type ModelCapabilities,
} from "../model/capabilities.js";
import type { OpenLedgerArtifacts, PageImageArtifact } from "../oled/artifacts.js";
import type { OperationalNote } from "../report/events.js";

/**
 * Hands back exactly what oled produced, verbatim: no opening, parsing, or
 * summarizing here. Doing the model's work here would leave nothing to measure.
 */

export interface TransportPlan {
  capabilities: ModelCapabilities;
  /** The extracted document, carried as one text part. */
  text: boolean;
  /** Page images, carried as one part each. */
  images: boolean;
}

interface Attached {
  /** The message carrying the bytes, or null when no route applied. */
  message: ChatCompletionUserMessageParam | null;
  notes: OperationalNote[];
}

// A 6-page statement rasterized at 200 dpi measures 1.9 MB, so these bound a
// runaway (a long statement) well clear of the expected path.
const MAX_ATTACHED_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHED_PAGES = 16;

function dataUri(mediaType: string, bytes: Buffer): string {
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}

function count(total: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? "" : "s"}`;
}

/**
 * Fails here when the model accepts neither text nor image, before any
 * sandbox work: the alternative is a zero-row report that blames the model
 * for the harness.
 */
export async function planHostTransport(query: CapabilityQuery): Promise<Result<TransportPlan>> {
  const probed = await resolveCapabilities(query);
  if (!probed.ok) return probed;

  const capabilities = probed.value;
  const plan: TransportPlan = {
    capabilities,
    text: capabilities.modalities.includes("text"),
    images: capabilities.modalities.includes("image"),
  };
  if (!plan.text && !plan.images) {
    return {
      ok: false,
      error:
        `${query.model} accepts ${capabilities.modalities.join(", ")} and nothing else (${capabilities.detail}). ` +
        `OpenLedger hands a statement back as extracted text or as page images, and the model cannot be sent either, ` +
        `so it cannot read the statement and cannot be scored on this task. Run a model that accepts text or image input.`,
    };
  }
  return { ok: true, value: plan };
}

/** How a statement can reach this model, in the order the routes are tried. */
export function transportNames(plan: TransportPlan): string[] {
  const names: string[] = [];
  if (plan.text) names.push("the extracted document as text");
  if (plan.images) names.push("page images");
  return names;
}

/** Names the files and where they came from. Anything more would be coaching. */
function sourceOf(paths: string[]): string {
  return `${paths.map((path) => basename(path)).join(", ")} in ${dirname(paths[0] ?? "")}`;
}

/** Named in the note, never to the model: a hole in the document is the operator's problem to see. */
function placeholders(failedPages: number[]): string {
  if (failedPages.length === 0) return "";
  return `, ${count(failedPages.length, "page")} carrying an OCR placeholder (${failedPages.join(", ")})`;
}

async function attachDocument(path: string, failedPages: number[]): Promise<Attached> {
  const read = await tryExecute(() => readFile(path));
  if (!read.ok) {
    return {
      message: null,
      notes: [{ operation: "artifacts_unreadable", detail: `${path}: ${read.error}` }],
    };
  }
  const bytes = read.value.byteLength;
  if (bytes > MAX_ATTACHED_BYTES) {
    return {
      message: null,
      notes: [
        {
          operation: "artifacts_capped",
          detail: `${path} is ${bytes} bytes, over the ${MAX_ATTACHED_BYTES}-byte cap`,
        },
      ],
    };
  }

  return {
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: `Attached: the document the command above produced, ${sourceOf([path])}.`,
        },
        { type: "text", text: read.value.toString("utf8") },
      ],
    },
    notes: [
      {
        operation: "artifacts_attached",
        detail: `the document ${path}, ${bytes} bytes${placeholders(failedPages)}`,
      },
    ],
  };
}

async function attachPages(pages: PageImageArtifact[]): Promise<Attached> {
  const notes: OperationalNote[] = [];
  const wanted = pages.slice(0, MAX_ATTACHED_PAGES);
  if (wanted.length < pages.length) {
    notes.push({
      operation: "artifacts_capped",
      detail: `${pages.length} pages produced, ${MAX_ATTACHED_PAGES}-page cap: attached the first ${wanted.length}`,
    });
  }

  const parts: ChatCompletionContentPart[] = [];
  const attached: string[] = [];
  let bytes = 0;
  for (const page of wanted) {
    const read = await tryExecute(() => readFile(page.path));
    if (!read.ok) {
      notes.push({ operation: "artifacts_unreadable", detail: `${page.path}: ${read.error}` });
      continue;
    }
    if (bytes + read.value.byteLength > MAX_ATTACHED_BYTES) {
      notes.push({
        operation: "artifacts_capped",
        detail: `${MAX_ATTACHED_BYTES}-byte cap reached: attached ${attached.length} of ${pages.length} pages`,
      });
      break;
    }
    bytes += read.value.byteLength;
    attached.push(page.path);
    parts.push({ type: "image_url", image_url: { url: dataUri(page.mediaType, read.value) } });
  }

  if (parts.length === 0) return { message: null, notes };

  notes.push({
    operation: "artifacts_attached",
    detail: `${count(parts.length, "page image")}, ${bytes} bytes, from ${dirname(attached[0] ?? "")}`,
  });
  return {
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: `Attached: ${count(parts.length, "page image")} the command above produced, in page order: ${sourceOf(attached)}.`,
        },
        ...parts,
      ],
    },
    notes,
  };
}

function describe(artifacts: OpenLedgerArtifacts): string {
  if (artifacts.document) return `the document ${artifacts.document}`;
  return count(artifacts.pages.length, "page image");
}

/**
 * Neither route applying means nothing is attached: degrading from there is
 * what `oled ingest prepare --help` tells the model to do, and whether it
 * finds that is what is being measured.
 */
export async function attachArtifacts(
  plan: TransportPlan,
  artifacts: OpenLedgerArtifacts,
): Promise<Attached> {
  if (artifacts.document && plan.text) {
    return attachDocument(artifacts.document, artifacts.failedPages);
  }
  if (artifacts.pages.length > 0 && plan.images) return attachPages(artifacts.pages);
  return {
    message: null,
    notes: [
      {
        operation: "artifacts_no_route",
        detail: `${describe(artifacts)}: the model accepts ${plan.capabilities.modalities.join(", ")}`,
      },
    ],
  };
}
