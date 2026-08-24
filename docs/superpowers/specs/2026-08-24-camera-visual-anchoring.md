# Camera visual anchoring: cut confirmation without faces + saliency anchor beyond music mode (2026-08-24, MEASUREMENT IN PROGRESS)

## Why now: first real-user feedback with a diagnosed camera defect

Per-clip feedback (live 2026-08-20) produced 4 EDIT verdicts; frame-level audit
of both external ones against the R2 evidence copies:

- **cops** (clip cmt5zd7oh, job cmt5z9nfr, "Escape 100 Cops" 0-32.3s, score
  0.91, user Upendra): ~6-7s of empty landscape - 20% of the clip in one block -
  exactly under the money line "Me and my four friends just escaped from 100
  real cops". Source frames prove the subject existed: runners in the right
  third, explosion left-of-center. The shipped cropPlan shows the mechanism:
  scdet merged >=3 real scenes into one shot [24.46-32.3], the only face anchor
  (leftmost runner in the final ground shot) pulled x=0, and that anchor was
  applied across the whole span. Cut recovery could not split it - it confirms
  candidates by face-track turnover, and the drone stretch has no faces.
  Secondary finds in the same clip: final shot decapitates the right runner
  (group wider than 9:16 - accepted physical limit), letterboxed wide shots
  (transient class - accepted per 2026-08-19 letterbox measurement), a
  suspected ~0.5s subtitle lead (UNPROVEN - fps-sampling gives +-0.75s per
  frame; deterministic measurement running).
- **dopamine** (clip cmt4udwck, job cmt4u5up8, Arabic talking head 591.8-644.1s,
  score 0.82, user Majd): camera clean - 1 shot, face anchor x=670, correct RTL
  subtitles in all 28 frames. Real defect: sliced graphic-card fragments at
  frame edges on sec 4-10 (the clip's two definition beats) - the known
  ACCEPTED graphic-insert anchoring limitation (2026-08-08; its three obvious
  fixes are measured dead ends, do not re-propose).

Owner directive 2026-08-24: "переходим на улучшение движка" -> "Делаем" on the
plan: (1) camera campaign, (2) subtitle-lead measurement in parallel.

## Campaign scope

**Mechanism A - cut confirmation by visual jump.** Cut recovery (LIVE since
2026-08-18, REFRAME_CUT_RECOVERY=on) confirms scdet 0.15-0.30 candidates by
face-track turnover only. Extend confirmation to faceless candidates via a
visual discontinuity check. Open design questions -> Measurement 2026-08-24:
does scdet even emit candidates at the cops tail cuts (~24.7, ~26.2, ~31.4 -
one of them behind a whip-pan), and at what scores? A candidate that scdet
never emits cannot be confirmed by any gate - that fork changes the mechanism.

**Mechanism B - saliency anchor for faceless shots outside music mode.**
plan.ts routes faceless shots to geometric centerX unless opts.musicMode
(centerXForShot + v1.1 per-shot saliency exists and is music-gated by
construction: "no saliency data in, no change in behaviour"). Extension must
respect the 2026-08-06 Camera Layer 0 verdict: on the podcast/talking-head
corpus, centre-crop faceless frames were 96.8% correct (defect 6 frames of
840) - so the anchor must be GATED (concentrated off-center energy only), not
unconditional, or it will churn geometry that is already right. Open design
question -> measurement: on the cops drone shot the scene is bimodal (explosion
left-center, runners right) - does the column-energy centroid land on a
subject or in the valley between them? A valley landing is a design-relevant
negative result (centroid alone insufficient; needs mode-picking or motion
weighting).

**Explicitly out of scope** (accepted limits, do not touch): group wider than
9:16; graphic-insert anchoring; transient letterbox; frozen geometry oracles
(two guards stay RED on purpose).

## Acceptance shape (to be finalized after measurement)

- OFF path byte-identical on the 53/56-clip director corpus (same bar as cut
  recovery 2026-08-18: OFF 53/53 byte-identical).
- ON: the cops window must split [24.46-32.3] at the true cuts and the drone
  sub-shot must render the subject (or at minimum the explosion), verified by
  an E2E re-render of the real source; zero regressions on the corpus eval;
  frozen oracles untouched.
- Each mechanism behind its own exact-literal env flag with a one-line
  rollback, mutation-tested guards.

## Measurement results

### Subtitle lead: REFUTED (2026-08-24, closed without code)

244 cues audited (cops frame-by-frame + 5 clips across fr/en/id/ar):
cue-vs-whisper delta is exactly 0.000s everywhere (word-level timings exist in
transcriptJson and match); frame-exact checks at 5 cue boundaries via accurate
-ss seeks: 5/5 render matches data. No lead/padding constant exists in the
chunker or ASS path (subtitles.ts:511-551 uses raw word timestamps; MIN_CUE_SEC
and W_FLASH are DP cost weights, not time shifts; formatAssTime floors to
centiseconds, <10ms). The analyze-side leadInSec (config.ts:382, snap.ts:90-97)
moves the clip boundary - audio and cues shift together, cannot desync. The
audit's "0.4-0.9s lead" was the fps=1/1.5 sampling artifact (+-0.75s/frame).
Also: the "silence gap 21.08-24.72" premise was a transcription gap, not an
audio gap - the clip has a continuous music/SFX bed (silencedetect at -40dB
finds nothing), so whisper-vs-audio is unmeasurable on this clip and no
contradiction was found. subtitleTrack cue times are clip-relative (0-based),
verified against the Arabic clip's 591.84 offset.

### scdet + saliency on the cops tail (2026-08-24) - the design pivot

Ground truth vs scdet (production-faithful scale=320 pass) on source 0-33s:
the shipped [24.46-32.3] merged shot hides THREE distinct failure modes.

1. **26.06s hard cut (close-up -> aerial), score 0.278** - candidate band,
   rejected by cut-recovery's `oneSideEmpty` (cut-recovery.ts:182-187): no
   YuNet faces on the aerial side. Exactly the documented accepted limitation
   of the 2026-08-17 spec ("a face the sidecar does not see cannot confirm a
   cut"), now hit by a real user. Mechanism A's target.
2. **31.53s hard cut (aerial -> final ground shot), score 0.493** - ABOVE the
   0.3 auto-split threshold, never reaches cut recovery at all: the tail
   segment [31.53, 32.3] is 0.77s < minShotSec 1.0 and cutsToShots
   (shots.ts:15-38) merges it backward. Undocumented third failure mode;
   needs its own rule (mechanism C).
3. 24.46s boundary lands at the START of a whip-pan (soft transition) - shot
   opens on blur mush; tolerable, out of scope.

**False-positive guard set for A, measured:** explosion-flicker candidates at
18.252 (0.274) and 19.686 (0.249) sit IN THE SAME score band as the true
26.059 (0.278) - score cannot separate them. Also: 5.706 (0.221, continuous
zoom, non-cut), 15.282 (0.371, camera shake - already auto-split today and
rescued by plan-level same-x merge). Any visual confirmation signal must pass
this set. A real cut in ~6-8.5s produces NO scdet signal >0.05 at all
(same-set/same-lighting) - unreachable by any confirmation gate, accepted.

**Saliency on the drone shot (26.1-31.3s): NEGATIVE result for mechanism B.**
v1.1 saliency_from_columns (reused verbatim): profile is near-FLAT, not
bimodal - aerial background texture dominates; centroid 949-1022px (frame
center is 960), spreadFrac 0.61-0.65, drifting +73px toward the runners over
the shot but never reaching them (crop window would graze their left edge by
~46px at best). Implication: with correct shot boundaries (A+C), the plain
centerX fallback already fixes the empty-trees symptom on this clip (crop
[656-1264] catches the explosion's right half + road, vs x=0 pure trees);
saliency would add +13..+62px - negligible here. Combined with the 2026-08-06
Camera Layer 0 verdict (faceless centre-crop 96.8% correct, 6/840 defect
frames on the talking-head corpus), an ACTIVE saliency anchor has no measured
case that justifies geometry churn.

Side finding, recorded: saliency is computed unconditionally by the sidecar
for EVERY run (detect_faces.py:449-501, 579-588) - only the TS planner is
music-gated (plan.ts:807-808). Also: unscaled scdet scores differ from the
production scale=320 pass (24.458: 0.290 vs 0.305) - always measure with the
production-faithful command.

## Design after measurement

**Mechanism A - visual confirmation of faceless cut candidates**
(REFRAME_VISUAL_CUTS=on, exact literal). In cut-recovery.ts, a candidate that
today dies as `oneSideEmpty` gets one more chance: extract 2 small grayscale
frames per side around the boundary (t-0.4, t-0.13, t+0.13, t+0.4; 320px,
ffmpeg, TS-side - the sidecar/tracker stay untouched, honoring the 2026-08-17
spec's structure), compute column gradient-energy profiles, and confirm only
when each side is internally STABLE while the across-boundary correlation
COLLAPSES (flicker/shake is unstable within-side; a zoom keeps across-corr
high; a true cut is stable-stable-collapsed). Thresholds frozen only after
calibration on the labeled set above + whatever corpus boundary labels are
reachable (the 2026-08-17 eval's two known faceless real cuts - crawling
girl, motion-blurred runner - are the positive controls if their sources are
still fetchable).

**Mechanism C - keep a hard-cut tail** (same flag or sibling, decided at
implementation): cutsToShots keeps a final segment shorter than minShotSec as
its own shot instead of merging backward, when the segment is >= 0.5s (below
that it is flicker and still merges). Mirror the head side only if the code
has the symmetric merge. The anti-flicker purpose of minShotSec is preserved:
this only stops the LAST shot from swallowing a scene change at the clip's
payoff - exactly the cops 31.53 case (final shot has faces; the anchor
x=0-from-wrong-scene defect disappears once the tail is its own shot).

**Mechanism B - saliency anchor: DEFERRED to shadow telemetry.** No geometry
change. For faceless (center-fallback) shots, plan.ts records what saliency
WOULD have done (centroid, spreadFrac, |centroid-centerX|) into a
saliencyShadow field on the shot in cropPlan (renderer ignores unknown keys -
guarded by test). Real traffic then shows whether a concentrated-off-center
faceless class exists; an active anchor returns as its own spec only with
that evidence.

### Mechanism A calibration, round 1: correlation discriminator REFUTED

The proposed signal (column-energy Pearson: within-side stability vs
across-boundary collapse, 4 frames at t+-0.4/0.13) does NOT separate on the
17-case labeled set: best grid-searched rule 14/17, knife-edge fit, no margin.
TRUE across-corr spans [-0.180, 0.644] vs FALSE+NEG [-0.135, 0.899] - near
total overlap. Killer counterexample: continuous ZOOM (5.706) has across
-0.135, as collapsed as a real cut - "zoom keeps across-corr high" is dead.
Variations also failed: row profiles (noisy), grayscale histograms (blind),
raw downscaled MAD (separates something-vs-nothing, not cut-vs-flicker).
Real cuts with high across (1.668 at 0.319, 9.810 at 0.644): a same-scale
similar-lighting cut leaves the sides correlated. Positive controls from the
2026-08-17 eval are unreachable - their source is swept from R2 (404).
Artifacts: .corpus/feedback-audit/boundary-discriminator.py + results.json +
_frame_cache/. Cost note: accurate-seek extraction ~1.2s per candidate.

Round 2 design (from round 1's one clean signal): a cut is a single-frame
DISCONTINUITY over a quiet local baseline; flicker/shake/zoom are continuous
change - high inter-frame delta everywhere in the neighborhood. Signal:
spike ratio = delta(boundary pair) / median(inter-frame deltas, ~+-1s at
sampled fps). Calibrating on the same 17 cases; if it fails, mechanism A is
recorded as a measured dead end and the campaign ships C (+ B shadow) only.

### Mechanism A calibration, round 2: spike ratio ALSO REFUTED - A is CLOSED

Best joint rule (spike_ratio AND boundary_delta floor): 16/17 on every
fps/scale combo, never 17/17. The one error is ALWAYS camera shake (15.282) -
structurally identical to a cut under this signal (a sharp shake against a
still shot IS "quiet baseline + one big frame jump"); its (baseline, delta)
sits inside the TRUE cluster in all combos. Second knife-edge riding along:
flicker 19.686's boundary_delta lands 0.001-0.0023 from whatever floor fits.
Thresholds are non-portable (ratio_thr 2.14 at 12fps/160 vs 3.55 at
native/160 - native fps inflates ratios 1.5-3x). The only robust half is
NEG-vs-TRUE (mid-shot quiet cases separate cleanly, max NEG 1.85 vs min TRUE
3.39) - i.e. the signal re-derives what scdet already knows. Honest caveats
recorded: the labeled set is one video (n=17); the shake exemplar is
auto-split today (0.371) so it is a robustness proxy for shake-on-faceless
rather than a literal member of A's oneSideEmpty population; a false-positive
cost asymmetry exists (faceless-both-sides false splits are healed downstream
by mergeAdjacentLayouts' same-x merge; mixed face/no-face false splits are
visible regressions - and 26.06-class true cuts live in that same mixed
class, so the populations do not separate). Artifacts:
.corpus/feedback-audit/spike-ratio-discriminator.py + results/analysis JSON +
_frame_cache_v2/. Runtime ~0.5-0.65s per candidate (single window decode).

**VERDICT: mechanism A does not ship.** Two independent signals (correlation
structure, temporal spike ratio) measured dead on the labeled set. The
campaign ships C + B-shadow. A returns only with a multi-video labeled
boundary corpus AND a signal that beats shake and flicker with real margin -
do not re-propose either measured signal without new evidence.

**Do-not-fix list carried over** (2026-08-17 spec, still binding): no
CANDIDATE_FLOOR lowering (92% of the 0.15-0.30 band are non-cuts); no touching
tracker/buildCropPlan/mergeAdjacentLayouts/layout rules; merge-blindness and
speaker-aware anchoring stay separate specs.
