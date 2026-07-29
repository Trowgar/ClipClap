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
// GENERIC is the "we do not know what broke" bucket, so it may assert neither
// answer - and both are live at the moment it renders:
//
//  - Permanent: an undecodable codec, a transcript below the coverage floor, or
//    the third BullMQ attempt already burned. "We are retrying, try again in a
//    few minutes" is false there and loops the user.
//  - Transient: markJobFailed writes status FAILED on EVERY attempt and
//    attempts is 3, so this copy is shown on attempt 1 of 3 as well. "Try
//    uploading it again" is equally false there - the original heals on attempt
//    2, the re-upload is a second Job row, and usage.service bills both because
//    it counts every job whose status is not FAILED.
//
// So the line states the outcome as unknown, and spends its one imperative on
// the fact that actually protects the user's minutes: wait and look before
// re-uploading. Only a code that KNOWS which way the failure went may say so -
// UNSUPPORTED_INPUT and the two SOURCE_* codes do; no analysis code does.
//
// This is copy doing a job the UI should be doing - see the note in
// hooks/use-jobs.ts. Once a non-final attempt is distinguishable from a final
// one, the non-final case should not render a failure at all and this line can
// shrink back to the permanent case.
const GENERIC =
  "Something went wrong while processing this video and your minutes were not used. We cannot tell yet whether this one will finish - wait a few minutes and check back here before uploading it again, so the same video does not use your minutes twice. If nothing has changed by then, upload it again or send us a different file.";

const TEXT: Record<JobErrorCode, string> = {
  // GENERIC's rule, applied to the one thing this code does know: the failure
  // was in analysis. Everything past that is unknown at render time. The old
  // line called it "a temporary problem on our side" and promised "we are
  // retrying it automatically... try again in a few minutes" - two claims the
  // code cannot support. It renders on the last burned attempt as readily as on
  // the first, so the promise of a retry is often already false; and "try again
  // in a few minutes" invites a re-upload that becomes a second Job row, which
  // usage.service bills, right when the first one may still heal.
  ANALYSIS_UNAVAILABLE:
    "We could not work out which moments to clip from this video, and your minutes were not used. We cannot tell yet whether this one will finish - wait a few minutes and check back here before uploading it again, so the same video does not use your minutes twice. If nothing has changed by then, upload it again or send us a different file.",
  UNSUPPORTED_INPUT:
    "This file has no video track - only sound. Upload a video file and we will clip it.",
  // Hedged on purpose. All we know is that the download produced no file; the
  // exit code cannot distinguish a private video from a stale extractor or a
  // rate limit, and telling someone their working link is private sends them to
  // check it in a browser where it opens fine. "Upload the file directly" is
  // the remedy that holds whatever the cause was.
  SOURCE_UNAVAILABLE:
    "We could not download the video from that link - it may be private, region-locked, removed, or temporarily unavailable. Check that the link opens in a browser, or upload the file directly. Your minutes were not used.",
  // The one download failure that is NOT hedged, because yt-dlp measured the
  // file and told us so. Two things follow. First, the cause is stated flatly -
  // hedging here would throw away information we actually hold and read as
  // evasion. Second, this copy must contradict SOURCE_UNAVAILABLE's remedy: the
  // link opens perfectly in a browser, and "upload the file directly" is the
  // one action guaranteed to fail, since the upload path enforces the identical
  // cap (MAX_SOURCE_FILESIZE_BYTES / ABUSE_CAPS.maxFileSizeBytes). Saying so
  // costs a clause and saves the user a failed 2 GB upload. The number is
  // quoted because "too large" is unactionable - a clipper with a 6-hour VOD
  // needs to know what to cut it down to.
  SOURCE_TOO_LARGE:
    "That video is over our 2 GB limit, so we could not download it. Your minutes were not used. Uploading the file here will not help - the same 2 GB limit applies - so trim the video to the part you want clipped and use that instead.",
  // The only line here that can promise the allowance is intact and mean it:
  // the download stage refunds the reservation before it marks the job failed,
  // so "still there" is a fact and not a hedge. It states no number - the copy
  // is a static map with no room for one, and the account page shows the real
  // balance - and it names both exits, because a clipper whose VOD is over the
  // remaining free minutes can act on either but will guess neither.
  FREE_ALLOWANCE_EXCEEDED:
    "This video is longer than the free minutes you have left, so we stopped before processing it. Your free minutes are still there - clip a shorter video with them, or pick a plan to run this one in full.",
};

export function jobErrorText(code: JobErrorCode | null | undefined): string {
  return (code && TEXT[code]) || GENERIC;
}
