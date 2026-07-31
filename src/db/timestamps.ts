/** Byte-identical to `Date.toISOString()`; `datetime('now')` is zone-less, and every JSON consumer reads a zone-less stamp as local time. */
export const ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** Same shape, shifted by a bound sqlite modifier (e.g. '+7 days'). */
export const ISO_SHIFTED_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now',?)";
