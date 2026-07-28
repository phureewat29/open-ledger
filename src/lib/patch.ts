export interface PatchField {
  /** SQL column; defaults to the patch key when omitted. */
  column?: string;
  /**
   * Normalize the incoming value before binding; the transformed value is
   * both the bound param and the audit `after` value.
   */
  transform?: (value: unknown) => unknown;
}

// before/after audit snapshots are keyed by patch key, not by column.
interface PatchResult {
  sets: string[];
  params: unknown[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/**
 * Builds `SET` fragments, params, and before/after snapshots for every `spec`
 * key present in `patch`. A key participates only when `patch[key] !==
 * undefined` (absent leaves the column untouched; explicit `null` binds SQL
 * NULL). No `changed` flag: callers test `sets.length` themselves after
 * appending any hand-written fields.
 */
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
    // libsql cannot bind `undefined`; a transform should never produce one,
    // but this keeps the "params never contain undefined" contract airtight.
    params.push(value === undefined ? null : value);
    before[key] = currentRecord[column];
    after[key] = value;
  }

  return { sets, params, before, after };
}
