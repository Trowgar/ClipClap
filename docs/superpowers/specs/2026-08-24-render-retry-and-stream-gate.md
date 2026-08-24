# Render-retry idempotency + stream-layout false-positive gate (2026-08-24, BOTH SHIPPED)

SHIPPED same day: fix 1 commit 4b0fb99 (no flag, live on next render);
fix 2 commit 47d4354, REFRAME_STREAM_COVERAGE_GATE=on in .env, worker-render
recreated 2026-08-24 ~22:54 UTC. Acceptance for the gate ran on real data
via the autopsy harness: majd118 stream->normal_face (zero stream shots),
amine12 stream->small_face, Ke4ts (true stream) byte-identical, flag off
byte-identical; demotions stamped in cropPlan.profile
(reason=stream_coverage_gated + gatedCoverage). The retry fix hardening:
cleanup where-clause also excludes telegramFileId-carrying rows, so the
narrow stall-race cannot soft-delete delivered clips.

Two defects from the 49-clip survey of real traffic 2026-08-19..23, owner
approved "давай делаем" 2026-08-24.

## 1. Render retry is not idempotent -> duplicate delivery (BUG, proven)

Job cmt6ag9q8 (Majd): RENDER attempt 1 died silently after creating 4 of 7
clip rows (worker process killed mid-loop - timing matches our own tsx
hot-reload restarts during the 21:0x-21:3x deploy window; no failJobStep, no
error). BullMQ stall recovery redelivered after the 30-min render lock
(queues.ts attempts=2; worker-app.ts lockDuration 30min, stalledInterval 60s,
maxStalledCount 1). Attempt 2 re-created ALL 7 highlights (render.ts has
exactly one clips call - clip.create per highlight, no cleanup/reuse),
clipsGenerated overwritten to 7 (real rows: 11). FINALIZE never queries
clips; delivery selects by jobId WHERE deletedAt IS NULL with no dedup ->
all 11 sent, the user received 4 highlights twice.

**Fix (no env flag - strictly corrective):** at the start of the FULL-JOB
render path (before the highlight loop), soft-delete leftovers of any prior
attempt: `clip.updateMany({where: {jobId, deletedAt: null}, data:
{deletedAt: now}})`. Delivery already filters deletedAt - the orphans become
invisible everywhere. The renderTrim/single-clip re-render path must NOT be
touched by this cleanup. Prior-attempt rows can never carry telegramFileId
(delivery only runs after FINALIZE, which only runs after RENDER completes),
so nothing delivered is ever soft-deleted. Delivery-side dedup by highlight
identity considered and skipped (YAGNI - render-side cleanup closes the only
producer of duplicates); recorded here in case a second producer ever shows.
Mocked-prisma trap applies: tests must assert the exact updateMany query
shape and be mutation-tested.

Acceptance: unit tests (cleanup fires on full render start with the exact
where-shape; renderTrim path untouched; second render attempt yields exactly
N live rows for N highlights); full worker suite green; mutation tests
(remove cleanup -> red; widen where to include deletedAt set -> red; move
cleanup into trim path -> red).

## 2. Stream-layout false positives on non-stream sources (MEASUREMENT FIRST)

4 real clips across 3 users misclassified as stream (webcam-inset) content:
- majd118 (Arabic selfie-vlog): same man rendered in BOTH tiles (cam and
  content rects overlap in-source), poster frame = two tiles of blank wall.
  User verdict NO/FRAMING - the survey's only NO.
- amine12 (2D cartoon): a DRAWN TV read as screen content; cam tile
  decapitates the woman, content tile is motionless furniture, layout
  flip-flops single/stacked twice inside one continuous scene.
- upendra-stream + the dup'd majd shot: mild cases, blurry upscaled cam tile,
  duplicate sliver at content-tile edge.
Common mechanism: an in-scene rectangle promoted to inset; the cam and
content crops overlap or duplicate the same subject. The v2 corpus (7/7)
never caught this - its controls are real streams/games, not vlogs,
cartoons, cinematic footage. These 4 clips are the new false-positive corpus.
Virtual cam itself is validated (Ke4ts real stream: rect holds the face 45s,
clean seams) - the defect is CLASSIFICATION, not the stream render.

### Measurement (2026-08-24): the FPs never detected a cam rect at all

Autopsy via the REAL pipeline (detectRange/planDetected on the fetched
sources; artifacts .corpus/feedback-audit/stream-fp/): all 3 FPs have
camRect=null on every shot - they are D4 VIRTUAL-CAM SYNTHESIS
(camRectScore 0, virtualCam true), the rect fabricated from a short-lived
junk face track (2-3 samples) that landed under the 0.15 faceFrac ceiling.
The discriminator is stream-shot COVERAGE of the plan:
  FPs: majd118 5.7%, upendra-stream 11.9%, amine12 20.5%
  TPs: strogo 97.5%; Ke4ts/tox/Rtt/tw-recrent 100%
77pp gap, zero overlap. Ruled out with evidence: camRectScore floor (tox, a
valid TP, is also 0); cam-vs-content IoU (structurally ALWAYS 0 - freeBand
picks the strip outside camRect by construction); face-straddles-both-tiles
(real only for majd118); anchor-shot-duration-frac (would flag strogo, a
real stream, at 12.9%).

**Gate (decided):** TS-side post-check, no python mirror needed. After
buildCropPlan, if profile.virtualCam is true AND streamShotFrac < 
STREAM_SHOT_COVERAGE_MIN = 0.75, re-plan the clip with stream:false (pure
re-planning over the same detection - no sidecar re-run). Plans whose cam
rect was genuinely DETECTED (virtualCam false) bypass the gate entirely -
the measured failure mechanism is synthesis-from-junk-face, so the gate
targets only that. Behind env flag REFRAME_STREAM_COVERAGE_GATE (exact
literal "on"). 0.75 is a single-corpus provisional constant (margin: 55pp to
the nearest TP, 55pp to the nearest FP). Honest known edge: a real stream
whose cam exists for only part of the clip and needed virtual synthesis
would be demoted to plain crop - no such case observed yet; recorded.
Acceptance: flag OFF byte-identical; ON: 7/7 v2 corpus plans unchanged (all
TPs are >= 97.5% coverage), all 3 FP clips re-plan with zero stream shots,
verified through the autopsy harness.

## Backlog recorded, not started: luma-aware tile rebalance when the content
tile is dark >3s (Ke4ts blackout case); sliced full-width title cards;
718x1280 portrait crop crash; Laksh goodwill re-run.
