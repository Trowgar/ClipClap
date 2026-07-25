/** Domain errors the stage boundary maps to a user-facing code.
 *
 *  Lives in its own module (not in normalize.ts) so a stage can `instanceof`
 *  it without importing - and therefore without a test having to un-mock - the
 *  ffmpeg processor that raises it. */

/** The input itself cannot be clipped, e.g. an audio-only file. Permanent: a
 *  BullMQ retry re-runs the exact same file, so the user must send another. */
export class UnsupportedInputError extends Error {}
