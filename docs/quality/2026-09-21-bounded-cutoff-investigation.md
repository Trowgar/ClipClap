# Bounded cutoff investigation — 2026-09-21

**Initial automatic-boundary decision: no automatic selection change is safe to ship.**
The tested boundary change was withdrawn after it regressed approved snapshots.
No deployment, commit, production write, attribution instrumentation, model
change, or paid LLM call was made. Ponytail kept the experiment in the existing
sentence graph and snap machinery; no parallel boundary policy was added.

Read-only production queries excluded synthetic users and accounts matching
ANALYTICS_OWN_ACCOUNTS by email/Telegram ID. The resulting set contains 47
feedback rows: 25 AS_IS, 7 CUTOFF, 8 FRAMING, 7 BORING. Verdicts and intervals
came from immutable feedback snapshots, not current clip ordering. Transcripts
were piped between local containers without printing their contents or account
identifiers. Current job transcripts are supporting evidence, not immutable
historical model inputs.

## Cutoff reproduction and rejected fix

The EDIT/CUTOFF snapshot at **296.1400–310.5600s** maps to graph nodes 61–63;
hook 62–63 and payoff 63. The last reliable segment ends at 310.5599975585938,
without terminal punctuation, and the next capitalized reliable segment starts
at that exact time. `buildSentenceGraph` closes every reliable segment at
strength 0.8; the next node inherits that strength, so `isCleanStart` and
`isCleanEnd` permit the seam. `snapNodes` reproduces the snapshot geometry.
This explains mechanical acceptance, not the semantically correct replacement.

Two neutral-word tests (zero gap and overlapping segments) first failed because
the seam was certified clean. A minimal candidate lowered that seam to 0.2 only
when no segment-final sentence mark existed and the next reliable segment
started at/before the previous word end. Both tests then passed; punctuation
and pause controls and all six directly related suites passed (327 tests).

Safety replay reconstructed node indices from snapshot start/end/hook/payoff
times (0.01s tolerance) and invoked `snapNodes` with default configuration.
22/25 AS_IS rows were replayable: two lacked retained job transcripts and one
had manually chosen boundaries without matching node geometry. Of those 22,
21 reproduced their approved interval before the candidate; one already
shortened under this limited replay. This is a deterministic snap comparison,
not an end-to-end rerun of the historical critic, configuration or finalizer.

The candidate changed **five** replayable approvals: four widened, and the
approved **232.7700–320.1100s** interval dropped with `no_clean_start`. The
reported cutoff also dropped with `no_clean_start`, rather than recovering a
verified ending. This fails the acceptance gate. Candidate code and provisional
tests were removed; the restored replay exactly matches the baseline. The
corrected s037 approval at 544.6100–571.8200s and h001 at 154–176s were included
and unchanged. No claim is made about the rejected s037 jump being approved.

Boundary callers share this graph: critic prompt markers, snap, start/end
extensions, compression and finalizer trims. Changing strength also changes
legal starts, explaining the approval loss. Existing end extension already has
scene/window/cap, opaque-end and clean-end guards. Retained CUTOFF job telemetry
reports zero extensions offered/applied and `no_window`; this means the offered
set was empty, not proof that no source continuation exists (hint eligibility
also controls that set). Do not enable unconditional extension on this evidence.

## Framing and boring limits

All eight FRAMING snapshots have `{layout:null, static:true, keyframes:0}`.
`digestCropPlan` in shared `clip-feedback.service.ts` reads top-level
layout/keyframes, while worker `CropPlan` stores `shots[].layout` and trajectories.
Current matching clip rows contain shot-based plans, including stream, single,
center and safe-fit layouts. The snapshot summary therefore cannot establish
static/center-crop causation. Correcting that shared evidence serializer is
outside this worker-only ownership. Current plans are not immutable frame truth.

Render routes through `computeCropPlan` and `buildFiltergraph`, falling back to
legacy center crop on detection/encode failure; two consecutive timeouts skip
later detection. Persisted render-step outputs inspected here lack the detailed
per-clip reframe checks. Evidence-copy keys exist, but clips/source frames were
not downloaded or visually reviewed in this bounded pass. No crop fix is claimed.

BORING scores range from 0.42 to 0.72 among scored snapshots; one is unscored.
Persisted job telemetry includes both strong and none selection tiers. Selection
uses score/short-question surcharges and NMS, then extension, finalizer,
publishability and recovery can affect delivery. A job-level tier is not the
provenance of an individual delivered clip. The evidence does not justify one
threshold, model or prompt change, nor treating recovery as the sole cause.

## Verification and next production checks

Final restored-worker verification: **363 tests passed in 9 files**, exit 0:

```sh
docker exec clipclap-sales-check-20260921 sh -lc 'cd /app && npx vitest run apps/worker/src/__tests__/sentence-graph.test.ts apps/worker/src/__tests__/snap.test.ts apps/worker/src/__tests__/end-extension.test.ts apps/worker/src/__tests__/start-extension.test.ts apps/worker/src/__tests__/finalize.test.ts apps/worker/src/__tests__/customer-feedback-metrics.test.ts apps/worker/src/__tests__/select.test.ts apps/worker/src/__tests__/render-reframe.test.ts apps/worker/src/__tests__/render-black-tail-trim.test.ts'
```

Expected mocked model failures were logged. Render suites additionally logged
`ffprobe ENOENT`; they verify orchestration/fallback handling, not real media.
`git diff --check -- apps/worker` passed and the worker diff is empty.

Before a future quality release: join feedback by clip/job identity and frozen
interval, inspect the immutable clip plus source continuation for the cutoff
and the five affected approvals, and establish the intended ending. Trace that
same candidate through persisted arc-audit/extension/finalizer/recovery records.
For framing, compare source frames with the evidence copy before changing the
planner. Replay approvals again, then render locally with FFmpeg/ffprobe and
check the actual audio/video ending. Fresh model evaluation would require paid
calls and must be reported before running. There is no quality patch to deploy
from this pass; do not report the sales release as fixing CUTOFF/FRAMING/BORING.

## Authorized follow-up: manual source repair

The subsequent implementation adds opt-in +2/+5-second ending extension and
full-frame (safe-fit) framing in the editor. It creates a separate edited clip;
the accepted original and automatic moment-selection behavior are untouched.
This is a repair tool, not a claim that automatic cutoff/boring selection is fixed.

Shared service checks ownership, finite times, existing clip bounds, explicit
extension options, a 150-second edit cap, source duration and R2 object presence
before creating a placeholder. The worker verifies actual media bounds with
ffprobe. Extension requires the original: no fallback to the already-short clip.
Existing caption edits are preserved; appended captions come from the source
transcript. Full-frame uses the existing safe-fit renderer and cannot silently
fall back to cropping if encoding fails. Normal extension recomputes its crop
over the new source interval with the existing local detector.

Queue failure removes only the new placeholder. Render failure marks only an
empty output unavailable (`deletedAt`); editor polling stops with an error and
the original remains playable. Successful retries clear that marker. Polling
also stops after five minutes of transport failures. No schema change needed.

Verification: 26 shared service tests, 10 API tests, 12 trim/fallback tests,
27 existing reframe tests, and two real FFmpeg fixtures passed. Both +2s and +5s
fixtures verify video/audio duration, source-bound refusal, visible burned tail
captions, full-width edge markers and updates limited to the new clip. Web
and worker typechecks passed (worker after regenerating Prisma in the disposable
container against the additive migration). Test executions after the production migration use
`DATABASE_URL=postgresql://test:test@127.0.0.1:1/test?connect_timeout=1` and
`SUBMISSION_QUEUE=off`; media fixtures run in a disposable
`clipclapio-worker-render` container with `--network none`, isolated apps/packages
mounts, and image-owned node_modules. No production jobs were submitted.

Production release owner should smoke-test both repair buttons and full-frame
mode on a retained source; confirm a new clip ID, unchanged parent, added audio
and captions, and an immediate API error for a missing source. Simulate a worker
failure only in isolation and confirm polling sees the unavailable placeholder.
Sources already removed by retention cannot be restored. Extensions do not
guarantee semantic closure; framing is user-selected. BORING remains unresolved.
The shared feedback crop digest correction is deferred from this bounded change.

## Final original-case availability check (read-only, 2026-09-21)

Worker typecheck was rerun successfully in `clipclapio-worker-render`, not the
web image: isolated apps/packages and current Prisma schema mounts, image-owned
node_modules, `--network none`, test DATABASE_URL and SUBMISSION_QUEUE=off;
`npx prisma generate && npx tsc -p apps/worker/tsconfig.typecheck.json --noEmit`
exited 0. No finalize edits were made for this check.

Production checks used owned clip/job joins and immutable feedback intervals,
excluding synthetic/own accounts as above. S3 HEAD confirmed all 15 immutable
evidence objects remain available. Four selected original-source objects are
available (normalized artifact preferred, otherwise source artifact); the other
11 cases have no retained source key, including one deleted job/clip. All 14
existing clip rows still match their snapshot intervals.

| Reason / snapshot interval(s), seconds | Retained source | Current editor eligibility |
|---|---|---|
| CUTOFF 57.91–75.06; 296.14–310.56; 418.80–435.54 | No key | Clips expired |
| CUTOFF 144.19–181.80 | No key | Job and clip deleted |
| CUTOFF 50.93–73.72; 6.55–23.06 | HEAD available | Clips expired; API refuses editing |
| CUTOFF 898.75–952.32 | HEAD available | Live; +2/+5 fit source duration and 150s cap |
| FRAMING 551.53–669.62; 859.97–879.02; 0–15.46; 94.01–123.86; 122–143; 125.11–142.92; 753.39–761.16 | No key | Clips expired |
| FRAMING 1799–1820.62 | HEAD available | Live; already has safe-fit in its current plan |

Thus the source is available for 3/7 CUTOFF and 1/8 FRAMING cases, but only
one case of each reason is currently editable. In particular, the reproduced
296.14–310.56s cutoff cannot be extended from its retained original today.
The live framing complaint already used safe-fit; offering safe-fit again does
not establish a correction of that complaint.

These are explicit availability, identity, expiry and range checks, not media
playback or successful historical-case re-renders. The FFmpeg verification used
synthetic media, not those customer originals. No production edit request/job
was submitted, and no historical clip was changed. The audit acceptance criterion
“automatic original-case fix, preserving approvals” remains **unmet**. Manual
repair is an additional user-controlled capability, not evidence that automatic
CUTOFF/FRAMING or BORING is solved. A later quality claim requires actual
before/after review on retained originals plus independent approval regression
checks; missing originals require re-upload or another authorized source copy.
