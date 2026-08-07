# Window placement: stop the crop edge cutting people in half

**Status:** design, approved to write 2026-08-06. No implementation yet.

**One sentence.** The crop window is centred on the faces it anchors and never asked what its edges do to the
faces it did not anchor, so a second person standing just outside the group is sliced vertically down the
middle.

---

## 1. The defect

The owner spotted it in a delivered clip: the host who is listening appears cut in half at the frame edge.

Clip `cmsi4gftv0005akgyb62kp2mb`, 1920x1080, first shot:

```
id0  x=614..864   w=250 (13.0%)  samples=12
id1  x=986..1217  w=231 (12.0%)  samples=7
bbox 614..1217, span 603     FIT_MARGIN allows 547     cropW = 608
```

Both faces clear the min-face guard. Their span is 603 pixels and the window is 608 wide, so **one window
holds both whole** - but `FIT_MARGIN = 0.9` reserves 10% for breathing room, the pair is rejected, and
`bestFaceGroup` picks the larger face alone. The window lands at x=434, covering 434..1042, and id1 at
986..1217 is left with only its left sliver inside. A person, bisected by the edge.

Nothing in the planner asks what the window does to a face it did not choose.

### 1.1 Scale

Re-planned over all clips of the real jobs from 2026-08-06, 53 clips:

| | |
|---|---|
| time on an anchored (`single`) crop | 1250s |
| **a detected face is bisected by the window edge** | **225s (18.0%)** |
| clips affected | **13 of 53 (25%)** |
| longest single span | 68.4s |

A face is counted as bisected when 15% to 85% of its width shows. Faces wider than the window itself are
excluded - they can never be whole, centring on them is correct, and §7c already handles them; that is 25s.

---

## 2. What this is not, and the measurement that killed each

Both alternatives below were designed, and one was verified to render, before being measured. They are
recorded so that nobody proposes them again from first principles.

### 2.1 No split with narrow tiles - measured at 0 seconds

Two people too far apart for one window is exactly what a stacked split is for. §7b says the tiles cannot be
made disjoint on 16:9 and that narrowing them "means cropping them vertically as well, which is a different
filtergraph and a different project". **That conclusion is wrong on the arithmetic and was verified wrong in
pixels.** An output tile is 1080x960, aspect 9:8; taking 960x853 from the source has the same aspect and two
of them fill 1920 exactly. Rendered: `crop=960:853` twice, scaled to 1080x960, stacked, giving 1080x1920 at
SAR 1:1, with the two tiles showing source regions centred near x=481 and x=1422 - genuinely different parts
of the frame, not the same one twice.

So it is buildable. It is also **not needed: 0 seconds of the 225 require it.** Every bisected span can be
resolved by moving one window. Building it would be a project with no measured benefit.

### 2.2 No anchor switching - contraindicated by the data that exists

Of the 225 seconds, 140 (62%) have a clean position that keeps the **largest** face whole. The other 84
(38%) have a clean position only if a *different*, smaller face becomes the anchor.

That 84 seconds is **two shots**, both crowded scenes:

| shot | faces | alternative anchor area / largest | least-bad slice if the largest is kept |
|---|---|---|---|
| "Когда экспертное «возможно»" @9.5s | 7 | 0.85 | 0.31 |
| "Что тело может сделать" @0.0s | 6 | **0.08** | 0.62 |

Switching is fine in the first and absurd in the second - an alternative face one twelfth the area means
abandoning the subject for a bystander in order to spare a third party. **A rule justified by one case and
contradicted by the other is a rule built on n=2**, which is the error this project has paid for repeatedly.
So the anchor is never switched. The two crowded shots get the least-bad slice instead.

---

## 3. The rule

> Among all window positions where the anchored group is entirely inside the window, choose the position at
> which the worst-cut face is least cut. Break ties toward the position the planner chooses today.

**Corrected during implementation.** The rule as first written had a hole in the objective, not in the code,
and it would have made the reported defect worse.

`bisectionSeverity` is zero both when a face is wholly inside and when it is wholly outside - that symmetry
is what removes the need for a threshold, and it is also blind to the difference between **framing** the
second person and **evicting** them. On the owner's own clip the two zero-severity bands are `[256, 378]`,
which pushes the listening host out of frame, and `[610, 614]`, which takes him in whole. Today's x is 436,
so the proximity tie-break picks eviction at 58px against 174px. **The rule would have removed the man the
owner complained was cut in half.**

The objective was missing an editorial preference: *showing a person is better than dropping them*. So the
rule is four stages, in order:

```
visible(face, x)  = overlap(face, [x, x+cropW]) / face.width        in [0, 1]
severity(face, x) = 1 - |2 * visible(face, x) - 1|                  in [0, 1]

1. if no face outside the group is cut at todaysX          -> return todaysX
2. else, among even x where every group member is whole,
   minimise   max severity over faces outside the group
3. break ties by  maximising total visible fraction        (show, do not evict)
4. break remaining ties by  |x - todaysX|
```

**Stage 1 is not an optimisation.** Without it, stage 3 applies everywhere and drags the window toward any
distant face it could frame whole. Measured on two existing fixtures: `keeps a speck invisible while a face
above the guard exists` moved 46 -> 102, chasing a 30px speck - which is §7a's defect returning through the
side door and which that test's own comment predicts - and `rejects a group that fills the window with no
margin` moved 302 -> 100, abandoning the central face it was deliberately anchored on.

The scope of this change is the 225 seconds where a face **is** bisected. A shot where nothing is cut is not
in that scope and has no business moving. Stage 1 states that; the earlier draft relied on the tie-break to
produce it as a side effect, and the fixture damage above is what a side effect is worth.

**Still no threshold.** Stage 1's test is `severity === 0`, which is `bisectionSeverity`'s own zero - the same
zero the design already rested on. Stage 3 is a term, not a cut-off. No constant is introduced anywhere.

**The candidate range is small and contiguous.** Every group member is whole exactly when
`x ∈ [max(groupRight) - cropW, min(groupLeft)]`, intersected with `[0, sourceWidth - cropW]`. On a 1920-wide
source that is at most 438 even positions. If the range is empty - the group is wider than the window - the
rule does not apply and today's clamp stands.

### 3.1 The limitation, stated because it is a limitation and not a detail

**"The largest face" is not "the speaker".** This rule optimises the composition around the largest detected
face, on the assumption that it is the principal subject of the shot. That is an assumption, not knowledge.

§7b measured why: `mouthActivity` is a 2 fps mean absolute difference of a normalised mouth patch that a head
turn, laughter or detector jitter produces as readily as speech, it has never been validated as speech
anywhere in this repository, and `dominance` agrees with its argmax in only 17 of 35 multi-face shots. §7c
therefore chose total face area deliberately and added a test pinning that the chosen window does not move
when `mouthActivity` moves. **That test stays, and this rule does not weaken it.**

For two people at a table the assumption is nearly always right - the larger face is the one nearer the
camera, and the shot is framed on them. For a scene with six people it is a guess, and that is precisely
where the residual of this change sits. Anchoring on the actual speaker needs a per-shot ground-truth
fixture first, which §7b says must be bought before that work starts.

---

## 4. Where the change lands

One file. `apps/worker/src/reframe/plan.ts`.

Today two places emit a `single` layout and each computes `x` its own way:

| line | branch | current expression |
|---|---|---|
| 551 | the whole anchorable set fits within `FIT_MARGIN` | `evenClamp((minX + maxX) / 2 - cropW / 2, ...)` over `anchorable` |
| 568 | no window holds everyone, `bestFaceGroup` picked a subset | `windowXFor(group, cropW, sourceWidth)` |

Both become one call to a new exported function:

```ts
export function placeWindow(
  group: FaceTrack[],      // must end up whole - the anchor
  others: FaceTrack[],     // every other surviving face the window could cut
  cropW: number,
  sourceWidth: number
): number
```

`windowXFor` becomes its tie-break input rather than its replacement: `placeWindow` computes `todaysX` by
calling it, so there is exactly one definition of "where the window goes when nothing is at stake".

**The two branches already agree, which is what makes one tie-break definition legitimate.** Line 551 takes
the midpoint over `anchorable` and `windowXFor` takes it over `group`; when the span fits inside
`FIT_MARGIN`, `selectGroupForShot` returns `anchorable` unchanged, so the two expressions evaluate to the
same number. Verified by reading both, not assumed - if it were not so, one branch would silently change
its `x` the moment it started routing through `windowXFor`.

**`others` must be the surviving tracks minus the group, not minus the anchorable set.** A face below the
min-face guard still reads as a person when the edge cuts it in half, and the guard's job is deciding what
may *anchor* the window, not what may be *sliced* by it. This is the same conflation §7e had to unpick when
`anchorable` turned out to answer three questions; the fix there was to separate them, and this keeps them
separate.

`buildCropPlan` already has the surviving tracks in scope at both call sites, so nothing new is threaded
through.

---

## 5. Acceptance

Settled 2026-08-06. Measured by re-planning the 53 real clips from their own captured detector runs.

**Must improve:**

- bisected time falls from **225s toward 84s**. The two crowded shots of §2.2 are expected to remain.
- the 140s resolvable bucket goes to **zero**, and every remaining span is **printed individually** with its
  clip, duration and face widths. "Near zero" is not an acceptance criterion; a remainder that turns out to
  be a detection artefact is a pass and a remainder the rule failed to reach is not, and only the listing
  separates them.
- a fall **below** 84s is not a cause for celebration. It means the rule found something the analysis did
  not predict, and it must be understood before the change is trusted.

**Must not change:**

- every shot where no face outside the group is cut at any position keeps its exact `x`. This holds **by
  construction** per §3 - the tie-break is today's expression - so the test confirms the construction rather
  than hoping for the outcome.
- `stream`, `center` and `split` layouts
- the nine layout assertions in `reframe-plan.test.ts` carrying `x` of 496, 656, 596, 386 and 96
- §7c's test that the window does not move when `mouthActivity` moves
- the persisted `cropPlan` records still compile identically

### 5.1 The silent regression, and how it is decided

The window will move on roughly 18% of anchored time: median 36px of 608, p90 92px, **maximum 140px**, which
is 23% of the window width.

There is a regression no measurement in this document can see. A shot where nobody was cut before and nobody
is cut after, but the subject has been pushed toward the edge to spare a face the viewer would never have
noticed. The bisection count improves and the framing gets worse.

**This is decided by looking, not by a number, and the order is fixed:**

1. **Implement the rule with no cap on the shift.** None. Not a soft one.
2. **Render before/after strips for the worst shifts** - the 140px maximum and several of the largest after
   it - plus the owner's clip and both crowded shots.
3. **Then, and only then**, decide whether a cap is needed and what it would be.

**A maximum-shift threshold must not be introduced now.** It would be a number chosen from nothing, and this
project has spent two sessions paying for exactly that: `MIN_RESTORED_SEC` tuned against a distribution with
a gap in it, and the min-face guard whose misapplication §7e had to unpick. If the strips show the problem,
the case that shows it also supplies the number. If they do not, no cap is needed and none is added.

---

## 6. Deferred

- **The webcam-inset detector fails on a real stream.** The Booster CS2 source resolves no `camRect`
  (`stream_no_rect`, faceFrac 3.1%), so the stream layout never fires. §7a's thresholds rest on one video;
  that source is now available as a second fixture.
- **The clip in-point.** Twelve viewer verdicts on real clips returned 0 POST, 5 FIX, 7 SKIP, and 8 of 12
  named the opening as the problem. Roughly half of that was framing and is now fixed. The other half is
  that the clip begins on setup rather than on the hook, which is ANALYZE and is the larger question.
