# Core V3: Visual Recall and Causal Quality Controls

## Problem

ClipClap's recall-critic engine is transcript-first. The scanner, critic, arc audit,
and finalizer receive sentence nodes but no source-video evidence. Visual events can
therefore be absent from the candidate pool, while emotionally loud but visually weak
speech can win. A 47-minute gaming source demonstrated this: the shipped clip was a
coherent render but a weak moment, while several fights existed elsewhere in the video.

The seven-day feedback sample is small but materially poor: 25 ratings from 15 real
users, with roughly half `NO` and 8 of 18 rated jobs receiving only `NO`. Feedback is
not a direct label for a single defect. In the 2026-09-02 five-`NO` job, independent
review found three acceptable clips, one edit, and one clear reject. Core changes must
therefore use causal media evidence and protect known positives instead of treating
every `NO` as an automatic negative training label.

Production was still running the August 25 analyzer when these incidents occurred;
the later quality-gate and rescue branches did not cause them.

## Goals

1. Recover visually strong moments that weak or sparse speech does not nominate.
2. Preserve the existing semantic critic, evidence gate, snap, arc, and finalizer as
   authorities for meaning and boundaries.
3. Add deterministic, inspectable telemetry for every visual nomination.
4. Make the feature a true no-op when disabled and observation-only in shadow mode.
5. Protect every confirmed `AS_IS` example in the retained evaluation corpus.
6. Keep extra model cost at zero in V1 and bound additional media work to the existing
   one-frame-per-second video pass.

## Non-goals

- No Dota-specific OCR, HUD parser, or game taxonomy.
- No vision-LLM call in V1.
- No feedback-driven automatic production promotion.
- No post-render retry loop or billing behavior change.
- No change to Rescue V2; rescue only handles otherwise empty output.
- No automatic rejection of advertising or promotional speech based on one user's `NO`.

## Architecture

### 1. Video envelopes at TRANSCRIBE

Replace the luma-only one-frame-per-second ffmpeg metadata pass with one pass that
extracts both `lavfi.signalstats.YAVG` and `lavfi.signalstats.YDIF`. `YAVG` remains the
existing luma envelope. `YDIF` becomes `motionEnvelope`, a per-second mean pixel-change
signal. Both degrade independently to `[]`; failure must never fail transcription.

The TRANSCRIBE JobStep persists `motionEnvelope` beside `energyEnvelope` and
`lumaEnvelope`. Old jobs and malformed arrays remain valid and behave as no-signal.

### 2. Pure visual peak nomination

A new `analyze-v2/visual-candidates.ts` module receives sentence nodes and the motion
envelope. It performs only deterministic math:

- calculate median and median absolute deviation;
- require a peak to clear both a robust relative threshold and the 75th percentile;
- keep local maxima inside a short neighborhood;
- cluster nearby maxima and retain the strongest representative;
- enforce a global candidate cap and temporal-region diversity;
- map each retained peak to the nearest transcript nodes in a bounded window;
- skip a peak when no reliable speech node exists close enough to ground a clip.

Visual candidates are ordinary `ScanCandidate` values with type `visual_action`. They
do not bypass the critic, evidence gate, snap, arc audit, finalizer, missing-range gate,
or clip-count limits.

### 3. Three rollout modes

`ANALYZE_VISUAL_RECALL_V1` has exactly three values:

- `off`: do not read the envelope and do not add visual telemetry;
- `shadow`: compute and report peaks/candidates but do not alter scanner input;
- `on`: union visual nominations with scanner nominations before `mergeCandidates`.

Unknown values resolve to `off`. Shadow and off must produce byte-identical highlight
sets for the same replayed model responses.

### 4. Selection and scoring

V1 changes recall, not final scores. The critic still decides semantic quality and
keeps its original score. This avoids inventing a universal rule that high motion is
always good; screen recordings, sports, games, and talking heads have different motion
baselines. The existing merge, regional quota, critic budget, and NMS bound how much
visual recall can displace semantic candidates.

`LONG_CLIPS=off` is the immediate production mitigation. The retained positive sample
contains no `AS_IS` clip over 90 seconds, while the longest negative is 118 seconds.
Long-clip exceptions stay disabled until a larger positive corpus justifies them.

Single-axis arc penalties remain unchanged in V1. Existing corpus evidence shows that
one arc flag does not separate positives from negatives reliably. Visual recall must
not be bundled with an uncalibrated arc-policy change.

## Configuration

- `ANALYZE_VISUAL_RECALL_V1=off|shadow|on`, default `off`.
- `VISUAL_RECALL_MAX_CANDIDATES`, default `15`.
- `VISUAL_RECALL_CLUSTER_SEC`, default `12`.
- `VISUAL_RECALL_PRE_SEC`, default `18`.
- `VISUAL_RECALL_POST_SEC`, default `18`.
- `VISUAL_RECALL_MAX_NODE_DISTANCE_SEC`, default `20`.

All numeric values are positive, bounded config values. They are tuning doors, not
per-job overrides.

## Telemetry

When mode is `shadow` or `on`, ANALYZE telemetry includes `visualRecall`:

- mode and envelope length;
- robust threshold inputs and resolved threshold;
- raw peak count, clustered peak count, mapped candidate count;
- nominated candidate ranges, peak second, peak value, and source (`motion`);
- union count and number surviving merge/critic selection.

No raw frames, source keys, transcript text, or user identifiers are added.

## Failure behavior

- Missing/malformed motion envelope: normal transcript-only result with explicit
  `no_motion_envelope` telemetry in shadow/on mode.
- ffmpeg envelope failure: TRANSCRIBE succeeds and persists `[]`.
- No nearby speech for a peak: nomination is skipped; the transcript pipeline proceeds.
- Visual candidates all rejected: existing content outcome, never a technical failure.
- Scanner outage: existing technical-failure semantics remain unchanged; visual recall
  does not mask an unavailable scanner.

## Verification and release gate

Unit tests must prove parsing, robust peak selection, clustering, node mapping, caps,
off/shadow invariance, on-mode union, malformed-data degradation, and telemetry.

Real-data replay must include:

1. The paid gaming incident: at least two of the human-selected fight windows must be
   nominated within 20 seconds; the previously shipped weak window must not receive a
   stronger visual nomination than both.
2. The 2026-09-02 five-clip job: acceptable high-action regions remain reachable; the
   feature must not increase output beyond the existing cap.
3. Every retained confirmed `AS_IS` case: no currently shipped positive may disappear.
4. Existing deterministic eval snapshots: `off` and `shadow` preserve shipped output.

Release order is `off` in the image, then `shadow` against retained sources, then `on`
for all users only after the gates above pass. Rollback is one environment change back
to `shadow` or `off`; no database rollback is required.

## Final measured results (2026-09-02)

The retained replay corpus covered 5 source videos and 7 labelled positive windows:

- positive recall: 7/7 (gaming 2/2, incident 2/2, confirmed `AS_IS` 3/3);
- weak-negative hits: 0;
- candidate counts by anonymous corpus case: 13, 15, 3, 2, and 4; cap 15 respected;
- pure nomination latency: 12–27 ms;
- full worker suite: 121 files, 2543 tests, passing in the Node 20 Docker environment;
- worker build: passed;
- production image build: passed in approximately 85 seconds.

Limitation: 6 older confirmed `AS_IS` cases no longer had their original source
artifacts and were excluded from this replay. The measurements therefore do not claim
protection for those six cases.
