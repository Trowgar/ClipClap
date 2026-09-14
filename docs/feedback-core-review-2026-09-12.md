# Feedback core review — 2026-09-12

Compared stored feedback clips, original sources, transcripts, crop plans and
analysis telemetry. This is a three-case review, not a general quality benchmark.
Visual conclusions use extracted frames; no claim of a full listening review.

## Screen-recording crop — confirmed and patched

Clip `cmtxxro9p00613uhucwhe3hkr`, source range 282.24–335.28 seconds.
Feedback: NO / QUALITY, “Wrong crop instead of adding border and space above and right.”

The delivered center crop retains the empty middle of a desktop demonstration,
cutting away most of the chat at left and the phone at right. The existing
faceless safety rule checks detail width but not position: spread 0.2640625 fits
the nominal portrait width, while centroid x=634.4885 is outside crop 656–1264
on the 1920×1080 source.

Minimal fix: reuse safe-fit when valid faceless detail is either too broad or
its centroid is outside the actual center crop. Existing gates and the
all-overlapping-spans requirement remain. No new detector, dependency or layout.
This is an edge-energy heuristic, not semantic coverage; textured backgrounds
can trigger a conservative full-frame composition. Safe-fit preserves content,
but small desktop text is still small on a phone.

## Awkward question ending — confirmed warning, repair not implemented

Clip `cmtwvg4dt004l3uhuwzgv4a5p`, source range 418.80–435.54 seconds.
Feedback: NO / CUTOFF.

The arc audit recorded one `mid_thought` exit flag. Downrank telemetry reports
one considered, zero penalized, zero dropped; publishability dropped none.
The current policy intentionally gives a single remaining axis a default zero
penalty (see `analyze-v2/quality-lane.ts`). Detection did not prevent delivery.

Source frames near 435 seconds switch to an unrelated face-filter scene.
Transcript word timing also stretches “can't” across 432.86–435.46. Blindly
extending to the next transcript segment would import the next scene, not
necessarily repair the exchange. The specific perceived cutoff still needs
audio review. Next work: scene-aware end validation and repair-or-reject, tested
against complete clips too; do not globally reject every single audit warning
based on this one case.

## Indonesian monologue — not enough feedback to label a defect

Clip `cmtwgh9bc00433uhuruyoa37i`, source range 0–60.32 seconds.
Feedback: EDIT, no reason or note.

The delivered safe-fit keeps the full horizontal scene and makes the speaker
small. The stored profile says stream; whether this is an incorrect camera-panel
classification needs a separate geometry audit. Transcript ends at a sentence
boundary. Neither framing nor boundary intent can be inferred from EDIT alone.

## Verification and evidence

- Added eight regression/edge-case tests. Before the patch, three new cases
  failed with center instead of safe-fit; after the patch all passed.
- Full reframe suite: 17 files, 534 tests passed.
- Shared build, worker typecheck and worker build passed in a disposable
  container using the isolated worktree; live worker source was not changed.
- Re-ran detection once per real source, comparing baseline and patched
  planners with identical evidence and production reframe configuration.
  First clip changed center → safe-fit; the other two plans were identical.
- Re-rendered the complete first clip with the application filtergraph and
  subtitles. Inspected an output frame: both panels are retained. FFprobe:
  H.264 1080×1920, AAC audio, 53.10 seconds.

Local private evidence (gitignored):
`apps/worker/tmp/feedback-review/` in `/srv/dev/clipclap.io`, with numbered
`0`, `1`, `2` JSON snapshots, source/clip MP4s, frame samples and replay JSON.
Candidate render: `0-after.mp4`; still: `0-after.jpg`.
Customer clips, feedback records and storage objects have not been overwritten.
