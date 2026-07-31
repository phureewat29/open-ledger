import type Database from "libsql";

export interface NoteRow {
  id: number;
  content: string;
  category: string;
  created_at: string;
}

export function listNotes(db: Database.Database): NoteRow[] {
  return db.prepare(
    `SELECT id, content, category, created_at FROM notes ORDER BY created_at DESC`,
  ).all() as NoteRow[];
}

export function countNotes(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM notes`).get() as { n: number };
  return row.n;
}

/** Idempotent on (category, content): a verbatim repeat returns the existing row unchanged. Semantic dedup is the calling agent's job. */
export function addNote(db: Database.Database, content: string, category = "fact"): NoteRow {
  const existing = db
    .prepare(`SELECT id, content, category, created_at FROM notes WHERE category = ? AND content = ? LIMIT 1`)
    .get(category, content) as NoteRow | undefined;
  if (existing) return existing;
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO notes (content, category) VALUES (?, ?)`)
    .run(content, category);
  return db
    .prepare(`SELECT id, content, category, created_at FROM notes WHERE id = ?`)
    .get(lastInsertRowid) as NoteRow;
}

export function deleteNote(db: Database.Database, id: number): NoteRow | null {
  const row = db
    .prepare(`SELECT id, content, category, created_at FROM notes WHERE id = ?`)
    .get(id) as NoteRow | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM notes WHERE id = ?`).run(id);
  return row;
}
