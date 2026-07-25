/**
 * Job.error is engineer prose ("scanner failed on all 4 windows - analysis
 * models unavailable") and it is relayed to end users verbatim by the bot and
 * the web app. That text is unreadable for a customer and untranslated for a
 * Russian one, so the DISPLAY has to come from a small closed set of codes
 * instead of the message itself.
 *
 * Mechanism: the code is carried as a `[CODE] ` prefix on the stored message.
 * Prefix over a new Job column because it needs no migration, keeps the raw
 * diagnostics in the same field (everything after the prefix is untouched), and
 * survives every path that already persists `error.message`. Codes over
 * matching English prose because prose changes with every engine tweak, and a
 * silently-unmatched pattern would fall back to leaking the raw string.
 *
 * Rules for consumers:
 *   - an unknown, absent or unprefixed error MUST render the generic message,
 *     never the raw text;
 *   - adding a code here is only half the work - every consumer's dictionary
 *     must gain a string for it (the bot Dict is typed on the union, so a
 *     missing translation is a compile error).
 */
export const JOB_ERROR_CODES = [
  /** Technical analysis failure: models unavailable, nothing was ever judged.
   *  Retryable - BullMQ re-runs the stage and the quota stays untouched. */
  "ANALYSIS_UNAVAILABLE",
  /** The upload itself cannot be clipped (audio-only file). Permanent: a retry
   *  cannot change it, so the copy must ask for a different file. */
  "UNSUPPORTED_INPUT",
] as const;

export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

const CODE_PATTERN = /^\[([A-Z_]+)\]\s?/;

/** Stamp a machine-readable code onto the message persisted in Job.error. */
export function tagJobError(code: JobErrorCode, detail: string): string {
  return `[${code}] ${detail}`;
}

/** Read the code back. Returns null for untagged, unknown or empty errors -
 *  the caller must then show its generic message, never `raw`. */
export function parseJobErrorCode(raw: string | null | undefined): JobErrorCode | null {
  if (!raw) return null;
  const match = CODE_PATTERN.exec(raw);
  if (!match) return null;
  const code = match[1] as JobErrorCode;
  return (JOB_ERROR_CODES as readonly string[]).includes(code) ? code : null;
}
