export interface PatchField {
  /** SQL column; defaults to the patch key when omitted. */
  column?: string;
  /** Normalize the incoming value before binding; the transformed value is both the bound param and the audit `after` value. */
  transform?: (value: unknown) => unknown;
}

// before/after audit snapshots are keyed by patch key, not by column.
interface PatchResult {
  sets: string[];
  params: unknown[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

// A key participates only when `patch[key] !== undefined` (explicit `null`
// binds SQL NULL); callers test `sets.length` for emptiness.
export function buildPatch<Row extends object>(
  spec: Record<string, PatchField>,
  current: Row,
  patch: object,
): PatchResult {
  const currentRecord = current as Record<string, unknown>;
  const patchRecord = patch as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  for (const key of Object.keys(spec)) {
    if (patchRecord[key] === undefined) continue;
    const field = spec[key];
    const column = field.column ?? key;
    const value = field.transform ? field.transform(patchRecord[key]) : patchRecord[key];

    sets.push(`${column} = ?`);
    // libsql cannot bind `undefined`; this keeps that contract airtight even if a transform produces one.
    params.push(value === undefined ? null : value);
    before[key] = currentRecord[column];
    after[key] = value;
  }

  return { sets, params, before, after };
}
