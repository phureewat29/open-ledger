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
  type Modality,
  type ModelCapabilities,
} from "../model/capabilities.js";
import type { PlasalidArtifacts } from "../plasalid/artifacts.js";
import type { OperationalType } from "../report/events.js";

/**
 * The host's one job with a statement: hand back what the model asked plasalid
 * to produce, in a form the model accepts. That is the service Claude Code's
 * Read performs in examples/corgi-claude, and it stops there. Bytes travel
 * verbatim; nothing here opens, parses, extracts from, or summarizes a
 * statement, because doing the model's work would leave nothing to measure.
 */

export const TRANSPORTS = ["file", "images"] as const;

/** file: the PDF as one file part. images: one part per rasterized page. */
export type TransportKind = (typeof TRANSPORTS)[number];

const TRANSPORT_MODALITY: Record<TransportKind, Modality> = { file: "file", images: "image" };

export interface TransportPlan {
  capabilities: ModelCapabilities;
  /** Routes the model's input types allow, in the order they are tried. */
  kinds: TransportKind[];
}

/** An operational note: what the host delivered, or what it could not. */
export interface AttachmentNote {
  operation: OperationalType;
  detail: string;
}

export interface Attached {
  /** The message carrying the bytes, or null when no route applied. */
  message: ChatCompletionUserMessageParam | null;
  notes: AttachmentNote[];
}

// A 6-page statement at --dpi 200 measures 1.9 MB, so these bound a runaway
// (a long file at a high dpi) well clear of the expected path.
const MAX_ATTACHED_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHED_PAGES = 16;

const IMAGE_MEDIA_TYPE = "image/png";
const DOCUMENT_MEDIA_TYPE = "application/pdf";

function dataUri(mediaType: string, bytes: Buffer): string {
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}

function count(total: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? "" : "s"}`;
}

/**
 * Resolves what the model accepts, then the routes to it. A model that takes
 * neither a file nor an image fails the run here, before any sandbox work: the
 * alternative is a report of zero rows that blames the model for the harness.
 */
export async function planHostTransport(query: CapabilityQuery): Promise<Result<TransportPlan>> {
  const probed = await resolveCapabilities(query);
  if (!probed.ok) return probed;

  const capabilities = probed.value;
  const kinds = TRANSPORTS.filter((kind) =>
    capabilities.modalities.includes(TRANSPORT_MODALITY[kind]),
  );
  if (kinds.length === 0) {
    return {
      ok: false,
      error:
        `${query.model} accepts ${capabilities.modalities.join(", ")} and nothing else (${capabilities.detail}). ` +
        `plasalid hands a statement back as a PDF file or as PNG page images, and the model cannot be sent either, ` +
        `so it cannot read the statement and cannot be scored on this task. Run a model that accepts image or file input.`,
    };
  }
  return { ok: true, value: { capabilities, kinds } };
}

/** Names the files and where they came from. Anything more would be coaching. */
function sourceOf(paths: string[]): string {
  return `${paths.map((path) => basename(path)).join(", ")} in ${dirname(paths[0] ?? "")}`;
}

async function attachDocument(path: string): Promise<Attached> {
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
          text: `Attached: the PDF the command above produced, ${sourceOf([path])}.`,
        },
        {
          type: "file",
          file: {
            filename: basename(path),
            file_data: dataUri(DOCUMENT_MEDIA_TYPE, read.value),
          },
        },
      ],
    },
    notes: [{ operation: "artifacts_attached", detail: `the PDF ${path}, ${bytes} bytes` }],
  };
}

async function attachPages(paths: string[]): Promise<Attached> {
  const notes: AttachmentNote[] = [];
  const wanted = paths.slice(0, MAX_ATTACHED_PAGES);
  if (wanted.length < paths.length) {
    notes.push({
      operation: "artifacts_capped",
      detail: `${paths.length} pages produced, ${MAX_ATTACHED_PAGES}-page cap: attached the first ${wanted.length}`,
    });
  }

  const parts: ChatCompletionContentPart[] = [];
  const attached: string[] = [];
  let bytes = 0;
  for (const path of wanted) {
    const read = await tryExecute(() => readFile(path));
    if (!read.ok) {
      notes.push({ operation: "artifacts_unreadable", detail: `${path}: ${read.error}` });
      continue;
    }
    if (bytes + read.value.byteLength > MAX_ATTACHED_BYTES) {
      notes.push({
        operation: "artifacts_capped",
        detail: `${MAX_ATTACHED_BYTES}-byte cap reached: attached ${attached.length} of ${paths.length} pages`,
      });
      break;
    }
    bytes += read.value.byteLength;
    attached.push(path);
    parts.push({ type: "image_url", image_url: { url: dataUri(IMAGE_MEDIA_TYPE, read.value) } });
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

function describe(artifacts: PlasalidArtifacts): string {
  if (artifacts.document) return `the PDF ${artifacts.document}`;
  return count(artifacts.pages.length, "page image");
}

/**
 * A PDF goes as a file part when the model reads files, otherwise page images go
 * as images. Neither means nothing is attached: degrading from there is the
 * skill's own instruction, and whether the model does it is what is being
 * measured.
 */
export async function attachArtifacts(
  plan: TransportPlan,
  artifacts: PlasalidArtifacts,
): Promise<Attached> {
  if (artifacts.document && plan.kinds.includes("file")) return attachDocument(artifacts.document);
  if (artifacts.pages.length > 0 && plan.kinds.includes("images")) return attachPages(artifacts.pages);
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
