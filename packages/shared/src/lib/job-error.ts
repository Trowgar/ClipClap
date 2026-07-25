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
  /** The analysis model REFUSED to judge the material, twice on the same prompt
   *  (analyze-v2/critic.ts dropRefused), and no other candidate was left
   *  unjudged for a re-roll to rescue. Distinct from ANALYSIS_UNAVAILABLE
   *  because it is not transient: the analyze stage re-reads a cached
   *  transcript, so every remaining attempt re-sends what was already refused.
   *  The stage therefore throws it as a BullMQ UnrecoverableError - status stays
   *  FAILED (the quota is untouched, exactly as with ANALYSIS_UNAVAILABLE) but
   *  the attempts are not burned, and the copy must offer a different video
   *  rather than promise a retry or ask for the same file again. */
  "ANALYSIS_REFUSED",
  /** The upload itself cannot be clipped (audio-only file). Permanent: a retry
   *  cannot change it, so the copy must ask for a different file. */
  "UNSUPPORTED_INPUT",
  /** The pasted link did not yield a file. The downloader cannot tell the cause
   *  apart (private, removed, region-locked, login-walled, a stale extractor),
   *  so the copy names none of them as fact. Permanent for the same reason as
   *  UNSUPPORTED_INPUT: every attempt re-fetches the identical URL, so the copy
   *  must give the user a way out rather than promise an automatic retry. */
  "SOURCE_UNAVAILABLE",
  /** The source is over MAX_SOURCE_FILESIZE_BYTES: yt-dlp measured it and
   *  declined to download it. Split out of SOURCE_UNAVAILABLE because it is the
   *  one download failure whose cause we actually KNOW - yt-dlp prints its own
   *  verdict with both numbers - and because the SOURCE_UNAVAILABLE remedy is
   *  wrong here in both halves: the link opens fine in a browser, and the
   *  identical cap rejects the direct upload it recommends. The copy may
   *  therefore state the cause, state the limit as a number, and ask for a
   *  trimmed source. Permanent in the same sense as its sibling. */
  "SOURCE_TOO_LARGE",
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
