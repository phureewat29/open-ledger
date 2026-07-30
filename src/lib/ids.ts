import { createHash, randomUUID } from "crypto";

/**
 * `tx:` + sha256("<hash>|<page>|<row>[|<leg>]"), deterministic, so re-ingesting the
 * same file is idempotent. Omitting `legIndex` makes the hash match `deriveGroupId`'s.
 */
export function deriveTransactionId(
  fileHash: string,
  page: number,
  rowIndex: number,
  legIndex?: number,
): string {
  const base = `${fileHash}|${page}|${rowIndex}`;
  const material = legIndex != null ? `${base}|${legIndex}` : base;
  return "tx:" + createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** `tg:` + the same hash as legless `deriveTransactionId(fileHash, page, rowIndex)`. */
export function deriveGroupId(fileHash: string, page: number, rowIndex: number): string {
  return "tg:" + createHash("sha256").update(`${fileHash}|${page}|${rowIndex}`).digest("hex").slice(0, 16);
}

/** Groups a commit run's raised questions. */
export function newBatchId(): string {
  return `ib:${randomUUID()}`;
}

/** For a row without deterministic source coordinates. */
export function newTransactionId(): string {
  return `tx:${randomUUID()}`;
}

export function newGroupId(): string {
  return `tg:${randomUUID()}`;
}
