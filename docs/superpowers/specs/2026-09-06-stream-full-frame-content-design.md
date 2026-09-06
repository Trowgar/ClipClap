# Stream full-frame content design

Date: 2026-09-06
Status: approved direction, pending implementation

## Problem

The stream layout enlarges the webcam into one vertical tile and fills the
remaining tile with a full-height crop of the source. On a 1920x1080 stream,
the current production example keeps only 1012 horizontal pixels for gameplay.
That removes about 47% of the source width, including game UI and action that
is not near the fixed centre. The existing safety score does not catch this:
it measures face-region coverage, not preservation of the gameplay frame.

This is a layout-wide defect. Every source classified as `stream` uses the
same cover-crop rule, even though the exact crop width varies with webcam
geometry. Two fresh FRAMING ratings from one production stream reproduced the
failure on 2026-09-06. Customer identifiers, media links, and clip identifiers
remain in the ignored private feedback corpus and are not recorded here.

## Decision

Keep the existing stream classifier, webcam detection, webcam crop, tile
heights, subtitles, and output contract. Change only the content tile:

- the webcam tile remains a full-width cover crop;
- the content tile contains the complete source frame, preserving both
  horizontal edges;
- unused space in the content tile is filled by a blurred cover-scaled copy of
  the same source, matching the existing `safe-fit` visual treatment;
- the contained foreground stays centred and has square pixels;
- subtitles remain the final filter, above the composed tiles;
- non-stream layouts remain byte-identical.

The stored stream plan retains its current geometry fields for backward
compatibility. The renderer no longer uses `content.x` or `contentCrop` to
slice stream content, but older persisted plans stay valid and retrimmable.
No schema migration, new dependency, or environment flag is required.

## Alternatives rejected

Turning stream layout off would preserve the game but return the webcam to a
small source inset. Following action with saliency would keep action large but
would still remove HUD/context and introduces motion risk. The contained
content tile is the smallest change that preserves both webcam visibility and
the whole game frame.

## Failure handling

Existing crop-plan validation and renderer fallback behavior stay unchanged.
Invalid or absent stream geometry continues to fall back to the base crop.
The new composition uses only existing ffmpeg filters already used by
`safe-fit`: `split`, `scale`, `crop`, `boxblur`, and `overlay`.

## Verification

A regression test will assert that stream content is scaled from the complete
input frame with `force_original_aspect_ratio=decrease`, rather than cropped
through `content.x`. Existing filtergraph, output-geometry, render-reframe,
plan, and full worker tests must remain green. A render of the retained private
production example must show the full gameplay width while keeping the webcam
tile and the 1080x1920 SAR/DAR contract.

Deployment is limited to rebuilding and recreating `worker-render`, followed
by container health/log checks and an effective-image verification. Other
services and analysis behavior are out of scope.
