import { clamp } from "es-toolkit";

/** One clamp for every list surface, so the cap a query applies is the cap the
 *  CLI's summary reports. Each surface keeps its own default and maximum. */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  return clamp(limit ?? fallback, 1, max);
}

export function clampOffset(offset: number | undefined): number {
  return Math.max(0, Math.floor(offset ?? 0));
}
