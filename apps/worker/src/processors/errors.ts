/** Domain errors the stage boundary maps to a user-facing code.
 *
 *  Lives in its own module (not in normalize.ts) so a stage can `instanceof`
 *  it without importing - and therefore without a test having to un-mock - the
 *  ffmpeg processor that raises it. */

/** The input itself cannot be clipped, e.g. an audio-only file. Permanent: a
 *  BullMQ retry re-runs the exact same file, so the user must send another. */
export class UnsupportedInputError extends Error {}

/** yt-dlp looked at the pasted link and produced no usable file. Raised for two
 *  distinct observations:
 *
 *    1. a real NON-ZERO exit status. A missing binary, a maxBuffer overflow or
 *       a killed child are our own environment failing and must stay untagged,
 *       because this code renders as copy about the user's link.
 *    2. a ZERO exit that still left nothing at the output path. yt-dlp treats
 *       "I decided to skip this download" as success, so a zero exit is not
 *       proof of a file (see the verified list in download.ts).
 *
 *  Neither observation says WHY - private, removed, region-locked,
 *  login-walled, or an extractor too old for the site all look alike - so this
 *  class claims only that the fetch failed. The one skip reason we CAN name is
 *  split out into SourceTooLargeError. Permanent in the same sense as
 *  UnsupportedInputError: all three BullMQ attempts re-fetch the identical URL
 *  with the identical binary, so the copy must offer the user a way out (check
 *  the link, or send the file directly) instead of promising an automatic
 *  retry. */
export class SourceUnavailableError extends Error {}

/** The source is over MAX_SOURCE_FILESIZE_BYTES. yt-dlp read the size, refused
 *  the download and said so in as many words, so unlike its sibling this error
 *  carries a cause we can state and a number we can quote.
 *
 *  A SIBLING of SourceUnavailableError, deliberately not a subclass: the stage
 *  maps errors with an instanceof chain, and inheritance would make the mapping
 *  depend on the order of the branches. It also would not be true - the two
 *  have opposite remedies. SourceUnavailableError sends the user to upload the
 *  file directly; here that is the one action guaranteed to fail, because the
 *  upload path enforces the very same cap. */
export class SourceTooLargeError extends Error {}

/** A free-tier job whose measured duration does not fit in the allowance the
 *  account has left. Raised by the download stage's re-check, never by a
 *  processor: it is a verdict about the ledger, not about the file.
 *
 *  A SIBLING of the two source errors, not a subclass, for the same reason they
 *  are siblings of each other - the stage maps with an instanceof chain - and
 *  because the remedies contradict. Nothing is wrong with this video: it is
 *  simply longer than what is left, and the copy has to offer a shorter source
 *  or a plan rather than a different file.
 *
 *  Permanent, and that is what makes the refund safe. All three BullMQ attempts
 *  re-download the identical source, re-probe the identical duration and reach
 *  the identical verdict, so unlike every other stage failure there is no
 *  attempt on which this job could still succeed after its allowance has been
 *  handed back. */
export class FreeAllowanceExceededError extends Error {}
