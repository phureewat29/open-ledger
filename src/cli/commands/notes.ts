import type { Command } from "commander";
import type { NoteRow } from "../../db/queries/notes.js";
import { emitList, emitSummary, fail, requireYes, runAction, type Column } from "../output.js";
import { openDb } from "../db.js";
import * as z from "zod";
import { parseInput, str, num } from "../../lib/validate.js";

const VALID_CATEGORIES = ["rule", "preference", "fact"] as const;

// `content` is the only free-text field; id/category/created_at are
// structured data left verbatim.
const NOTE_REDACT_FIELDS = ["content"] as const;

const NOTE_COLUMNS: Column<NoteRow>[] = [
  { header: "ID", value: (r) => String(r.id), align: "right" },
  { header: "Category", value: (r) => r.category },
  { header: "Content", value: (r) => r.content },
  { header: "Created At", value: (r) => r.created_at },
];

interface ListNotesOpts {
  redact?: boolean;
}

async function listNotes(opts: ListNotesOpts): Promise<void> {
  const { listNotes: queryNotes } = await import("../../db/queries/notes.js");
  const db = await openDb();
  let rows = queryNotes(db);
  if (opts.redact) {
    const { applyRedaction } = await import("../../privacy/redactor.js");
    rows = applyRedaction(rows, true, NOTE_REDACT_FIELDS);
  }
  emitList(rows, NOTE_COLUMNS);
  emitSummary({ total: rows.length, returned: rows.length });
}

const ADD_NOTE_SPEC = z.object({
  content: str(),
  category: z.enum(VALID_CATEGORIES).default("fact"),
});

async function addNote(opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(ADD_NOTE_SPEC, opts);

  const { listNotes: queryNotes, addNote: addNoteRow } = await import("../../db/queries/notes.js");
  const db = await openDb();
  addNoteRow(db, parsed.content, parsed.category);
  const saved = queryNotes(db)
    .filter((m) => m.content === parsed.content && m.category === parsed.category)
    .sort((a, b) => b.id - a.id)[0];
  // A silent write with empty output would read as failure; say which row landed.
  if (!saved) fail("GENERIC", "note was written but could not be read back");
  emitList([saved], NOTE_COLUMNS);
}

// Positional `<id>` args aren't commander opts; parsed through the same spec
// API with an ad hoc raw object so the coercion message stays consistent.
const NOTE_ID_SPEC = z.object({ id: num() });
const NOTE_ID_LABELS = { id: "note id" };

async function removeNote(id: string, opts: { yes?: boolean }): Promise<void> {
  requireYes(opts, "removing this note");
  const parsed = parseInput(NOTE_ID_SPEC, { id }, { labels: NOTE_ID_LABELS });

  const { deleteNote: deleteNoteRow } = await import("../../db/queries/notes.js");
  const db = await openDb();
  const deleted = deleteNoteRow(db, parsed.id);
  if (!deleted) fail("NOT_FOUND", `note "${id}" not found`);
  emitList([deleted], NOTE_COLUMNS);
}

export function registerNotes(program: Command): void {
  const notes = program.command("notes").description("Manage freeform notes");

  notes
    .command("list")
    .description("List notes")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(listNotes));

  notes
    .command("add")
    .description("Add a note")
    .option("--content <text>", "note content")
    .option("--category <cat>", "note category: rule, preference, or fact")
    .action(runAction(addNote));

  notes
    .command("rm <id>")
    .description("Remove a note")
    .option("--yes", "skip confirmation")
    .action(runAction(removeNote));
}
