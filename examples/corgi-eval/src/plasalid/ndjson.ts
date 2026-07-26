import { tryExecute } from "../core/result.js";

/**
 * Every reader of plasalid's `--json` output starts here. Unparseable lines are
 * skipped rather than reported: help text and warnings share the stream, and a
 * line that is not an object carries nothing any caller wants.
 */
export function parseNdjson(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const parsed = tryExecute(() => JSON.parse(trimmed) as unknown);
    if (!parsed.ok) continue;
    const value = parsed.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    out.push(value as Record<string, unknown>);
  }
  return out;
}
