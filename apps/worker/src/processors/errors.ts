/** Domain errors the stage boundary maps to a user-facing code.
 *
 *  Lives in its own module (not in normalize.ts) so a stage can `instanceof`
 *  it without importing - and therefore without a test having to un-mock - the
 *  ffmpeg processor that raises it. */

/** The input itself cannot be clipped, e.g. an audio-only file. Permanent: a
 *  BullMQ retry re-runs the exact same file, so the user must send another. */
export class UnsupportedInputError extends Error {}

/** yt-dlp ran, looked at the pasted link and exited non-zero. Raised ONLY for a
 *  real non-zero exit status - a missing binary, a maxBuffer overflow or a
 *  killed child are our own environment failing and must stay untagged, because
 *  this code renders as copy about the user's link.
 *
 *  The exit code alone still does not say why - private, removed,
 *  region-locked, login-walled, over the size cap, or an extractor too old for
 *  the site - so this class claims only that the fetch failed. Permanent in the
 *  same sense as UnsupportedInputError:
 *  all three BullMQ attempts re-fetch the identical URL with the identical
 *  binary, so the copy must offer the user a way out (check the link, or send
 *  the file directly) instead of promising an automatic retry. */
export class SourceUnavailableError extends Error {}
