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
const GENERIC =
  "Something went wrong while processing this video. We are retrying it automatically and your minutes were not used. If nothing arrives, try again in a few minutes.";

const TEXT: Record<JobErrorCode, string> = {
  ANALYSIS_UNAVAILABLE:
    "We could not analyze this video right now - a temporary problem on our side. We are retrying it automatically and your minutes were not used. If nothing arrives, try again in a few minutes.",
  UNSUPPORTED_INPUT:
    "This file has no video track - only sound. Upload a video file and we will clip it.",
};

export function jobErrorText(code: JobErrorCode | null | undefined): string {
  return (code && TEXT[code]) || GENERIC;
}
