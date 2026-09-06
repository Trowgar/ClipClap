# Stream webcam context design

## Problem

The stream layout enlarges a synthesized webcam crop too aggressively. On the
paid customer's 1920x1080 source, a 282x200 window is scaled to the 1080x768
camera tile. The face stays fully visible, so the existing safety metric passes,
but the crop loses the shoulders and surrounding webcam context. The customer's
explicit request was to zoom the face out.

The full-frame gameplay change shipped earlier is independent and remains in
place.

## Scope

- Affect future stream plans that use `profile.virtualCam === true`.
- Show more context around the face without changing the 1080x1920 output or
  the camera/content tile heights.
- Keep detected, hard-bordered webcam rectangles inside their detected bounds.
- Do not mutate historical `Clip.cropPlan` rows or automatically rerender
  existing clips.

## Design

Tune the synthesized virtual camera rectangle at its source in `plan.ts`.
Generate candidate rectangles at several face-width multipliers around the
current value, render them against the retained customer source, and choose the
smallest multiplier that consistently shows the head, shoulders, and useful
surrounding context. The selected value becomes the single shared virtual-camera
constant.

Keep the existing face-centred horizontal placement, headroom/chin guarantees,
even-pixel snapping, frame clamping, stream classification, and output tile
geometry. Real camera rectangles continue through their current path unchanged.
The renderer continues to contain the complete gameplay frame over blur.

This is preferable to renderer-side padding because renderer padding cannot
distinguish a borderless virtual camera from a hard-bordered inset in historical
plans and can pull gameplay pixels into the camera tile. Reducing the camera
tile height is also rejected: it makes the face smaller on screen without
recovering any source context.

## Compatibility

Only newly computed virtual-camera plans receive the wider crop. Existing plans
remain renderable byte-for-byte. No schema, API, queue, or persisted type changes
are required.

## Verification

1. Add a regression test showing that the customer-shaped face produces a
   materially wider virtual camera crop while remaining in-frame and even-sized.
2. Confirm detected camera rectangles and non-stream plans are unchanged.
3. Render the retained customer source and visually compare the face scale and
   surrounding context with the current production clip.
4. Probe the output as 1080x1920, SAR 1:1, DAR 9:16.
5. Run focused reframe tests, worker typecheck, and worker build before deploying
   only `worker-render` while its queue is idle.
