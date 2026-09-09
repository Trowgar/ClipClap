# Corrupt video input handling

## Problem

Two Telegram submissions for the same source exhausted the DOWNLOAD retry
budget. The source in the local Telegram Bot API cache and both objects copied
to R2 were byte-identical (2,154,446 bytes). The MP4 contains an `ftyp` box and
an empty `mdat` box, but no `moov` box, so it was already incomplete before the
ClipClap worker read it. Retrying the same immutable object cannot repair it.

The current pipeline treats the resulting numeric `ffprobe` exit as an
infrastructure failure. It retries three times, sends an operator incident, and
shows the user generic failure copy instead of telling them to send a valid
file.

## Design

When the timeline probe process starts successfully and exits with a numeric
non-zero status, `normalizeSource` will convert that verdict to
`UnsupportedInputError`. Its detail will state that the file cannot be read as
a video and may be damaged or incomplete. Spawn failures, forced termination,
and other failures where `ffprobe` did not return a media verdict remain
ordinary technical errors and retain the existing retry and incident behavior.

Permanent source-domain errors will inherit BullMQ's `UnrecoverableError` so
BullMQ does not repeat work that cannot produce a different answer. The worker
failure hook will treat an unrecoverable error as terminal even before the
configured attempt count is reached, release the user's submission slot, and
omit the operator incident because this is an expected input verdict rather
than a service outage.

The existing `UNSUPPORTED_INPUT` job-error code will be reused. Its web and bot
translations will be widened from the audio-only case to cover both missing
video tracks and unreadable, damaged, or incomplete video files. This avoids a
new persistence code while keeping the advice accurate for every producer of
the error.

## Data flow

1. DOWNLOAD obtains the source from Telegram/R2 or a URL.
2. `ffprobe` rejects an unreadable media file with a numeric exit status.
3. `normalizeSource` throws `UnsupportedInputError` with safe diagnostics.
4. The DOWNLOAD stage stores `[UNSUPPORTED_INPUT] ...` on the job.
5. BullMQ ends the job without further attempts.
6. The worker releases the user's queue slot and sends no infrastructure alert.
7. Web and Telegram tell the user to send a complete playable video file.

## Testing

- A normalize test will first reproduce a numeric `ffprobe` rejection and
  require `UnsupportedInputError`.
- A companion test will prove a spawn/operational error remains retryable.
- Worker-hook tests will prove an unrecoverable first failure releases the queue
  slot and does not notify the incident channel.
- Existing audio-only, stage tagging, error-copy, and worker suites must remain
  green.

## Non-goals

- Attempting to reconstruct a missing MP4 `moov` box. The required sample table
  and timing metadata are absent, so FFmpeg cannot reliably recover this file.
- Adding FFmpeg to the bot image. Validation belongs in the shared worker path
  so Telegram, web, and URL sources receive the same behavior.
