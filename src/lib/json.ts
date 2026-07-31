import { tryExecute } from "./result.js";

/** For reads where a missing or corrupt blob should degrade to "nothing". Callers needing to tell absent from corrupt apart should parse explicitly instead. */
export function parseJsonOrNull(raw: string | null | undefined): unknown | null {
  if (raw == null) return null;
  const parsed = tryExecute(() => JSON.parse(raw));
  return parsed.ok ? parsed.value : null;
}
