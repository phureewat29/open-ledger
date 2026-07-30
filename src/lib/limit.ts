/** One clamp for every list surface, so the cap a query applies is the cap the
 *  CLI's summary reports. Each surface keeps its own default and maximum. */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(limit ?? fallback, 1), max);
}
