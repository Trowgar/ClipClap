import { tagJobError, type JobErrorCode } from "@clipclap/shared";

/**
 * Tags a message for storage in Job.error, but never at the cost of the write
 * that marks the job FAILED.
 *
 * Every caller is inside a `catch` whose whole purpose is to persist FAILED.
 * The worker resolves @clipclap/shared to packages/shared/dist, dist is
 * gitignored, and a deploy that restarts the worker before
 * `npm run build -w @clipclap/shared` leaves tagJobError undefined. Calling it
 * raw would then throw a TypeError from inside the catch block, masking the
 * original error and skipping the update entirely: the job would sit in
 * ANALYZING/DOWNLOADING forever, which usage.service bills (it sums everything
 * not FAILED) while the bot delivery - which waits for DONE or FAILED - never
 * fires. A build-order slip would silently reintroduce exactly the quota-burn
 * this branch exists to close, so degrading to the untagged message (generic
 * user copy, full diagnostics intact) is always the better failure.
 */
export function safeTagJobError(code: JobErrorCode, message: string): string {
  try {
    return tagJobError(code, message);
  } catch {
    return message;
  }
}
