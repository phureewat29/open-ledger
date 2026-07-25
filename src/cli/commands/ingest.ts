import { resolve } from "path";
import { Option } from "commander";
import type { Command } from "commander";
import {
  type Column,
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
 * `ingest`: list candidate files, prepare pages, commit extracted rows, mark
 * files done/failed. Heavy db/ingest imports are deferred inside each action
 * so non-db commands don't pay for libsql/mupdf at startup (see status.ts).
 */

// Erased type query: the discovered-entry shape without pulling ingest/prepare
// (and its heavy deps) onto the startup path.
type IngestEntry = Awaited<ReturnType<typeof import("../../ingest/prepare.js").discoverFiles>>[number];

const INGEST_COLUMNS: Column<IngestEntry>[] = [
  { header: "Status", value: (r) => r.status },
  { header: "Enc", value: (r) => (r.encrypted ? `yes(${r.vaultCandidates})` : "no") },
  { header: "File ID", value: (r) => r.fileId ?? "-" },
  { header: "Path", value: (r) => r.relPath },
];

/**
 * Parse a `--pages` spec into 0-based page indices for `prepareFile`.
 *   "all" / "" → undefined (every page)
 *   "1-5,8"    → [0,1,2,3,4,7]  (1-based input, converted to 0-based)
 * Malformed tokens raise CliError USAGE.
 */
export function parsePagesSpec(spec: string): number[] | undefined {
  const trimmed = spec.trim().toLowerCase();
  if (!trimmed || trimmed === "all") return undefined;

  const pages = new Set<number>();
  for (const rawTok of trimmed.split(",")) {
    const tok = rawTok.trim();
    if (!tok) continue;
    const m = tok.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) fail("USAGE", `invalid --pages token "${tok}" (expected N or N-M, 1-based)`);
    const start = parseInt(m[1], 10);
    const end = m[2] != null ? parseInt(m[2], 10) : start;
    if (start < 1) fail("USAGE", `--pages values are 1-based; "${tok}" is out of range`);
    if (end < start) fail("USAGE", `invalid --pages range "${tok}" (end before start)`);
    for (let p = start; p <= end; p++) pages.add(p - 1);
  }
  if (pages.size === 0) return undefined;
  return [...pages].sort((a, b) => a - b);
}

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
  const counts = { new: 0, pending: 0, ingested: 0, failed: 0 };
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
      });
    }
    emitSummary({ ...counts, total });
    return;
  }

  emitList(entries, INGEST_COLUMNS);
  if (mode.tty) {
    process.stdout.write(
      `\n${counts.new} new, ${counts.pending} pending, ${counts.ingested} ingested, ${counts.failed} failed (${total} total)\n`,
    );
  }
}

interface PrepareIngestOpts {
  passwordStdin?: boolean;
  force?: boolean;
  format?: string;
  dpi?: string;
  pages?: string;
  out?: string;
}

// Mirrors DEFAULT_DPI in ingest/pdf.ts (not exported), reported back so the
// caller knows the resolution used when rasterizing to png.
const DEFAULT_DPI = 150;

async function prepareIngest(pathOrId: string, opts: PrepareIngestOpts): Promise<void> {
  const db = await openDb();
  const { resolveEntryPath, prepareFile, PasswordRequiredError } = await import(
    "../../ingest/prepare.js"
  );

  if (resolveEntryPath(db, pathOrId) === null) {
    fail("NOT_FOUND", `no ingest entry or file at "${pathOrId}"`);
  }

  if (opts.format && opts.format !== "png" && opts.format !== "pdf") {
    fail("USAGE", `--format must be "png" or "pdf" (got "${opts.format}")`);
  }
  const format = (opts.format ?? "pdf") as "png" | "pdf";

  const pages = parsePagesSpec(opts.pages ?? "all");

  let dpi: number | undefined;
  if (opts.dpi != null) {
    dpi = Number(opts.dpi);
    if (!Number.isFinite(dpi) || dpi <= 0) fail("USAGE", `--dpi must be a positive number (got "${opts.dpi}")`);
  }

  const password = opts.passwordStdin ? await readSecretFromStdin() : undefined;
  const outDir = opts.out ? resolve(opts.out) : undefined;

  let result;
  try {
    result = await prepareFile(db, pathOrId, {
      password,
      force: !!opts.force,
      format,
      dpi,
      pages,
      outDir,
    });
  } catch (err) {
    if (!(err instanceof PasswordRequiredError)) throw err;
    if (err.reason === "wrong_password") {
      fail("INPUT_REQUIRED", "incorrect password for encrypted PDF", {
        hint: "pipe the correct password with --password-stdin, or store one via `plasalid vault add <pattern> --password-stdin`",
      });
    }
    fail("INPUT_REQUIRED", "password required for encrypted PDF", {
      hint: "pipe the password with --password-stdin, or store one via `plasalid vault add <pattern> --password-stdin`",
    });
  }

  if (result.format === "pdf") {
    emitObject({
      file_id: result.fileId,
      format: result.format,
      document: result.document,
      page_count: result.pageCount,
      pages: result.pages,
    });
    return;
  }

  emitObject({
    file_id: result.fileId,
    page_count: result.pageCount,
    format: result.format,
    dpi: dpi ?? DEFAULT_DPI,
    pages: result.pages,
  });
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
        "Behavior: the statement pipeline, list files, prepare pages to read, commit rows, mark done or failed.",
        "Typical flow: list, prepare <id>, read the returned document, then commit --file <sf:id> --input <batch>.",
        "Example: plasalid ingest prepare statement.pdf --json",
      ].join("\n"),
    );

  ingest
    .command("list")
    .description("List items in the ingest pipeline")
    .option("--regex <pattern>", "filter items by regex")
    .action(runAction(listIngest));

  ingest
    .command("prepare <pathOrId>")
    .description("Prepare a file for ingestion; returns the statement's document path to Read")
    .option("--password-stdin", "read a password from stdin")
    .option("--force", "overwrite existing prepared output")
    .addOption(new Option("--format <fmt>", "output format (png|pdf)").hideHelp())
    .addOption(new Option("--dpi <n>", "rasterization resolution in DPI").hideHelp())
    .addOption(
      new Option("--pages <spec>", "page range to prepare (1-based, e.g. all | 1-5,8)").hideHelp(),
    )
    .option("--out <dir>", "output directory")
    .action(runAction(prepareIngest));

  ingest
    .command("commit")
    .description("Commit extracted transactions (NDJSON/JSON array via --input file or stdin) into the ledger")
    .option("--file <id>", "default source file id for committed rows")
    .option("--input <path>", "read the batch from an NDJSON/JSON file instead of stdin")
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
