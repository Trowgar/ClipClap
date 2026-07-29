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
  /** Analysis produced nothing anyone judged - models unavailable, batches
   *  truncated, candidates silently omitted, or the model refusing to answer.
   *  The stage does not distinguish them: the counters that would have to carry
   *  the difference do not (a "refusal" also covers an upstream outage whose
   *  fallback call refused), so the code covers the lot. Status FAILED, quota
   *  untouched, and BullMQ keeps all three attempts.
   *
   *  It is NOT a promise of a retry, though: markJobFailed writes FAILED on
   *  every attempt, so this code renders on attempt 1 of 3 and on the last one
   *  alike, and the copy cannot tell which. Same rule as the generic bucket -
   *  assert neither transience nor permanence, and never instruct an action
   *  that could bill the same video twice. */
  "ANALYSIS_UNAVAILABLE",
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
  /** A free-tier job whose real, ffprobe-measured duration does not fit in the
   *  allowance the account has left. The submit gate could not catch it: an
   *  upload is already in R2 when the route runs and is reserved at zero
   *  seconds, so the download stage is the first place the true length is
   *  known - and the last place before TRANSCRIBE spends money.
   *
   *  The one failure in this list that costs the user nothing: the reservation
   *  is refunded before the job is marked FAILED, so the copy may state that
   *  the free minutes are still there. Permanent, like the SOURCE_* codes -
   *  every retry re-downloads and re-measures the same file - so the copy has
   *  to name the two ways out (a shorter source, or a plan) rather than
   *  suggest waiting. */
  "FREE_ALLOWANCE_EXCEEDED",
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
