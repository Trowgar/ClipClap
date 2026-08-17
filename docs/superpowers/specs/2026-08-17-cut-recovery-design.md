# Cut recovery: confirming the camera cuts scdet under-scores (design)

2026-08-17. Motivated by the frame-level audit of the RENDER director on the first outside-user
corpus (56 clips, 11 jobs, 8 users; recorded in memory as the director audit and in
`apps/worker/.corpus/director-audit/`). This document is a DESIGN and a set of implementation
task specs for executor agents. It follows the rules of `docs/engine-notes.md` §7: reframe
decisions are checked against pixels, not against argument; every number below is a measurement
or is marked believed; the mechanism is pure, the policy is a flag, and flag-off is today's
output byte for byte.

---

## 0. The defect, measured

The director (`apps/worker/src/reframe/`) picks one 9:16 window per SHOT. Shots come from ffmpeg
`scdet` at threshold **0.3** (`shots.ts`, `REFRAME_SCENE_THRESHOLD`), with one retry at half
threshold only when a window of 15s+ finds ZERO cuts. When scdet under-scores a real camera cut,
one detector shot spans two or three source framings, and the median face box that anchors the
window is a compromise between angles that never coexist. §7 of engine-notes calls this the
"empty middle" and lists it as open item #2 ("merge-blindness and the missed cuts").

What the corpus showed (all numbers from `plans.jsonl`, `scenes/*.txt`, `replan_0.2.json` in
the audit directory; frames verified by eye on the source sheets):

- Scene-change candidates scoring **0.15-0.30** that are NOT a plan boundary: **212**, in 37 of
  53 planned clips. Two of them are the Alipov podcast cuts at 18.27s (0.292) and 20.71s
  (0.298) inside clip `527.85` - a dark same-studio set where every cut sits in the 0.3-0.4
  band and these two fell under it.
- Re-planning all 53 clips at threshold **0.2** (same detector run, `computeCropPlan` reproduces
  the persisted production plans exactly at 0.3 - the planner is deterministic) moves the window
  by more than 0.25 cropW on **49.5s of 2009s (2.5%), 12 of 53 clips**. Concentrated, not
  spread: the La Brea "Veronica" clip (`cmsven6bv`, 1186.4s, one of the strongest content
  clips) has **~9 of 21.5s** broken in production - half a face at the window edge, then 6.5s
  of the back of a head while Lily's confession plays in close-up; the Alipov clip has 2.4s of a
  cup and a microphone with the speaker out of frame.
- Of the 212 candidates, only **17 (8%)** lie inside a span where 0.2 actually moved the window;
  **195 (92%)** changed nothing (same person, sub-shots merged back). On the ar-habits job
  (graphics, zooms) it is 1 of 76 - and that one is a **false cut**: a 0.5s sub-shot anchored on
  a lamp. Threshold 0.2 also produced 5s of WORSE framing in a dark cave scene of the "Isaiah"
  clip (`cmsvenwtu`, 1831.6s, span 5-9.5s).
- Score distributions do NOT separate "should lower" from "should not": the film job (real
  misses) and the ar-habits job (false cuts) have the same shape (mean .29 vs .24, stdev .22 vs
  .21, both dominated by sub-0.15 motion). Only the dark podcast is separable (no sample under
  .15). An adaptive threshold has no statistic to stand on.
- The face sidecar (`assets/reframe/detect_faces.py`) samples the clip at 2 fps, associates
  detections into tracks per detector shot by greedy IoU >= 0.3 against each track's LAST box,
  with no timeout; it emits every track's per-sample boxes as `path` (source pixels, sorted by
  t). So a missed cut is visible in the tracks: the tracks live before the cut have no samples
  after it and vice versa. §7f measured this independently: in the six largest anchor shifts,
  "the anchor track and the outsider it moved for are never on screen at the same time".
  `path` is discarded right after `buildCropPlan` today (`render.ts`); it is available in
  memory at exactly the moment this design needs it.

Conclusion the design rests on: **a global threshold turn is not the fix** (it trades one
defect for another), and **the pixel signal plus the face signal together are**: scdet nominates
a few candidates per clip, the tracks confirm the ones where the people on screen actually
changed.

## 1. Goal and non-goals

**Goal.** Split a detector shot at a scdet candidate in the 0.15-0.30 band when the set of faces
on screen changes across it, so each side gets its own window. Judged on the 53-clip corpus by
seconds and by frames: the verified cases are fixed, nothing gets worse.

**Non-goals, each deliberately.**
- Cuts scoring **below 0.15**: not nominated, so not recovered. If the eval shows a residue
  there, a track-only splitter (design candidate B in the brainstorm) is a SEPARATE spec.
- **Merge-blindness** (`mergeAdjacentLayouts` keeps the FIRST shot's x when it merges neighbours;
  20.5s measured on the earlier corpus): different mechanism, same symptom, separate spec.
- **Speaker-aware anchoring** and **letterbox/pillarbox cropping**: the other two audit findings,
  separate specs.
- Changing the sidecar, its tracker, `buildCropPlan`, `mergeAdjacentLayouts`, or any layout rule.

## 2. Design

### 2a. One scdet pass, with scores (`shots.ts`)

`scdetPass` runs ONCE at `min(CANDIDATE_FLOOR, cfg.sceneThreshold)` where `CANDIDATE_FLOOR =
0.15` (the existing `RETRY_THRESHOLD_FLOOR`), with `metadata=print` instead of `showinfo`, and
returns `Array<{t, score}>` (clip-relative seconds, `lavfi.scene_score`). The scene score is
computed per frame independently of the select threshold, so:

- **cuts** = `{t : score >= cfg.sceneThreshold}` - the same set the 0.3 pass produced;
- the **zero-cut retry** (window >= 15s and no cut at 0.3) becomes a filter over the same array:
  cuts = `{t : score >= max(RETRY_THRESHOLD_FLOOR, cfg.sceneThreshold / 2)}` - the same set the
  second ffmpeg run produced, without the run;
- **candidates** = `{t, score : CANDIDATE_FLOOR <= score < cfg.sceneThreshold}` minus anything
  the retry promoted to a cut.

`detectShots` returns `{ shots: Shot[], candidates: CutCandidate[] }`; `shots` is
`cutsToShots(cuts, duration, minShotSec)` exactly as today. A selected frame whose line carries
a timestamp but no `lavfi.scene_score` fails the whole pass (`scdet_failed`, today's failure
class): without the score the frame cannot be classified as cut or candidate, and a wrong cut
list is worse than the legacy fallback. `select` with a `scene` expression always sets the
score, so this is a guard, not an expected path - the OFF invariant on the corpus confirms it
never fires there.

Byte-identity claim, to be PROVEN by the eval (§3): for every corpus clip, `shots` from the
single pass equals `shots` from today's code.

### 2b. `cut-recovery.ts` - the mechanism, a pure function

```
recoverCuts(
  shots: Shot[],
  tracksByShot: ShotTracks[],
  candidates: CutCandidate[],
  cfg: { minShotSec, sampleFps, maxPlanShots }
): { shots: Shot[]; tracksByShot: ShotTracks[]; telemetry: CutRecoveryTelemetry }
```

For each detector shot, take its candidates in time order. A candidate at `t` is **confirmed**
when all three hold:

1. **Track turnover.** Let `w = 2 / sampleFps` (two samples, 1.0s at 2 fps). `before` = ids of
   tracks with at least one `path` sample in `[t - w, t)`, `after` = ids with a sample in
   `[t, t + w)`, both restricted to tracks that clear `survivingTracks` (the existing noise
   floor). Confirmed only if `before` and `after` are **disjoint** (Jaccard = 0). This is
   computed on LIVE samples, not on track start/end, because the tracker can revive a stale
   track after a gap (greedy IoU against the last box, no timeout). A continuing track - the
   same person through a zoom, a gesture, a graphic transition - is not a turnover, which is
   what rejects the ar-habits candidates.
2. **Both sides populated.** `before` and `after` each non-empty. Face-to-b-roll and
   b-roll-to-face are not confirmed: the whole-shot median already sits on the face there and a
   split fixes nothing.
3. **Duration floor.** Each resulting sub-shot is at least `minShotSec` (1.0s); a shorter
   segment is not created - the candidate is dropped, exactly as `cutsToShots` drops a cut that
   would make a short segment (this is what kills the 0.5s lamp shot). Confirmations stop when
   `shots.length + confirmed` would exceed `MAX_PLAN_SHOTS` (90, exported from `plan.ts`); the
   remainder is counted as `capHit`. The cap is on the PRE-merge count, deliberately:
   `buildCropPlan` returns `null` above 90 merged shots (`plan.ts:747`), which is a whole-clip
   fallback to the legacy centre crop - a recovery that could trip it would turn a 2s defect
   into a 60s one. Pre-merge count is an upper bound of the merged count, so the guard is safe.

Confirmed candidates split the shot into sub-shots `[start, t1), [t1, t2), ... [tk, end)`. Each
sub-shot's `ShotTracks` is derived from the parent's tracks by `path`: for every parent track,
the samples with `t` in the sub-range; if at least one, a track with the same `id`, `box` =
per-coordinate median of those samples, `samples` = their count, `score` and `mouthActivity`
copied from the parent, `path` = those samples; `camRect` copied from the parent. `shotIndex` is
renumbered so `buildCropPlan`'s `byIndex` map is consistent. A parent track with no `path`
(older sidecar builds) makes the whole shot ineligible - counted as `noPath`, never guessed.

The function never merges, never moves an existing boundary, never touches shots without
candidates, and returns the input arrays untouched (same references) when nothing is confirmed.

Telemetry: `{ candidates, confirmed, rejected: { noTurnover, oneSideEmpty, tooShort, noPath },
capHit }`, all counts of candidates.

### 2c. Policy in `index.ts` (`computeCropPlan`) and the flag

```
const detected = await detectShots(...);
let shots = detected.shots, tracks = await detectFaces(..., shots, ...);
if (cfg.cutRecovery) {
  const r = recoverCuts(shots, tracks, detected.candidates, {...});
  shots = r.shots; tracks = r.tracksByShot; check.cutRecovery = r.telemetry;
}
const plan = buildCropPlan(shots, tracks, ...);   // unchanged
```

`cfg.cutRecovery` = `REFRAME_CUT_RECOVERY === "on"`, default **off** (env-blind harness: the
default equals today). `shotCount` reported in `ReframeResult` stays the DETECTOR count; the
recovered count is visible as `plan.shots.length` and in the telemetry.
`ReframeCheck` gains `cutRecovery?: CutRecoveryTelemetry` and rides into
`renderManifest.reframe.checks[]` beside `layouts`/`profile`.

`mergeAdjacentLayouts` stays as the safety net: a confirmed split whose sub-shots pick nearly the
same window (|Δx| < 4% iw) merges back, so the plan carries no split that does not change the
picture. (Because the merge keeps the first sub-shot's x, a merged-back split can move x by up
to 4% iw = 77px on 1920 versus today's whole-shot median. That is below the 0.25 cropW diff bar
and is counted, not hidden, by the eval.)

### 2d. Invariants

- Flag off: `plan` byte-identical to today's for every corpus clip (proven, §3).
- Recovery only ADDS boundaries inside a detector shot at scdet-nominated instants; it never
  removes, moves, or invents one elsewhere.
- Mechanism (`cut-recovery.ts`, `shots.ts` parsing) is pure and unit-tested; policy (flag,
  wiring, telemetry) lives in `index.ts`.
- The sidecar, `buildCropPlan`, layouts, filtergraph, and the persisted `CropPlan` schema are
  untouched (`version` stays 1; shots only differ in count).

## 3. Measurement plan and acceptance

**Corpus.** The 53 planned clips of the director audit: sources still in R2 for all 11 jobs
(verified 2026-08-17 despite `sourceSweptAt`), persisted plans in `plans.jsonl`. Task 0 commits
a manifest (`apps/worker/assets/reframe/director-audit.json`: job id, clip id, R2 keys, clip
range, source dims) and a fetch script so the corpus can be re-materialised into
`apps/worker/.corpus/director-audit/` (gitignored) from the manifest - the same pattern as
`corpus-fetch.ts` for the reframe fixtures.

**Script.** `apps/worker/src/scripts/eval-cut-recovery.ts` (read-only to DB and R2; runs in the
`worker-render` container). For each clip: plan with the flag OFF and with it ON from ONE
detector run; print per clip and in total:
- OFF invariant: `shots` equal to the persisted production plan (byte for byte on
  `{start,end,layout,x}`), and equal to the pre-change `detectShots` output for the same range;
- ON vs OFF: seconds where the window differs by more than 0.25 cropW (the audit's bar); shot
  count before/after; `candidates / confirmed / rejected` by reason; `capHit`;
- a contact sheet per diff span: source frames with both windows drawn (red = OFF, green = ON),
  written under `.corpus/director-audit/eval-cut-recovery/`, so every change is judged by eye.
Runtime is bounded by the detector (~10s per clip); one run over 53 clips is ~10 minutes.

**Acceptance (the owner's bar: zero regressions, verified cases fixed).**
1. OFF invariant holds 53/53.
2. Confirmed diffs include Alipov `cmsrxcgk6` (527.85s) at 18.3-20.7 and La Brea Veronica
   `cmsven6bv` (1186.4s) in the spans around 4-5 / 7.5-12 / 15-21.5, and on the sheets the
   green window holds the face the red one lost.
3. Every diff span on the sheets is an improvement or neutral; the two known 0.2 regressions do
   NOT reproduce: ar-habits `cmsvoe13k` (0.0s) at 12.0 (lamp) and Isaiah `cmsvenwtu`
   (1831.6s) at 5-9.5 (cave).
4. Shot-count growth is reported and explained per job (a number from the run, not chosen in
   advance); no clip hits the 90 cap.
5. Recall spot-check: 30 REJECTED candidates sampled across jobs, looked at by eye; expected 0
   real camera cuts with a framing change (the 0.2 replan says at most 17 of 212 candidates
   move the window at all).

Any failure of 1-3 is a design finding, not a tuning target: the knobs (`w`, Jaccard bound,
`CANDIDATE_FLOOR`) are changed only with the corpus number that motivates it, recorded in the
engine-notes section.

**Rollout.** Flag off in code. After acceptance: `REFRAME_CUT_RECOVERY=on` in the live `.env`,
`docker compose up -d worker-render` (recreate - `restart` does not re-read `env_file`), then
`prisma generate` in the recreated container; read `cutRecovery` in `renderManifest` on the
first real jobs. Rollback = remove the line and recreate.

## 4. Edge cases

- **Score parse failure**: `scdet_failed` as today (§2a) - the pass fails whole rather than
  guessing which selected frames were cuts.
- **Zero-cut retry**: a filter over the same array; candidates it promotes to cuts are not
  candidates any more.
- **Faceless / graphics / anime**: no surviving tracks - `oneSideEmpty` on every candidate -
  plan identical.
- **Stream layout**: sub-shots inherit the parent's `camRect`; `resolveCamRect` sees the same
  rects repeated, its majority vote is unchanged in outcome.
- **Split layout**: unaffected (its gate is source aspect).
- **Revived tracks**: handled by testing LIVE samples around `t`, not id lifetimes.
- **Timeouts**: recovery is pure TS on in-memory arrays (microseconds); the detector budget is
  untouched. Fewer ffmpeg runs than today when the retry used to fire.
- **`MAX_PLAN_SHOTS`**: confirmations stop at the cap (`capHit`), earliest-first.

## 5. Tests

vitest, run inside `worker-render` (`/app/node_modules/.bin/vitest`); every expectation is
mutation-tested by neutering the mechanism and watching the test go red (a test whose expected
value equals the tie-break default measures nothing - see the arc-audit programme's record).

- `shots.ts`: parses `{t, score}` pairs from `metadata=print` output; cut set at 0.3 equals the
  legacy parse on a recorded ffmpeg stderr fixture; retry filter reproduces the second-pass set;
  a line without a score is skipped.
- `cut-recovery.ts`: disjoint live sets → split, sub-shot medians differ from the parent median
  and from each other (the split MUST change x, or the test is green for nothing); one continuing
  track → no split; one side empty → no split; sub-shot under `minShotSec` → not created;
  missing `path` → `noPath`, input returned by reference; two candidates in one shot → three
  sub-shots with renumbered `shotIndex`; cap reached → `capHit`.
- `index.ts`: flag off → `recoverCuts` not called and the plan equals the pre-change plan on a
  recorded `ShotTracks` fixture; flag on → telemetry present in `ReframeCheck`.
- Eval script: exercised on the corpus (Task 4), not unit-tested beyond argument parsing.

## 6. Tasks

Each task is one commit with tests green in `worker-render`; executor agents implement, the
architect reviews the diff and runs the eval. Live prod is not touched until Task 5.

- **Task 0 - corpus manifest + fetch.** Commit `apps/worker/assets/reframe/director-audit.json`
  (53 planned clips: job, clip, R2 keys for source and rendered clip, start/end, source dims,
  persisted `cropPlan.shots`) and `apps/worker/src/scripts/director-audit-fetch.ts` that
  materialises `.corpus/director-audit/{sources,clips}` from R2. Read-only to R2.
- **Task 1 - single-pass scdet with scores.** `shots.ts`: `scdetPass` → `{t,score}[]`,
  `detectShots` → `{shots, candidates}`, retry as a filter; tests in §5. `computeCropPlan`
  consumes `.shots` and ignores candidates for now. Byte-identity of `shots` shown on the corpus
  by the Task 4 script's OFF invariant (Task 4 may land its OFF half early for this).
- **Task 2 - `cut-recovery.ts`.** The pure function of §2b with its tests, mutation-tested.
- **Task 3 - wiring, flag, telemetry.** `config.ts` `cutRecovery`, `index.ts` policy,
  `telemetry.ts` `CutRecoveryTelemetry` on `ReframeCheck`, `render.ts` pass-through into
  `renderManifest`. Off by default.
- **Task 4 - `eval-cut-recovery.ts` + the run.** Script per §3, one full run over 53 clips,
  sheets for every diff span, acceptance table 1-5 filled in. The architect judges the sheets;
  the owner spot-checks the named cases.
- **Task 5 - record and ship.** engine-notes §7i (numbers from Task 4, including any knob change
  and why), memory update, then the prod rollout of §3.

## 7. Knobs and open questions

- `CANDIDATE_FLOOR = 0.15` - equal to the existing retry floor; lowering it widens the
  candidate pool the eval must reject (92% rejected already at 0.15).
- `w = 2 samples` around `t` - one sample is fragile to a single dropped detection, three
  reaches into neighbouring shots on fast-cut material; two is the starting point, the eval
  reports how many confirmations flip at 1 and 3.
- Jaccard bound `0` (disjoint) - the strict start; a persistent bystander face across a real cut
  would block confirmation. The eval counts `noTurnover` rejections whose two sides share
  exactly one track, so the cost of strictness is a number before it is a decision.
- Whether the merged-back split's x shift (< 4% iw) is worth eliminating (recompute the merged
  window from the union of tracks) belongs to the merge-blindness spec, not this one.
