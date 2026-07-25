import type { JobErrorCode } from "@clipclap/shared";

/**
 * Failure copy for the web UI. The web interface is English-only (unlike the
 * bot, which is EN/RU), so this is a plain map with no locale dimension.
 *
 * The raw Job.error is engineer prose ("critic produced 0 usable verdicts...")
 * and stays in the database for diagnostics - it is never rendered. An unknown
 * or untagged failure falls back to GENERIC, so a new engine error can only
 * ever be under-explained, never leaked.
 *
 * Type-only import of JobErrorCode keeps this module free of runtime imports
 * from @clipclap/shared, which pulls Prisma/Redis and must not reach a client
 * bundle - the code itself is parsed server-side.
 */
// Deliberately promises no automatic retry. GENERIC is the "we do not know what
// broke" bucket, and it covers permanent failures too - an undecodable codec, a
// transcript below the coverage floor. Telling those users to wait for a retry
// and resend in a few minutes is false twice over: the retry cannot help, and
// after the last attempt no retry is running at all. Only a code that KNOWS the
// failure is transient (ANALYSIS_UNAVAILABLE) may make that promise.
const GENERIC =
  "Something went wrong while processing this video and your minutes were not used. Try uploading it again, or send us a different file if it keeps failing.";

const TEXT: Record<JobErrorCode, string> = {
  ANALYSIS_UNAVAILABLE:
    "We could not analyze this video right now - a temporary problem on our side. We are retrying it automatically and your minutes were not used. If nothing arrives, try again in a few minutes.",
  UNSUPPORTED_INPUT:
    "This file has no video track - only sound. Upload a video file and we will clip it.",
  // Hedged on purpose. All we know is that the download produced no file; the
  // exit code cannot distinguish a private video from a stale extractor or a
  // rate limit, and telling someone their working link is private sends them to
  // check it in a browser where it opens fine. "Upload the file directly" is
  // the remedy that holds whatever the cause was.
  SOURCE_UNAVAILABLE:
    "We could not download the video from that link - it may be private, region-locked, removed, or temporarily unavailable. Check that the link opens in a browser, or upload the file directly. Your minutes were not used.",
};

export function jobErrorText(code: JobErrorCode | null | undefined): string {
  return (code && TEXT[code]) || GENERIC;
}
