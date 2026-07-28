import type { Command } from "commander";
import {
  EXIT,
  type Column,
  type ExitCode,
  currentMode,
  emit,
  emitList,
  emitObject,
  emitSummary,
  fail,
  readSecretFromStdin,
  runAction,
} from "../output.js";
import { openDb } from "../db.js";
import { commitIngest } from "./ingest-commit.js";
/**
 * The accepted-input facts, so help text can't drift from the enforcing table;
 * source.ts avoids mupdf/libsql, so it's safe on the startup path.
 */
import { MAX_SOURCE_BYTES, SUPPORTED_EXTS } from "../../extract/source.js";
/**
 * Types only, erased at compile time — the ingest modules load lazily inside
 * each action, keeping libsql/mupdf off the startup path.
 */
import type { IngestEntry, PrepareOutcome, PrepareFailure } from "../../ingest/prepare.js";

type PrepareSuccess = Extract<PrepareOutcome, { ok: true }>;

const INGEST_COLUMNS: Column<IngestEntry>[] = [
  { header: "Status", value: (r) => r.status },
  { header: "Enc", value: (r) => (r.encrypted ? `yes(${r.vaultCandidates})` : "no") },
  { header: "File ID", value: (r) => r.fileId ?? "-" },
  { header: "Path", value: (r) => r.relPath },
  { header: "Note", value: (r) => r.note ?? "" },
];

interface ListIngestOpts {
  regex?: string;
}

async function listIngest(opts: ListIngestOpts): Promise<void> {
  const db = await openDb();
  const { discoverFiles } = await import("../../ingest/prepare.js");

  let regex: RegExp | undefined;
  if (opts.regex) {
    try {
      regex = new RegExp(opts.regex);
    } catch (err) {
      fail("USAGE", `invalid --regex: ${(err as Error).message}`);
    }
  }

  const entries = await discoverFiles(db, { regex });
  const counts: Record<IngestEntry["status"], number> = {
    new: 0,
    pending: 0,
    ingested: 0,
    failed: 0,
    unreadable: 0,
  };
  for (const e of entries) counts[e.status]++;
  const total = entries.length;

  const mode = currentMode();
  if (mode.json) {
    for (const e of entries) {
      emit({
        type: "file",
        path: e.path,
        rel_path: e.relPath,
        hash: e.hash,
        file_id: e.fileId,
        status: e.status,
        encrypted: e.encrypted,
        vault_candidates: e.vaultCandidates,
        note: e.note ?? null,
      });
    }
    emitSummary({ ...counts, total });
    return;
  }

  emitList(entries, INGEST_COLUMNS);
  if (mode.tty) {
    process.stdout.write(
      `\n${counts.new} new, ${counts.pending} pending, ${counts.ingested} ingested, ${counts.failed} failed, ${counts.unreadable} unreadable (${total} total)\n`,
    );
  }
}

interface PrepareIngestOpts {
  passwordStdin?: boolean;
  force?: boolean;
  rescan?: boolean;
  /** commander's `--no-ocr` negation: false only when the flag was passed. */
  ocr?: boolean;
}

const PASSWORD_HINT =
  "pipe the password with --password-stdin, or store it once via `oled vault add <pattern>`";

const ACCEPTED_EXTS = SUPPORTED_EXTS.join(" ");
const SIZE_LIMIT = `${MAX_SOURCE_BYTES / (1024 * 1024)} MB`;

const PREPARE_FAILURES: Record<PrepareFailure, { code: ExitCode; hint: string }> = {
  not_found: { code: "NOT_FOUND", hint: "run `oled ingest list --json` to see what is discoverable" },
  unsupported_extension: {
    code: "USAGE",
    hint: `supported: ${ACCEPTED_EXTS} — export other formats first`,
  },
  kind_mismatch: { code: "USAGE", hint: "the bytes disagree with the extension; re-export or rename" },
  too_large: {
    code: "INVALID",
    hint: `the limit is ${SIZE_LIMIT} — split the file or export it smaller`,
  },
  unreadable: { code: "NOT_FOUND", hint: "check the path and its permissions" },
  pdf_unreadable: { code: "INVALID", hint: "the PDF may be corrupt; re-download or re-export it" },
  password_required: { code: "INPUT_REQUIRED", hint: PASSWORD_HINT },
  wrong_password: { code: "INPUT_REQUIRED", hint: PASSWORD_HINT },
  ocr_unreachable: { code: "NOT_READY", hint: "start the OCR server, or re-run with --no-ocr" },
  ocr_rejected: {
    code: "NOT_READY",
    hint: "check the model against `oled doctor --json`, or re-run with --no-ocr",
  },
};

/** What each route adds to the shared head: a document to read, or page images. */
const PREPARE_PAYLOAD: {
  [K in PrepareSuccess["kind"]]: (
    result: Extract<PrepareSuccess, { kind: K }>,
  ) => Record<string, unknown>;
} = {
  text: (result) => ({
    ...(result.model ? { ocr_model: result.model } : {}),
    document: result.document,
    pages: result.pages,
    // Only the OCR route reads page by page, so only it can lose one.
    ...(result.source === "ocr" ? { failed_pages: result.failedPages } : {}),
  }),
  images: (result) => ({ ...(result.dpi ? { dpi: result.dpi } : {}), pages: result.pages }),
};

async function prepareIngest(pathOrId: string, opts: PrepareIngestOpts): Promise<void> {
  const db = await openDb();
  const { prepareFile } = await import("../../ingest/prepare.js");

  const password = opts.passwordStdin ? await readSecretFromStdin() : undefined;
  const result = await prepareFile(db, pathOrId, {
    password,
    force: !!opts.force,
    rescan: !!opts.rescan,
    noOcr: opts.ocr === false,
  });
  if (!result.ok) {
    const { code, hint } = PREPARE_FAILURES[result.reason];
    fail(code, result.message, { hint });
  }

  emitObject({
    file_id: result.fileId,
    kind: result.kind,
    source: result.source,
    text_layer: result.textLayer,
    page_count: result.pageCount,
    ...PREPARE_PAYLOAD[result.kind](result as never),
  });

  // A page the endpoint could not read is a hole in the document, not a failed run.
  if (result.kind === "text" && result.failedPages.length > 0) process.exitCode = EXIT.PARTIAL;
}

interface CompleteIngestOpts {
  agent?: string;
}

async function completeIngest(id: string, opts: CompleteIngestOpts): Promise<void> {
  const db = await openDb();
  const { markFileIngested } = await import("../../db/queries/files.js");
  const changes = markFileIngested(db, id, { source: opts.agent ?? "external" });
  if (changes === 0) fail("NOT_FOUND", `no ingest entry: ${id}`);

  const { cleanCache } = await import("../../ingest/prepare.js");
  const { removed } = cleanCache(id);
  emitObject({ file_id: id, status: "ingested", cache_removed: removed });
}

interface FailIngestOpts {
  agent?: string;
  error?: string;
}

async function failIngest(id: string, opts: FailIngestOpts): Promise<void> {
  if (!opts.error) fail("USAGE", "`ingest fail` requires --error <text>");

  const db = await openDb();
  const { markFileFailed } = await import("../../db/queries/files.js");
  const changes = markFileFailed(db, id, { source: opts.agent ?? "external", error: opts.error });
  if (changes === 0) fail("NOT_FOUND", `no ingest entry: ${id}`);

  const { cleanCache } = await import("../../ingest/prepare.js");
  const { removed } = cleanCache(id);
  emitObject({ file_id: id, status: "failed", cache_removed: removed });
}

export function registerIngest(program: Command): void {
  const ingest = program
    .command("ingest")
    .description("Ingest pipeline: list / prepare / commit / done / fail")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: the statement pipeline, list the files waiting, prepare one for reading, commit its rows, mark it done or failed.",
        "Typical flow: list, prepare <id>, read what prepare returns, commit --file <sf:id> with the rows on stdin (or --input <batch>), then done <sf:id>.",
        `Accepts ${ACCEPTED_EXTS}, up to ${SIZE_LIMIT}. Locked PDFs exit 4: pass the password with --password-stdin, or store it once with vault add <pattern>.`,
        "Example: oled ingest prepare statement.pdf --json",
      ].join("\n"),
    );

  ingest
    .command("list")
    .description("List items in the ingest pipeline")
    .option("--regex <pattern>", "filter items by regex")
    .action(runAction(listIngest));

  ingest
    .command("prepare <pathOrId>")
    .description("Extract a statement file into text (or page images) to read")
    .option("--password-stdin", "read the password for a locked PDF from stdin")
    .option("--force", "re-register the file, dropping the prior ingest's rows and artifacts")
    .option("--rescan", "ignore the text layer and read the page images instead")
    .option("--no-ocr", "ignore the OCR server and return the page images to you")
    .addHelpText(
      "after",
      [
        "",
        'Behavior: reads the file once and returns text whenever it can. A PDF carrying its own text layer is extracted directly. Otherwise the pages become images — a scan is rasterized, a photo is taken as it lies — and the OCR server reads them when one is configured (`oled config --ocr-url <url>`); with none configured they come back to you. The reader is named in source: "text-layer" or "ocr" when kind is "text", "raster" or "original" when kind is "images".',
        'Output kind "text": one `document` path to read. Inside it, pages are separated by `--- page N ---` markers; cite the row\'s page as source_page on commit. Page numbers count from 1 everywhere — the markers, the pages[] entries, and source_page.',
        'Output kind "images": one path per page under pages[], in order — read them yourself.',
        "Escape hatches: --rescan ignores a garbled text layer and reads the pages instead; --no-ocr ignores the OCR server and returns the page images. Both together always return images.",
        "Exits: 2 the file type is not supported, 3 the OCR server is misconfigured or unreachable, 4 the PDF needs a password, 5 nothing at that path or id, 6 the file is too large or corrupt, 7 the OCR server failed on some pages — each carries a `[page N: OCR failed]` line in the document and is listed in failed_pages; re-run with --no-ocr to read those pages yourself.",
        "Example: oled ingest prepare statement.pdf --json",
      ].join("\n"),
    )
    .action(runAction(prepareIngest));

  ingest
    .command("commit")
    .description("Commit extracted transactions (NDJSON/JSON array via --input file or stdin) into the ledger")
    .option("--file <id>", "default source file id for committed rows")
    .option("--input <path>", "read the batch from an NDJSON/JSON file instead of stdin")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: posts one batch of statement rows; each item resolves account hints, links merchants, and raises questions instead of failing.",
        'Item: {"date":"YYYY-MM-DD","description":"...","debit_account":"expense:food","credit_account":"asset:bank:kbank","amount":135.00,"source_page":2,"row_index":0,"raw_descriptor":"<verbatim bank text>","merchant":{"canonical_name":"..."}}',
        "Rules: amount > 0, direction comes from the two accounts, never a sign; account ids are hints (resolved exact, then fuzzy, then placeholder); set row_index + source_page and pass --file <sf:id> so a re-run is an idempotent duplicate:true no-op.",
        "Compound rows (payslip, FX): replace debit/credit/amount with linked:[{debit_account,credit_account,amount},...] sharing one account; legs commit atomically under one group_id. Cross-currency rows become two linked legs through equity:conversion:<ccy>.",
        "Output: one result per item, then a summary with batch_id/posted/duplicates/failed. Exit 7 = some rows failed; duplicate:true is a success.",
      ].join("\n"),
    )
    .action(runAction(commitIngest));

  ingest
    .command("done <id>")
    .description("Mark an ingest item as done")
    .option("--agent <name>", "name of the completing agent")
    .action(runAction(completeIngest));

  ingest
    .command("fail <id>")
    .description("Mark an ingest item as failed")
    .option("--agent <name>", "name of the failing agent")
    .option("--error <text>", "failure reason")
    .action(runAction(failIngest));
}
