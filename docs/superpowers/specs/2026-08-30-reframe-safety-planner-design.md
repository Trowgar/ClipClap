# Reframe safety planner design

**Date:** 2026-08-30  
**Status:** approved architecture; implementation starts with the deterministic
safety slice in §11

## 1. Context

The negative-feedback audit found one repeated engine-caused cluster: portrait
reframing loses salient people or screen regions. The four anonymized shapes
were:

- a reaction/group shot whose merged static crop kept only one side of the
  group;
- a long talking-head shot where one crop remained active through a graphic
  insert;
- a multi-subject shot briefly misclassified as a stacked stream layout,
  cutting a face across tiles; the shipped virtual-stream coverage gate should
  now demote this historical plan shape, but it remains a regression fixture;
- gameplay/UI footage where a face-led or centered crop omitted important
  screen content.

The current implementation already has useful primitives: `Shot` and
`ShotTracks`, face paths, per-shot one-dimensional saliency, `single`, `split`,
`stream`, and `center` layouts, optional camera trajectories, an encode-failure
fallback, and reframe telemetry. Important constraints in the real code are:

- `CropPlan.shots` owns layout geometry; there is no top-level layout or
  keyframe list;
- `buildTargetSamples` currently carries the earliest face box backward before
  that face's first observation;
- saliency is only `{x, spreadFrac}`, not a two-dimensional focal region;
- no UI/text region detector exists;
- the current render retry handles encode failure, not visual-quality failure;
- `safe-fit` is not yet a `ShotLayout` variant or filtergraph path.

The solution must therefore fail closed: use an intelligent portrait layout
only when its containment is provably safe, otherwise preserve the whole source
composition.

## 2. Goals

- Keep at least 90% of every trusted, mandatory focal region visible at every
  evaluated sample of an accepted layout.
- Preserve people, graphics, text, and important UI as more detectors become
  available without coupling layout policy to any one detector.
- Avoid crop jumps, layout flicker, and fabricated pre-appearance face motion.
- Provide a deterministic `safe-fit` fallback that preserves the full frame.
- Validate both the plan and, later, the rendered artifact; retry at most once
  with a safer plan.
- Ship behind exact-literal feature flags with a global kill switch, measurable
  shadow mode, and replay-based regression evidence.
- Keep media, frames, transcripts, and user identifiers out of normal
  telemetry.

## 3. Non-goals

- Replacing shot detection, face tracking, or the current layout renderer in
  one release.
- Shipping OCR, a general UI detector, or a VLM decision path in the first
  slice.
- Improving highlight selection, boundaries, subtitles, or source quality.
- Guaranteeing that the most semantically interesting object was detected;
  this design guarantees containment only for trusted regions it receives.
- Allowing unbounded retries or silently delivering a plan that failed its
  safety contract.

## 4. Decision and alternatives

### Chosen: candidate planner plus hard safety gate

Normalize detector evidence into regions, generate existing and safe
composition candidates per segment, reject every candidate that violates hard
containment or stability rules, then score only the survivors. If no portrait
candidate survives, emit `safe-fit`.

This is preferable to merely enabling motion or saliency: movement may improve
one tracked face while still cutting a group or UI. It is also safer than a
VLM-first planner: model judgments are nondeterministic, slower, harder to
replay, and cannot be the final safety authority.

Alternatives rejected:

1. **Tune the existing crop thresholds.** Low implementation cost, but it
   treats each observed failure independently and provides no invariant.
2. **Use a vision model to select every layout.** Better semantic reach, but
   high latency/cost and no deterministic containment guarantee. A bounded VLM
   escalation remains a deferred input to candidate ranking, never an override
   of the hard gate.

## 5. Architecture

The pipeline becomes:

`detectors -> normalized regions -> composition segments -> candidates -> hard
safety gate -> temporal scorer -> CropPlan -> render -> artifact validator ->
optional safe retry`

### 5.1 Multi-signal regions

Detector-specific output is converted to a common, clip-relative contract:

```ts
type RegionKind = "face" | "saliency" | "ui" | "text";

interface FocalRegionSample {
  t: number;
  box: { x: number; y: number; w: number; h: number }; // source pixels
  confidence: number;                                  // 0..1
}

interface FocalRegionTrack {
  id: string;                    // ephemeral within one plan, never user data
  kind: RegionKind;
  priority: "mandatory" | "supporting";
  samples: FocalRegionSample[];
}
```

Adapters, not the planner, decide confidence and priority. Initially, surviving
face tracks become mandatory regions. Existing one-dimensional saliency cannot
be promoted to a mandatory box; it stays a ranking hint until a calibrated 2D
adapter exists. UI and text adapters are future inputs behind independent
flags. A low-confidence signal may rank candidates but cannot force an unsafe
crop or suppress `safe-fit`.

### 5.2 Composition segments

Layout is selected per composition segment, not blindly per detected shot.
Segment boundaries are the sorted union of:

- scene cuts and recovered cuts;
- appearance/disappearance of a mandatory region;
- material region-group or bounding-envelope change;
- graphic/UI/text transitions once those adapters exist;
- a maximum segment duration used only to bound validation cost.

Boundaries closer than a small debounce window are coalesced unless merging
would mix different mandatory-region lifecycles. This directly prevents a crop
chosen before a graphic insert from spanning the insert.

**Pre-first-face rule:** a face track does not exist before its first observed
sample. No earliest box may be carried backward. Between observed samples, a
bounded last-known/interpolated position is allowed; after the allowed gap the
track becomes uncertain and the segment must be split or use `safe-fit`.

### 5.3 Candidate layouts

For each segment the planner generates only geometrically valid candidates:

- `single`: one portrait crop, optionally with a bounded trajectory;
- `split`: two independently cropped full-width tiles;
- `stream`: webcam/content composition, retaining the existing real/virtual
  camera classification and coverage gate;
- `safe-fit`: the complete source frame scaled with `contain` into 1080x1920,
  with a blurred copy or configured neutral background filling unused space.

`center` remains a legacy candidate, not a safety fallback: it must pass the
same coverage checks as `single`. `safe-fit` is the only guaranteed visual
fallback because it preserves the complete source frame. Adding it requires a
new `ShotLayout` variant and a new plan version; old plan versions remain
readable and byte-identical.

## 6. Safety and selection policy

### 6.1 Hard coverage

Coverage of a region sample is the visible intersection area divided by the
sample box area after applying the candidate's crop/tile transform. For every
trusted mandatory sample:

`visible_area(region, candidate) / area(region) >= 0.90`

The threshold is per region and per sample, not an average. One fully lost face
cannot be hidden by many successful samples. Samples within a detector-defined
uncertainty gap are evaluated at the worst allowed position; if that cannot be
bounded, the portrait candidate is rejected. `safe-fit` covers the full source
and therefore passes by construction.

Supporting regions contribute to ranking and telemetry but do not veto until
their detector is calibrated and explicitly promoted. Text/UI safe areas may
later impose stricter edge padding in addition to the 90% area rule.

### 6.2 Temporal stability

Among candidates that pass hard safety, selection minimizes:

- layout switches and crop displacement;
- acceleration and direction reversals;
- divergence from the previous segment's framing;
- unnecessary use of `safe-fit` when a stable portrait candidate is safe.

Existing camera dead-zone, settle, speed, and keyframe caps remain authoritative
for `single`. Hysteresis requires a candidate to beat the current layout by a
configured margin before switching. Hard safety always overrides hysteresis.

Candidate ranking is lexicographic: hard safety, then temporal stability, then
portrait fill/semantic score. A prettier but unsafe crop can never win.

### 6.3 Uncertainty and deferred VLM escalation

Uncertainty is explicit when mandatory-region evidence is missing, stale,
contradictory, or too wide for a portrait composition. The deterministic result
is `safe-fit`, not a guessed crop.

A later, separately approved phase may sample only uncertain segments and ask a
VLM to label focal regions or rank already-safe candidates. The VLM receives
minimal frames, has a strict time/cost budget, is never called for confident
segments, and cannot override the 90% gate. VLM failure, timeout, or malformed
output resolves to `safe-fit`.

## 7. Plan and render integration

The planner produces a versioned `CropPlan` with per-segment layout and compact
safety evidence: selected layout, worst mandatory coverage rounded to a safe
precision, gate decision, signal kinds present, and fallback reason. Raw boxes
and detector samples are not persisted in normal production records.

`buildFiltergraph` gains a `safe-fit` branch. It must preserve aspect ratio,
produce 1080x1920 square-pixel output, compose subtitles once after layout, and
remain compatible with existing audio mapping. Existing `single`, `split`, and
`stream` graphs do not change while the feature flag is off.

### Post-render validation and bounded retry

A later artifact validator samples the encoded output at the same clip-relative
times used for planning and checks:

- output dimensions, duration, black/invalid frames, and filter success;
- projected containment of mandatory regions;
- layout seams and safe-area constraints for composite layouts.

If validation fails, render exactly once with an all-segment `safe-fit` plan.
The safe retry is validated with structural checks; if it also fails, preserve
the existing render-stage failure behavior rather than looping. Persist only
the plan that produced the delivered artifact and record the original failure
reason separately. Encode failure continues to use the existing retry path.

Artifact validation is intentionally deferred from the first slice: initially
the hard gate operates on source-space geometry and replay validates rendered
contact sheets offline.

## 8. Flags, rollback, and compatibility

All switches accept only the exact literal `on`:

- `REFRAME_SAFETY_PLANNER`: master behavior flag and immediate kill switch;
- `REFRAME_SAFETY_SHADOW`: compute decisions/telemetry without changing plans;
- `REFRAME_SAFE_FIT`: allow the new fallback layout;
- future independent flags for 2D saliency, UI/text adapters, artifact
  validation, safe retry, and VLM escalation.

Invalid or missing flags are off. `REFRAME_SAFETY_PLANNER=off` must produce the
same plan and filtergraph as today. If the master is on but `safe-fit` is off,
the first rollout must stay shadow-only; it may not reject a plan without a
safe rendering alternative. Rollback is flipping the master flag, not reverting
unrelated reframe logic.

## 9. Telemetry and privacy

Extend `ReframeCheck` with aggregate, non-identifying fields only:

- planner mode (`off`, `shadow`, `active`) and plan version;
- signal kinds and counts, never coordinates;
- candidate counts and rejection reasons;
- selected layout counts, minimum coverage bucket, stability bucket;
- `safe-fit` reason, retry attempted/result, validation reason;
- planning, validation, and optional VLM latency/cost buckets.

No source frames, contact sheets, face boxes, OCR text, transcripts, titles,
URLs, storage keys, user IDs, or model prompts enter routine telemetry. Debug
artifacts live only in the ignored private corpus with restrictive permissions
and explicit retention cleanup. Logs use job-scoped operational correlation
already present in the render stage and must not add user-visible content.

## 10. Verification and regression evidence

Testing follows three layers:

1. **Pure unit tests:** region lifetime, pre-first-face behavior, segment
   boundaries, coverage math, candidate rejection, stability/hysteresis,
   `safe-fit` filtergraph, flag-off invariance, and single-retry bounds.
2. **Captured replay:** run old and new planners over one immutable detector
   output so detection nondeterminism cannot explain a difference. Assert every
   mandatory sample reaches 90% coverage and no control regresses.
3. **Visual acceptance:** for each anonymized regression and representative
   controls, render aligned contact sheets at identical timestamps:
   `source | current | new`. Inspect people, graphics, UI/text legibility,
   seams, and camera stability. Sheets stay private and are not committed.

The four audited shapes are mandatory regressions. The broader existing camera,
stream, geometry, music, subtitle, and render suites are mandatory controls.
No rollout advances on a metric-only pass without the aligned contact sheets.

## 11. Staged delivery

### Slice 1: deterministic safety gate and replay only

This is the first implementation plan. It does **not** include VLM, OCR/UI
detection, active 2D saliency, or online post-render quality retry.

1. Correct the pre-first-face rule and freeze it with a failing test.
2. Add pure source-space coverage evaluation for existing trusted face paths.
3. Generate existing candidates, reject any candidate below 90%, and choose
   `safe-fit` when no portrait/composite candidate survives.
4. Add the versioned `safe-fit` layout/filtergraph, shadow/master flags, compact
   telemetry, and exact flag-off invariance tests.
5. Replay the four private regressions plus the broader control corpus from
   captured detections; produce `source | current | new` contact sheets.
6. Keep production behavior off until replay and manual review pass.

### Rollout after Slice 1 acceptance

1. Enable shadow computation for internal jobs; compare rejection and
   `safe-fit` rates with no output changes.
2. Canary active behavior on a small deterministic cohort; monitor rating,
   fallback, render-failure, and layout-switch deltas.
3. Increase exposure in steps only when hard-coverage violations remain zero,
   render failures do not regress, and negative framing feedback does not rise.
4. Stop and flip the master kill switch on any invariant violation, retry loop,
   material latency increase, or unexplained `safe-fit` spike.
5. Separately design and approve richer region adapters, artifact validation,
   and only then optional VLM escalation.

No automatic threshold tuning occurs during rollout. The 90% floor changes only
through a reviewed corpus-backed spec.

## 12. Failure modes and responses

| Failure | Response |
| --- | --- |
| Face false positive becomes mandatory | Apply existing survival/confidence policy; if still trusted, prefer safe-fit over cropping real content away. Track rejection reasons for calibration. |
| Face disappears or appears mid-shot | Split at its lifecycle boundary; never backfill before first observation. |
| Multiple regions do not fit portrait crop | Try valid split/stream candidates; otherwise safe-fit. |
| Graphic/UI change lacks a detector | Slice 1 cannot prove it; preserve as a known limitation and regression sheet. Add a calibrated adapter before promoting this signal to a gate. |
| Saliency centroid points at texture | Treat current 1D saliency as ranking-only, never mandatory evidence. |
| Layout oscillates near a threshold | Debounce boundaries and apply hysteresis after hard safety. |
| Region path has a long sample gap | Mark uncertain; reject the portrait candidate or split the segment. |
| Safe-fit filtergraph fails | Existing encode fallback runs; no unbounded retry. |
| Artifact validator disagrees with plan | In the later phase, one all-safe-fit retry; persist delivered-plan truth and the failure reason. |
| VLM times out or disagrees | Deferred path falls back to deterministic safe-fit; VLM never overrides the hard gate. |
| Planner increases latency | Detection is reused; cap segment/candidate counts and disable via the master kill switch. |
| Old persisted plan is read | Existing versions remain supported; safety fields and safe-fit exist only on the new version. |

## 13. Principal risks

- **False confidence:** face-only containment does not solve gameplay/UI
  semantics. Slice 1 must be described and measured as face safety, not full
  semantic understanding.
- **Overuse of safe-fit:** quality is preserved but portrait fill may decrease.
  Shadow telemetry and corpus review must measure the rate before activation.
- **Detector identity churn:** lifecycle boundaries may over-segment and cause
  flicker. Debounce cannot merge across a real mandatory-region appearance or
  disappearance.
- **Plan/filtergraph compatibility:** a new layout variant touches exhaustive
  unions and persisted plan readers. Versioning and old-plan replay are release
  gates.
- **Cost growth:** richer detectors, artifact validation, and VLM calls can
  multiply render time. Each is an independent later phase with its own budget
  and kill switch.

