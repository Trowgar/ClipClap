# Stream Reframe: Webcam-Over-Content Sources

**Date:** 2026-08-02
**Status:** Draft - awaiting owner review
**Scope:** RENDER stage only. Extends the `reframe` module (`apps/worker/src/reframe/`) with a source
classifier, a webcam-rectangle detector in the existing Python sidecar, a fourth shot layout, and a
`CropPlan` version bump. Touches `apps/worker/src/stages/render.ts` only at the plan-build and
filtergraph-build seams. Does **not** touch ANALYZE, the queue, the schema, or any user-facing surface.

Builds on [2026-07-24-smart-reframe-design.md](2026-07-24-smart-reframe-design.md), which established
per-shot layout planning, the `CropPlan` contract, and the fallback discipline this design reuses.

---

## 1. Problem

The engine produces a broken clip from any stream source where the webcam is a small inset over
gameplay or a shared screen. This is not a hypothesis - it was rendered and inspected on 2026-08-01
from a real 55-minute CS2 stream (1280x720, 60 fps).

The failure mechanism: the face detector correctly finds the streamer's face, but that face lives
inside a 427x240 webcam inset. The layout planner then does exactly what it was built to do - it
centres a 9:16 window on the face. The result is a vertical clip containing a **truncated webcam**,
the streamer's **chat overlay** underneath it, and a meaningless slice of game floor below that. The
game itself is essentially absent.

Measured on that fixture:

| Signal | Value |
|---|---|
| Source | 1280x720, 60 fps, 3349 s |
| Webcam inset | 427x240 at (0,0) - exactly 1/3 of width and height, top-left |
| Inset stability | unchanged across all 24 sampled points over 55 minutes |
| Face box (source px) | 43.4 x 56.4 at (179.5, 109.9) |
| Face width as fraction of frame width | **3.4%** |
| Detector reliability on this face | 111 of 120 sampled frames, mean score 0.89 |

For contrast, a podcast or full-frame facecam puts the face at 15-30% of frame width. The order-of-
magnitude gap between 3.4% and 15% is the single most discriminative signal available, and it is free -
the detector already reports it.

**Two distinct defects follow, and they are independently fixable:**

1. **The engine centres on a face too small to centre on.** This produces the garbage described above
   on *every* unrecognised stream layout, including chroma-key cams that have no rectangle at all.
2. **The engine has no layout that shows a webcam and its content together.** This is the feature.

Defect 1 is hours of work and strictly improves output. Defect 2 is the design below. They ship
separately, in that order.

---

## 2. Fixed product decisions

Settled with the owner before design; the design operates within these.

1. **Target composition is webcam on top, content below** - the stacked look, not a picture-in-picture
   overlay. The owner supplied a reference frame showing roughly 40% webcam / 60% content.
2. **The dominant source shape is a corner inset over full-screen content**, evidenced by the supplied
   fixture. A dedicated webcam *zone* (side-by-side scene composition) is a real shape but is out of
   scope for v1; it falls back.
3. **Detection is automatic.** No user-facing toggle in web or bot. The classification decision and its
   evidence are recorded in the plan so a toggle can be layered on later without redesign.
4. **Existing behaviour for facecam and podcast sources must not change.** This design only claims
   territory that currently produces garbage.

---

## 3. Non-goals

Deliberately excluded, with the reason:

- **Chroma-key / borderless webcams.** No rectangle exists to detect. Falls back to §7.
- **Dedicated webcam zones** (cam occupying a band beside or above content in the source scene). The
  detector in §5 searches for a *small* rectangle; a half-frame zone is rejected by the size guard.
- **Motion- or saliency-driven content framing.** v1 picks the content window geometrically (§6.4). A
  saliency crop is the documented next step for faceless content generally and is not made worse by
  this design.
- **Dynamic layout switching** (cam full-frame during reactions, content full-frame during action). The
  plan format below can express it per shot; nothing in v1 emits it.
- **Two-webcam / co-stream sources.**

---

## 4. Source classification

A single pass over the face tracks the detector already produces, plus one new signal (§5). No new
frame extraction, no second model.

Let `Ws`, `Hs` be source dimensions and `fw` the widest surviving face track's box width.

| Condition | Class | Layout |
|---|---|---|
| no surviving face tracks | `faceless` | `center` (unchanged) |
| `fw >= FACE_LARGE_FRAC * Ws` (default 0.10) | `normal_face` | existing `single`/`split` logic, **unchanged** |
| `fw < FACE_SMALL_FRAC * Ws` (default 0.06) **and** a cam rect is found (§5) | `stream` | **`stream` (new)** |
| `fw < FACE_SMALL_FRAC * Ws`, no cam rect | `small_face` | `center` (**changed - see §4.1**) |
| otherwise (`fw` between the two fractions) | `normal_face` | existing `single`/`split` logic, **unchanged** |

**The floor is exclusive.** A face exactly at `FACE_SMALL_FRAC * Ws` anchors; only one strictly below it is barred. Stated because the implementation is a single `>=` comparison and prose that disagreed with it at exactly the boundary would be trusted by whoever tunes the threshold next.

`normal_face` deliberately does not re-decide between `single` and `split`. That choice already belongs
to `buildCropPlan`'s bbox-spread and dominance rules, and this design does not touch them - it only
decides whether those rules are allowed to run at all.

The band between 6% and 10% resolves to the existing path. Only below 6% does behaviour change, which
bounds the blast radius of this design to sources that are currently broken.

### 4.1 The min-face guard (defect 1, ships independently)

`buildCropPlan` currently emits `single` or `split` for any surviving track. It gains one rule: a track
whose box width is below `FACE_SMALL_FRAC * Ws` **may not anchor a crop window**. When every surviving
track is that small and no cam rect is available, the shot gets `center`.

On the fixture, `center` yields a 406x720 window at x=437 - a clean, readable vertical slice of the game
with the crosshair near centre. That is not a great clip, but it is an ordinary one, and it replaces a
clip that is unusable.

This rule is correct independently of everything else in this document. It requires no config flag, no
new detector, and no plan version bump. It should ship first and alone.

---

## 5. Webcam rectangle detection

### 5.1 Why this approach

Three approaches were considered:

1. **Face-anchored rectangle search scored by border edge energy** - chosen.
2. **Global persistent-edge map** with rectangle assembly. More general (would also catch dedicated
   zones), but game HUDs, chat overlays and alert boxes all emit strong persistent lines, so it carries
   4-6 thresholds instead of one.
3. **Motion-statistics segmentation** (game pans, webcam does not). Most general, works without a
   border, but the noisiest signal and the most thresholds.

The deciding argument is not generality, it is falsifiability. There is exactly one fixture. Approach 1
has one substantive threshold and its output is a rectangle a human can check against a frame in one
look. Approaches 2 and 3 would be tuned to this one stream and would then be believed. The repository
already records that failure twice: a YouTube capability confirmed on one video that failed on seven,
and `scdet` thresholds tuned on one podcast that under-segmented another.

The plan format (§6.1) carries an arbitrary rectangle, not a corner-and-scale. Detector 2 or 3 can
replace this one later without touching layout, filtergraph, or render.

### 5.2 Algorithm

Runs inside `apps/worker/assets/reframe/detect_faces.py`, on the frames already extracted for face
detection (`fps=REFRAME_SAMPLE_FPS`, `scale=640:-2`). Verified available in the worker image:
OpenCV 4.12.0, numpy 2.3.5. **No new dependencies.**

1. **Gate.** Run only when the dominant face track's width is `< FACE_SMALL_FRAC * Ws`. Otherwise skip
   entirely and return no rect - this keeps the cost at zero for podcasts and facecams.
2. **Temporal edge map.** For a bounded sample of frames (`min(24, all)`), compute Sobel magnitude, then
   take the per-pixel **median** across frames. Median, not mean: it suppresses moving game content and
   preserves static compositing borders.
3. **Border candidates.** Project the median map onto each axis (column sums of vertical-gradient
   energy; row sums of horizontal-gradient energy). Take local maxima above the projection's median as
   candidate `x` and `y` border positions. Always include frame edges 0, `Ws`, 0, `Hs` as candidates,
   since insets are commonly flush to a corner.
4. **Rectangle assembly.** Form candidate rects `(x0,x1,y0,y1)` from those positions, keeping only rects
   that: contain the face box entirely with `>= 2%` margin on every side; fit within `PIP_MAX_FRAC`
   (default 0.50) of the frame on **both axes**; and have area `>= 4x` the face box area.

   The height cap is not decoration. Capping width alone - which is how this was first specified - lets a
   degenerate box the inset's correct width but the frame's full height beat every real candidate under
   area-based selection. Measured: that omission alone took the detector from 26 correct rectangles out of
   26 down to 0 out of 26. A webcam inset is small in both dimensions; there was never a reason to bound
   only one.
5. **Score.** For each candidate, score = **the minimum** of the four sides' mean edge energy along the
   side, normalised by the frame's mean edge energy. Minimum rather than mean, so a rectangle with one
   weak side is rejected rather than averaged into acceptance.

   **A side lying on the canvas edge is skipped, not scored.** OpenCV's Sobel uses `BORDER_REFLECT_101`,
   so at column 0 the virtual column -1 *is* column 1 and the derivative is identically zero: `vx[:,0]`
   and `hy[0,:]` can never carry energy. A corner-flush inset - the primary case this design targets -
   therefore scored **0.00** and lost to an arbitrary interior box. The canvas edge is a real border the
   compositor clipped against, not a missing one. Measured 2026-08-02 during implementation; as originally
   specified this algorithm could not have detected the fixture at all.
6. **Accept** the winning candidate if its score `>= PIP_EDGE_MIN`. Otherwise return no rect.

   **Selection is by largest area among candidates clearing the bar, not by highest score.** Each side is
   a mean over the candidate's own span, so trimming `x0` inward raises the top and bottom means by
   excluding a weak leftmost portion - `argmax(score)` actively rewards shrinking. Measured on the fixture:
   the right, bottom and top edges were exact in 26 of 26 sampled windows while the left edge was exact in
   only 16, trimming by 12-61 px elsewhere, a 20% width error. The `min`-of-sides rule still requires every
   border to be real and `PIP_MAX_FRAC` still caps the top end, so "largest" cannot run away.

Coordinates are reported in **source pixels**, matching the existing face-box contract. At 640-wide
detection frames on a 1280-wide source, one detection pixel is two source pixels; the rect is scaled and
then snapped outward to even values.

### 5.3 Sidecar contract change

`detect_faces.py` gains one optional key per shot. The existing strict validator in `faces.ts`
(`parseDetectorOutput`) is extended to accept and validate it, and to treat its absence as "no rect"
rather than as a violation - so an older sidecar cannot break a newer worker.

```json
{ "shotIndex": 0,
  "tracks": [ ... ],
  "camRect": { "x": 0, "y": 0, "w": 427, "h": 240, "score": 4.7 } }
```

### 5.4 One rect per clip, one decision per shot

The inset is static - measured across 55 minutes of the fixture. Detecting it per shot would be waste
and would introduce per-shot jitter in a geometry that should not move.

- The **rectangle** is resolved once per clip: the per-shot rects are collected, and the median rect is
  taken if at least half the shots agree within 2% of frame width on all four edges. Disagreement means
  the scene composition changes mid-clip, and the clip falls back (§7).
- **Whether a given shot uses the stream layout** is decided per shot: a shot uses it only if that shot
  has a surviving face track inside the resolved rect. Shots without one - advertisement cards,
  intermissions, replays, full-screen moments - render with the base layout instead.

The fixture contains exactly such a frame (a full-screen BetBoom advertisement with no webcam), so this
is a measured case, not a speculative one.

---

## 6. Layout geometry

### 6.1 Plan format - `CropPlan` v2

```ts
export type ShotLayout =
  | { start: number; end: number; layout: "center"; x: number }
  | { start: number; end: number; layout: "single"; x: number }
  | { start: number; end: number; layout: "split"; top: { x: number }; bottom: { x: number } }
  | { start: number; end: number; layout: "stream"; cam: { x: number }; content: { x: number } };

export interface StreamGeometry {
  camCrop:     { w: number; h: number; y: number };  // source px; x varies per shot
  contentCrop: { w: number; h: number };             // source px; h === source.height
  outCamH:     number;                               // output px, even
  outContentH: number;                               // output px, even, outCamH + outContentH === 1920
}

export interface CropPlan {
  version: 1 | 2;
  engine: "faces";
  source: { width: number; height: number };
  profile?: { class: SourceClass; faceFrac: number; camRectScore?: number; reason?: string };
  stream?: StreamGeometry;                            // present iff any shot has layout "stream"
  shots: ShotLayout[];
}
```

Only `x` varies per shot. All sizes are clip-constant, which keeps the existing `piecewiseX` machinery
usable unchanged and keeps the filtergraph a single static graph.

`sliceCropPlan` accepts both versions and carries `stream` and `profile` through untouched. Stored v1
plans on existing `Clip` rows keep rendering exactly as today.

**A plan may not contain both `split` and `stream` shots.** Mixing them would require five scaled inputs
in one graph for no product benefit. When the classifier resolves to `stream`, podcast-split is disabled
for that clip; `buildCropPlan` enforces this.

### 6.2 The governing equation

Output is 1080x1920. The content tile is filled from a source window of width `Wg` at **full source
height**, scaled to 1080 wide. Therefore:

```
Hg = Hs * 1080 / Wg          content tile height
Hc = 1920 - Hg               cam tile height
```

The relationship runs opposite to intuition and must be stated explicitly, because it inverts the
adjustment rule: **a taller cam tile requires a *wider* content window**, since a shorter content tile
is proportionally wider and must be fed from a wider source region.

Worked on the fixture (`Ws`=1280, `Hs`=720):

| cam share | `Hc` | `Hg` | required `Wg` (ideal, before rounding) | fits free band (853 px)? |
|---|---|---|---|---|
| 0.30 | 576 | 1344 | 578.6 | yes |
| 0.35 | 672 | 1248 | 623.1 | yes |
| **0.40** | **768** | **1152** | **675.0** | **yes** |
| 0.45 | 864 | 1056 | 736.4 | yes |
| 0.50 | 960 | 960 | 810.0 | yes |
| 0.55 | 1056 | 864 | 900.0 | **no** - would overlap the inset |

So when the content window will not fit the free band, the cam share must be **reduced**, not raised.

### 6.3 Solving for the tiles

`evenRound(v)` is `2 * Math.round(v / 2)` - the same rounding the existing `evenClamp` uses, so the two
agree at halfway values.

Given `camRect`, target share `CAM_SHARE` (default 0.40), bounds `CAM_SHARE_MIN` 0.30 / `CAM_SHARE_MAX` 0.55:

1. `Hc0 = evenRound(CAM_SHARE * 1920)`; `Hg0 = 1920 - Hc0`; `Wg = evenRound(Hs * 1080 / Hg0)`.
2. Recompute `Hg = evenRound(Hs * 1080 / Wg)` and `Hc = 1920 - Hg` so the tiles sum to exactly 1920.
   `Hc` therefore lands a few pixels off the requested share - on the fixture, 770 rather than 768 -
   and every subsequent step uses the recomputed `Hc`, not the target. The residual aspect error from
   even-rounding is under 0.05%, which is sub-pixel and invisible.
3. **Fit test.** Compute the free horizontal bands - `[0, camRect.x]` and `[camRect.x + camRect.w, Ws]` -
   and take the wider one, `B`. If `Wg > width(B)`, reduce the share by 0.025 and repeat from step 1.
   If `CAM_SHARE_MIN` is reached and it still does not fit, **do not** emit a stream layout: fall back
   (§7). Rendering the inset twice, once large and once as a sliced fragment, is worse than not
   splitting at all.
4. **Cam crop (cover).** Required aspect `a = 1080 / Hc`.
   - if `camRect.w / camRect.h >= a`: `camCrop.h = camRect.h`, `camCrop.w = evenRound(camRect.h * a)`
   - else: `camCrop.w = camRect.w`, `camCrop.h = evenRound(camRect.w / a)`
   - `camCrop.y` centres the crop vertically inside `camRect`, clamped inside it.
   This is total: one branch or the other always yields a crop inside `camRect`.
5. `contentCrop = { w: Wg, h: Hs }`.

Fixture result at the default share, carried through the rounding above: `Wg` = 676, `Hg` = 1150,
`Hc` = 770. Cam tile 1080x770 from a 336x240 crop (**3.21x upscale**), content tile 1080x1150 from a
676x720 crop. Cam crop x anchored on the face centre at 201; content window x constrained to [427, 604].

### 6.4 Per-shot x

- **Cam x** centres `camCrop.w` on that shot's face centre, clamped inside `camRect`.
- **Content x** targets the centre of the content region, clamped into the free band `B`. On the
  fixture the ideal centre (640 - 674/2 = 303) is clamped to 427, putting the CS2 crosshair at 32% of
  tile width - off centre but present and large. A motion-centroid target is the obvious later
  refinement and needs no format change.

Adjacent shots merge under the existing `mergeAdjacentLayouts` rule, extended to the `stream` variant
with the same 4%-of-width tolerance on both x values.

### 6.5 Upscale is acceptable, and this was measured, not assumed

A 427-px inset filling a 1080-wide tile is a 2.53x upscale; the 40% composition crops to 336 px and so
upscales 3.21x. The arithmetic suggests this should look bad. It was rendered and inspected at 1:1
against the source pixels: a clean, well-lit, low-noise webcam **softens** under that scale rather than
breaking up. The 3.20x variant is visibly softer than 2.53x and remains usable at phone size.

No resolution floor is imposed, because the measurement does not support one. If a later fixture shows
a noisy or dark inset failing at 3x, the correct response is a floor derived from that measurement, not
from the ratio.

---

## 7. Fallback chain

Every failure is a fallback, never an exception, matching the existing `ReframeFallbackReason` contract.
New reasons: `stream_no_rect`, `stream_rect_unstable`, `stream_no_fit`, `stream_disabled`.

| Condition | Result |
|---|---|
| `REFRAME_STREAM` not enabled | classify only, record profile, emit today's layouts |
| face too small, no rect found | `center` per §4.1 |
| rect found but shots disagree (§5.4) | `center` per §4.1 |
| rect found but no cam share fits the free band | `center` per §4.1 |
| shot has no face inside the resolved rect | that shot renders with the base layout |
| any sidecar or ffmpeg failure | existing behaviour: `plan: null`, legacy centre crop |

---

## 8. Filtergraph

Extends `buildFiltergraph`. A plan with no `stream` shots compiles exactly as today - the existing
`vf` and `complex` branches are untouched.

```
[0:v]split=3[b0][c0][m0];
[b0]<existing base chain>[base];                                  // 1080x1920
[c0]crop=camW:camH:x='<piecewise>':y=camY,scale=1080:outCamH,setsar=1[cam];
[m0]crop=contentW:ih:x='<piecewise>':y=0,scale=1080:outContentH,setsar=1[cont];
[base][cam]overlay=x=0:y=0:enable='<stream windows>'[o1];
[o1][cont]overlay=x=0:y=outCamH:enable='<stream windows>'[o2];
[o2]<ass>[vout]
```

Notes carried from measurement, not from documentation:

- `enable` uses the half-open `gte(t,s)*lt(t,e)` form already used by the podcast split. `between()` is
  inclusive at the end and flashes the overlay one frame past the seam.
- `setsar=1` after each `scale` is **required**. Without it, ffmpeg 8.x segfaulted while stacking these
  exact tile sizes during this design's own rendering work - reproduced, then fixed by pinning SAR.
- Outside stream windows the tile x expressions carry the nearest stream geometry so the expressions
  stay total, exactly as the existing split branch does.

---

## 9. Invariants

Violations here fail the **encode**, bypassing every detection-time fallback. Each gets a guard and a test.

1. `camCrop.w <= camRect.w`, `camCrop.h <= camRect.h`, `contentCrop.w <= Ws`. Never emit `crop w > iw`
   (ffmpeg error -22).
2. All crop dimensions and offsets even.
3. `outCamH + outContentH === 1920` exactly.
4. Merged plan length `<= MAX_PLAN_SHOTS` (90). `av_expr` fails at 100 nested segments.
5. Sources where `cropWidthFor(Hs) >= Ws` (already vertical or narrower) are untouched, as today.
6. No plan contains both `split` and `stream` shots.

---

## 10. Configuration

All defaults chosen so that **not setting anything reproduces today's behaviour except the min-face guard.**

| Variable | Default | Meaning |
|---|---|---|
| `REFRAME_STREAM` | `off` | killswitch for the stream layout; classification and telemetry run regardless |
| `REFRAME_CAM_SHARE` | `0.40` | target cam tile share of output height |
| `REFRAME_FACE_SMALL_FRAC` | `0.06` | strictly below this, a face may not anchor a crop |
| `REFRAME_FACE_LARGE_FRAC` | `0.10` | at or above this, existing facecam/podcast paths apply |
| `REFRAME_PIP_MAX_FRAC` | `0.50` | a cam rect exceeding this on **either** axis is not an inset |
| `REFRAME_PIP_EDGE_MIN` | `4.0` | minimum normalised border energy to accept a rect |

`REFRAME_PIP_EDGE_MIN` is the only one of these that was actually measured. On the 55-minute CS2 VOD,
2026-08-02: 26 true detections scored **5.65 to 8.84**, the strongest false candidate scored **1.54**, and
every threshold in **3.0 to 5.0** produced identical output. 4.0 is the middle of that empty corridor.

The width of the corridor matters more than the number in it. A threshold sitting in a four-unit gap is a
switch; a threshold tuned into a 10% gap - which one rejected variant of this design required - is a fit to
one video wearing a constant's clothing. That distinction is the reason the narrow single-threshold detector
was chosen over the more general multi-threshold ones in §5.1.

The other three thresholds are provisional and rest on the same single fixture. They are env-tunable for
exactly that reason, and every decision writes its inputs to the plan (§11) so they can later be set from
counted evidence rather than re-guessed.

---

## 11. Telemetry

`CropPlan.profile` records the class, the measured `faceFrac`, the accepted rect score, and the fallback
reason when one fired. It is persisted in `Clip.cropPlan`, which the render stage already writes.

`planLayoutCounts` gains a `stream` key; the render manifest gains the resolved class and cam share.
This is the substrate for answering "which source shapes do real users actually upload" with a query
instead of an opinion, once real users upload anything.

---

## 12. Testing

**Pure TypeScript, no video** - the geometry solver is deterministic arithmetic and deserves real tests:
tile solving across shares and source sizes, the fit-and-reduce loop including the give-up path, cover
crop on wide / 4:3 / vertical insets, evenness, the 1920 sum, free-band selection for insets in each of
the four corners, per-shot x clamping, `stream` merge tolerance, v2 slicing, v1 back-compat, the
mixed-layout rejection, and every invariant in §9.

**Classifier table**: one case per row of §4, including both boundary fractions.

**Sidecar**: a handful of downscaled JPEG frames committed as fixtures (kilobytes, not the source video)
with the expected rect asserted within a 2%-of-width tolerance, plus a negative fixture - a full-frame
facecam - that must return no rect.

**Filtergraph**: string snapshots for a stream-only plan, a mixed stream/center plan, and a plan with an
ass snippet; assert `setsar=1` present, `enable` in half-open form, and tile heights summing to 1920.

**Three untested existing paths** are within this design's blast radius and currently have no coverage
at all: `computeCropPlan`, `detectShots`, and the reframe branch of `render.ts`. Minimal tests for them
are part of this work, not a separate effort.

**Visual harness** - `apps/worker/src/scripts/eval-reframe.ts`: takes a video plus timestamps, writes the
computed plan as JSON and a contact sheet of rendered candidates. This is the ad-hoc procedure used to
produce the evidence in §1 and §6.5, made repeatable. Without it, every future framing decision is
argued rather than seen.

---

## 13. Rollout

1. **Min-face guard alone** (§4.1). No flag, no format change. Strictly removes broken output.
2. **Detector plus geometry, `REFRAME_STREAM=off`.** Classification and telemetry run; layout does not
   change. Confirms the classifier is not misfiring on the existing podcast fixtures.
3. **`REFRAME_STREAM=on`,** validated against the CS2 fixture with the visual harness.
4. Update [docs/engine-notes.md](../../engine-notes.md) §7 with what was measured, including the
   inverted cam-share relationship and the SAR segfault, both of which cost time to discover.

---

## 14. What this design does not settle

Stated so it is not later mistaken for settled:

- **Thresholds rest on one fixture, one streamer, one OBS layout.** The mechanism is validated; the
  numbers are not. A second and third source of different shape are needed before any threshold is
  treated as known.
- **The corner assumption.** Insets that are centred, edge-centred, or heavily inset from a corner are
  handled only insofar as a free band remains; the fit test will decline the rest.
- **Content framing is geometric, not semantic.** The window goes where it fits closest to centre, with
  no notion of where the action is.
- **This work serves a hypothesis.** As of 2026-08-02: 108 registered users, 10 jobs ever, 3 users who
  ever ran one, zero stream sources ever submitted, and zero jobs in the two days since the free tier
  opened. None of the six recorded clip-quality rejections was caused by framing. The owner reviewed
  these figures on 2026-08-02 and chose to proceed with stream support; this note records the basis of
  that choice, not a reservation about it.
