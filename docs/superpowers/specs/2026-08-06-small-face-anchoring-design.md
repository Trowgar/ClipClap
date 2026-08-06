# Small-face anchoring: the guard exists for webcams, so let it apply to webcams

**Status:** design, approved to write 2026-08-06. No implementation yet.

**One sentence.** A 6%-of-frame-width minimum-face guard, built to stop the planner anchoring on a
streamer's webcam inset, is applied to every source - so on a wide two-shot the planner refuses both real
people and frames the table between them instead.

---

## 1. The defect, measured on real delivered clips

The owner spotted it in a delivered clip and it reproduces exactly.

Clip `cmshgvc1b000n14451jj5wy7i`, 23 seconds, from a forensic-expert interview. Its first shot:

```
shot 0 [0.0-4.4]  2 tracks, 0 anchorable
    id0 w=101px (5.2% of frame width) cx=435  samples=9   under guard
    id1 w=106px (5.5% of frame width) cx=1481 samples=9   under guard
    -> centres 1046px apart; a 608px window cannot hold both
guard = 115px (0.06 x 1920)
```

Two men at opposite ends of a long table, both clearly visible, both detected in 9 of the shot's samples.
Neither clears the guard, so `anchorable` is empty and the planner centres blind at x=656 - the empty table
between them. **The first 4.4 seconds of a 23-second clip are furniture.** Every later shot in the same clip
has a single face at 12.5-18.5% and frames perfectly.

### 1.1 How much of the product this is

Re-running the detector over all 47 clips of the five real jobs rendered on 2026-08-06 (1679 seconds of
delivered clip time, of which 803 seconds sit on a blind centre crop):

| bucket | seconds | share of centre time |
|---|---|---|
| no face detected at all - **centring is correct** | 504 | 62.8% |
| **real people present, every face under the guard** | **298** | **37.2%** |

**298 seconds is 17.7% of all delivered clip time**, framed on nothing while people are visible in the
source. The widest face in these shots measures 4.2%, 4.7%, 5.1%, 5.5%, 5.8% - all just short of 6%.

Replaying those shots through the existing `bestFaceGroup`, **the window would move by more than 40px on 292
of the 298 seconds** and stay put on 6. So the fix is not merely permitted by the data, it actually fires.

### 1.2 Why three earlier measurements missed it

Recorded because the pattern is the expensive one in this project.

- Engine notes §8d concluded "the opening frame is not broken". It measured luma, caption presence and the
  pause before the first word. **It never measured whether a face was in the opening frame.**
- §7d concluded framing was fine from a corpus of seven 90-second fixtures cut at arbitrary offsets. Those
  offsets landed on close-ups. **The corpus contained no wide two-shot**, which is the exact case that fails.
- §7d then attributed 82% of faceless delivered frames to the centre layout and, on checking whether a face
  existed in the source, found 96.8% of them correct - on that same unrepresentative corpus.

The corpus was the error, not the method. Clips chosen by ANALYZE land on different material than fixtures
cut at a round number of minutes.

---

## 2. What this is, and what it is not

**Is:** a change to when the minimum-face guard applies. One condition, no new constant.

**Is not:**

- not a lowering of the guard - 6% stays 6%
- not a change to source classification, or to when the stream layout fires
- not a change to `bestFaceGroup`, `windowXFor`, `trySplit`, `survivingTracks` or the merge pass
- not a fix for the webcam-inset detector failing on a real stream (section 6)
- not motion - `REFRAME_MOTION` stays off and is untouched

---

## 3. The rule

Today, in `buildCropPlan`:

```ts
const anchorable = tracks.filter((t) => t.box.w >= minFaceWidth);
if (anchorable.length === 0) return { layout: "center", x: centerX };
```

The guard exists for exactly one case, and §7a states it: on a stream the webcam is a small inset over
gameplay, and centring a 9:16 window on it yields a truncated webcam plus a slice of chat overlay. That case
is real and measured. What is not justified is applying the same rule to a source that has no webcam at all.

**Proposed:**

> The minimum-face guard applies to a face **iff** a webcam rectangle was resolved for the clip **and that
> face lies inside it**. Otherwise the face may anchor the window.

Everything downstream is unchanged: the faces that survive the guard go into the same `FIT_MARGIN` test, the
same `trySplit`, the same `bestFaceGroup`, and the same `windowXFor`.

### 3.1 Why `camRect` and not a smaller threshold

Face size cannot separate the two cases. Measured on the corpus:

| item | camRect | small faces | spread across frame |
|---|---|---|---|
| `stream-cam` (real CS2 + webcam) | **13 of 13 shots** | 23, **all inside the rect** | 0.12 |
| `vlog-arctic` | none | 11 | 0.53 |
| `sitcom-multi` | none | 8 | 0.61 |
| `podcast-2p` | none | 6 | 0.57 |

A webcam inset and three people fifty metres away present the same face size. Sweeping the guard downward
confirms one threshold cannot serve both - at 0.04 the stream layout stops firing and the planner anchors on
the streamer's own webcam face, which is the defect §7a exists to prevent:

| item | 0.06 (ships) | 0.05 | 0.04 | 0.03 |
|---|---|---|---|---|
| `stream-cam` | 60s **stream** | 60s stream | **stream lost** | 60s anchor |
| `vlog-arctic` | 45s blind | 45s blind | 40s blind | 26s blind |
| `sitcom-multi` | 8s blind | 0s | 0s | 0s |

`camRect` is already computed by the detector on every shot and is currently read only to decide the stream
layout. This rule adds no signal and no constant.

### 3.2 Source classification is deliberately left alone

`buildCropPlan` uses the same `minFaceWidth` for a second, unrelated job: deciding whether the source is
`normal_face` or `small_face`, which is what gates the stream layout. **That use is unchanged and keeps the
absolute guard.**

The two questions are different - "is this source a stream" and "may this face anchor the window" - and
merging them would break §7a. The implementation must keep them textually separate so a later reader cannot
collapse them by accident.

### 3.3 No new size floor, on purpose

Without the guard, in principle a detector artefact could anchor the window. Two existing mechanisms already
address it: `survivingTracks` drops any track with fewer than 2 samples or under 30% of the dominant track's
sample count, and `bestFaceGroup` selects by total face area, so a larger face always beats a smaller one.
The risk is confined to shots where every face is tiny - which is precisely the case this change exists to
serve.

**So no floor is added.** If the acceptance run puts a window on a detector artefact anywhere in the corpus,
a floor gets added then, justified by that case and measured against it. Inventing a threshold before the
case that needs it has cost this project twice: `MIN_RESTORED_SEC` was tuned against a distribution with a
gap in it, and the min-face guard itself is the subject of this document.

---

## 4. Where the change lands

| file | change |
|---|---|
| `apps/worker/src/reframe/plan.ts` | one predicate: replace the flat `box.w >= minFaceWidth` filter with the conditional rule. `selectGroupForShot` and `buildCropPlan` must both use it, since they already share the selection. |

That is the whole surface. `camRect` is already threaded into `buildCropPlan` as `cam: CamRectResolution | null`.

**A detail that must not be missed.** `plan.ts:205` already has `faceInInset(tracks, rect)`, carrying the
2px tolerance and the reason for it - both the rect and the track box are medians, so exact containment is
luck. But it returns the FIRST face inside the rect, and this rule needs a per-face predicate.

So extract the predicate - `isInsideInset(track, rect)` - and have `faceInInset` call it. Do not write a
second containment test: a copy would drift from the original's tolerance, and the tolerance is the part
that was reasoned about.

---

## 5. Acceptance

Everything below runs on the seven corpus fixtures in `apps/worker/.corpus/` plus a replay over the 47 real
clips. Baselines already exist from the Layer 0 work and `corpus-baseline.ts` regenerates them.

**Must improve:**

- blind-centre time with real people visible: **298s -> near zero**, measured by the same replay that
  produced the 298
- the window must actually move: the >40px displacement predicted on 292 of those 298 seconds

**Must not change, byte for byte:**

- `stream-cam` keeps its stream layout on all 60 seconds
- `vlog-travel` and every shot in the "no face at all" bucket stay centred
- `lockedoff-1p` is unchanged
- every shot that already had an anchorable face keeps its existing `x` - the guard's behaviour above 6% is
  untouched, and the nine layout assertions in `reframe-plan.test.ts` carrying `x` of 496, 656, 596, 386 and
  96 are the regression guard
- the 131 persisted `cropPlan` records still compile identically (`eval-camera-invariance.ts` level 1)

**Must be looked at, not just counted.** Before/after frame strips for the clip in section 1 and for at
least three others from bucket C. The number says the window moved; only the picture says it moved onto a
person. §7c's sheets are the precedent.

**A specific thing to check rather than assume:** on shots with several small faces spread wider than one
window - the arctic case, three figures across 53% of frame width - `bestFaceGroup` will pick a subset by
total area. Confirm by eye that the subset it picks is a person and not, say, the largest of three equally
distant strangers while the speaker is elsewhere. If that reads badly, it is an argument about
`bestFaceGroup`, not about this rule, and belongs in its own change.

---

## 6. Deferred, and why

**The webcam-inset detector failed on a real stream.** Clip `c20` from the Booster CS2 source carries
`profile: { class: "small_face", reason: "stream_no_rect", faceFrac: 0.031 }`. No rectangle was resolved, so
the stream layout never fired and the clip is 11 seconds of centre crop on a frozen match-pause screen. A
viewer's verdict was "dead screen - nothing is happening, nobody is on screen".

This is a defect in `find_cam_rect`, not in the anchoring rule, and §7a is explicit that its thresholds rest
on one video and one OBS layout. It needs its own investigation with the Booster source as the second
fixture. **It is deliberately not bundled here**, because a change that both moves the guard and retunes the
inset detector could not be attributed if the result got worse.

Note the interaction, though: with `stream_no_rect` there is no `camRect`, so under this rule the streamer's
3.1% webcam face becomes anchorable. That is the §7a defect arriving through the new door. Section 5's
byte-identity requirement on `stream-cam` catches the case where a rect IS found; the Booster clip is the
case where one is not, and it must be inspected by eye in the acceptance run.

**The clip's in-point.** Twelve viewer verdicts on real clips returned 0 POST, 5 FIX, 7 SKIP, and 8 of 12
named the opening as the problem - "opens on furniture", "blank start", "faceless", "dead screen". Roughly
half of that is this defect. The other half is that the clip begins on setup rather than on the hook, which
is ANALYZE, not RENDER, and is the larger question. Recorded so it is not lost.

---

## 7. Open questions

1. **Whether anchoring on three distant figures is actually better than centring.** The rule will fire on
   `vlog-arctic`; the measurement says the window moves, and only the frame strips will say whether it moves
   somewhere worth looking. If it reads worse, the honest outcome is to scope the rule to shots with one or
   two faces and record why.
2. **Whether `stream_no_rect` sources need the guard back.** If the Booster clip anchors on the webcam and
   looks wrong, the fallback is to keep the guard when the source classified as `small_face` even without a
   rect - which is information the planner already has. Not designed now, because the acceptance run decides
   whether it is needed.
