import { tryExecute } from "./result.js";

/**
 * For DB/JSON-column reads where a missing or corrupt blob should degrade to
 * "nothing". Callers that must distinguish absent from corrupt should parse
 * explicitly and branch instead.
 */
export function parseJsonOrNull(raw: string | null | undefined): unknown | null {
  if (raw == null) return null;
  const parsed = tryExecute(() => JSON.parse(raw));
  return parsed.ok ? parsed.value : null;
}
