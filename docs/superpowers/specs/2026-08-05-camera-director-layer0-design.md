# Camera Director Layer 0: a crop window that can move inside a shot

**Status:** design, approved to write 2026-08-05. No implementation yet.

**One sentence.** The planner physically cannot express camera movement inside a shot, because
`FaceTrack.box` is a median and `ShotLayout.single.x` is a single number; Layer 0 removes that limitation
for an already-chosen face group and changes nothing else.

This is not "add AI". It is the removal of one data-model constraint.

---

## 1. What this is, and what it is not

**Is:** a time-resolved crop window for the face group the current planner already selects.

**Is not**, by explicit decision recorded in section 3:

- not active-speaker detection, audio-visual or otherwise
- not a change to *which* faces the window follows
- not saliency or motion anchoring for faceless material
- not vertical framing (the crop is full-height by construction, so `x` is the only axis)
- not a lift of the 90-shot plan cap

Each of those is a later layer with its own spec and its own fixture requirement.

---

## 2. The defect, measured

### 2.1 Mechanism

`detect_faces.py` detects faces per sampled frame and associates them into per-shot tracks, then collapses
each track to a **median box** before emitting it. The per-frame boxes exist and are discarded. `buildCropPlan`
therefore has one box per track per shot, produces one `x` per shot, and `filtergraph.ts` compiles a
piecewise-**constant** expression. There is no representation in which the camera could move.

### 2.2 Exposure

From the 96 stored `Clip.cropPlan` records. Note that §7c's merge pass made this **larger**, exactly as it
documented it would ("more adjacent shots merge now"):

| | all 96 clips | post-7c cohort (20 clips) |
|---|---|---|
| clips rendered under ONE window end to end | 19 of 96 | **4 of 20** |
| clip time under a window held >= 10s | 41.4% | **47.8%** |
| clip time under a window held >= 20s | 22.9% | **33.2%** |
| longest single static window | 72.8s | 52.2s |

### 2.3 The defect itself, on delivered frames

YuNet run over the **rendered 1080x1920 output** of the 20 post-7c clips, sampled at 2 fps, 1186 frames. This
needs no source video, which is what made it available at all (see 2.4).

- **6.1%** of delivered frames contain no face
- **5.4%** have a face cut by the frame edge
- faceless runs: 32 of them, p50 0.8s, p90 2.0s, **max 5.0s**
- worst clip: **27.5%** of its frames faceless
- **inside a static window held >= 10s: 9.2% faceless. Everywhere else: 3.2%.**

### 2.4 How far that last comparison may be pushed

**A long static window is a strong predictor of bad delivered framing: a face is absent 2.9x more often
inside one.** That is the whole claim.

It is explicitly **not** a causal result. Static windows are not randomly assigned - a wide shot, a cutaway,
a back of a head or a scene transition can produce both the long hold and the missing face. The comparison
controls at corpus level only. The causal claim requires the paired legacy-vs-motion comparison in 6.3, on
the same source over the same interval.

Two further limits, stated because they are easy to forget: the 20 clips are **10 distinct clips from one
source**, and "no face detected" is not the same as "framing failure" - which is why 6.3 introduces a
narrower primary metric.

### 2.5 There is no corpus at all

**All 21 jobs have `sourceKey = null`.** Every source video has been swept, including the sitcom that §7b and
§7c rest on - swept on 2026-08-05, after those measurements ran. The CS2 VOD went on 08-03. So the 12-clip
replay that reproduced all shipped plans byte for byte **cannot be re-run**, and `eval-reframe.ts` has nothing
to point at.

This is the reason section 6 begins with building a corpus rather than with a test.

---

## 3. Scope decisions

Four decisions taken during design, with the reasoning that produced them.

### 3.1 Active-speaker detection is a later layer, not this one

The defect is not "the wrong person is framed"; it is "the window cannot move". Perfect speaker detection
would not help a window that is constitutionally static. §7b also measured that `mouthActivity` is a 2 fps
mean-absolute-difference of normalised mouth patches which **has never been validated as speech** - head
turns, laughter, gesture and detector jitter all produce it - and that `dominance` agrees with its argmax in
17 of 35 multi-face shots. §7c added a test pinning that the chosen window does **not** move when
`mouthActivity` moves. **That test stays.**

### 3.2 The corpus is a URL manifest, materialised on demand

Committed manifest of public URLs plus time ranges; a script fetches excerpts into a local fixtures directory
that is outside R2 and outside the job system, so the retention sweep cannot reach it. Nothing large enters
git. yt-dlp already works through the WARP proxy.

### 3.3 Camera motion is deadzone plus eased follow, speed-limited

Stillness is the default state and motion is the exception. A hard snap was rejected because the background
does not change across a crop jump, so it reads as a decode error rather than an edit - and because §7c's
merge pass exists specifically to keep the camera still across soft cuts. Continuous following was rejected
because it turns 2 fps detector jitter into visible drift and gives a locked-off studio camera a movement it
never had.

### 3.4 Faceless material is untouched

Faceless shots keep today's static centre crop. §7 calls a saliency or motion crop the highest-value next
step for RENDER, and it remains so - but every threshold it needs would rest on videos that do not exist yet,
which is precisely how the stream work ended up with numbers resting on one video. Gameplay, sports,
screencasts and animation get no better this round. **They also get no worse, and section 6 asserts that
byte-for-byte.**

---

## 4. Architecture

Seven touchpoints, one new file, nothing removed.

### 4.1 Data model

**`detect_faces.py`** emits each track's per-sample boxes alongside the existing median:

```json
{ "id": 0, "box": {...}, "score": 0.93, "samples": 41, "mouthActivity": 0.049,
  "path": [ { "t": 0.0, "x": 512, "y": 180, "w": 96, "h": 120 }, ... ] }
```

`box` is unchanged and stays the median. `path` is additive and optional, parsed as strictly as `camRect` is
today, and its absence is not a contract violation - an older sidecar must not break a newer worker.

**`types.ts`:**

```ts
export interface FaceTrack {
  id: number;
  box: { x: number; y: number; w: number; h: number }; // median, unchanged
  score: number;
  samples: number;
  mouthActivity: number;
  path?: Array<{ t: number; x: number; y: number; w: number; h: number }>;
}

export interface Keyframe { t: number; x: number }   // clip-relative seconds, source pixels

// the single-layout variant only:
{ start: number; end: number; layout: "single";
  x: number;         // LEGACY median x - unchanged, byte-identical to v2
  xs?: Keyframe[] }  // new trajectory, additive
```

`CropPlan.version` becomes `3`. `center`, `split` and `stream` variants are untouched.

**`x` remains the legacy median and never becomes the trajectory's first value.** If it did, a consumer that
ignores `xs` would silently render a different crop and "flag off equals today" would be unfalsifiable. This
also matters for the 96 `cropPlan` records already persisted, which must keep rendering identically.

### 4.2 The motion controller - `apps/worker/src/reframe/camera.ts` (new)

Pure function. Input: a target position per sample, `cropW`, source width, config. Output: `Keyframe[]`.

Behaviour: hold while the target sits inside a deadzone around the current window centre; when it leaves,
ease toward it under a hard pixels-per-second cap; stop once it is comfortably back inside. The speed cap is
what prevents 2 fps detector noise becoming visible pan.

**The controller decides how to move. It never decides whom to follow.**

### 4.3 Anchor selection is frozen

`bestFaceGroup` runs **exactly once per shot, on the median boxes, exactly as today**. The controller receives
the trajectory of that already-selected group and nothing else. No per-sample re-selection, no hysteresis on
group membership.

This is a deliberate constraint against confounding: if selection could also change, a measured result could
not be attributed to fixing the median box rather than to changing which person is followed.

**Corollary that must be implemented, not assumed.** When a member track has no detection in some sample, its
**last known box is carried forward** rather than dropped from the group bounding box. Recomputing the
midpoint from fewer members would move the target without any selection change - the same confound through
the back door.

### 4.4 Filtergraph

`filtergraph.ts` gains `rampX(keyframes)`, emitting a flat sum of clipped ramps:

```
x(t) = x0 + sum_i  slope_i * clip((t - t_i) / dt_i, 0, 1)
```

Nesting depth 1 regardless of keyframe count, which is what makes it viable (5.1). Selection:

```
REFRAME_MOTION=off       -> read x    (legacy encode, unchanged)
REFRAME_MOTION=on + xs   -> read xs
no xs / degenerate xs    -> read x
```

### 4.5 Fallbacks

| condition | behaviour |
|---|---|
| no face in the shot | centre crop, static. Today's behaviour exactly. |
| face lost mid-shot | hold last position; past a timeout, ease to the shot median |
| several people talking | unchanged - total face area picks the group, this layer does not claim to know who speaks |
| subject is not a person | out of scope; centre crop. The anchor interface is where saliency plugs in later. |
| fewer than 2 samples in the path | emit `x` only, no `xs` |
| keyframe count over cap | **emit `x` only.** Never truncate a trajectory - a truncated ramp parks the camera somewhere no rule chose. |
| global | `REFRAME_MOTION` off by default, the `REFRAME_STREAM` pattern |

---

## 5. Measured constraints

Everything in this section was measured on 2026-08-05 in the `worker-render` container, not reasoned about.

### 5.1 Expression form and its ceiling

- **Nested `if()`, what ships today: 98 terms parse, 99 fails.** This is the origin of the 90-shot plan cap.
  Engine notes §7 records the same wall as "99 parses, 100 does not"; the two differ only in whether the
  final `else` branch is counted as a term. Same limit, different counting - not a contradiction to resolve.
- **A flat sum has nesting depth 1 and is not subject to that limit at all.**
- **The real wall is `argv`, not ffmpeg: 125,781 characters pass, 132,181 raises `OSError: Argument list too
  long`.** That is the kernel's `MAX_ARG_STRLEN` of 131,072, and it applies because the pipeline passes the
  filtergraph as one command-line argument. An earlier probe "succeeding" at 5000 terms was a parse test on a
  short expression and did not touch this.

### 5.2 Encode cost against expression size

20s of 1280x720 cropped to 406x720, scaled to 1080x1920, libx264 veryfast:

| ramp terms | expression chars | encode | vs static |
|---|---|---|---|
| 0 | 3 | 5.0s | 1.00x |
| 10 | 291 | 5.2s | 1.04x |
| 40 | 1,181 | 5.4s | 1.09x |
| 100 | 2,981 | 5.5s | 1.10x |
| 200 | 5,981 | 5.3s | 1.07x |
| 3000 | 93,781 | 5.8s | 1.16x |

A deadzone camera emits one ramp per **movement**, not per sample, so 10 to 40 is the expected count. The cap
is therefore set at **200 keyframes**: about 6 KB, 4.5% of the argv wall, and at most 1.10x encode.

### 5.3 The motion actually happens

Verified numerically against a static luma gradient, reading the whole `x(t)` series rather than seeking
(input-seeking a lavfi source resets the filter clock and reports `t = 0` forever - a trap hit during this
probe). A single ramp and an equivalent 400-term sum both produced: hold at 0, linear 0 to 400 between t=1
and t=2, hold at 400.

### 5.4 Legacy renders are deterministic

Two identical encodes of the same input produced **the same full-file md5**, with no `-bitexact` flags, and
matching decoded `streamhash` values for video and audio. So a full-file hash is usable as the strongest
invariant in 6.2.

**Contingent, and section 6.1 re-checks it:** this was a synthetic source, 5 seconds, without the ASS
subtitle burn. If two baseline renders of a real corpus item ever differ, the invariant demotes to decoded
`streamhash` plus a byte comparison of filtergraph and encode args, and the full-file hash becomes secondary.

---

## 6. Measurement plan

### 6.0 Step 0, before any code

1. Materialise the corpus (6.1).
2. Render every item **twice** with today's engine. Two purposes: it produces the paired baseline, and it
   verifies 5.4 on real material with the subtitle burn.
3. Capture the detector's JSON output per item and commit it. Small, and it makes planner invariance testable
   without re-running YuNet.

Skipping step 0 makes checks 1 and 2 both unfalsifiable afterwards.

### 6.1 Corpus

Eight items, 60 to 120 seconds, chosen for what they exercise rather than for genre:

| item | what it tests |
|---|---|
| 2-person podcast, people who shift and lean | the core case |
| multi-camera sitcom | our only real user material |
| single talking head, locked-off camera | **must not move** - the false-positive control |
| vlog: talking head, then street, then phone screen | mixed material at shot level |
| stream with facecam | stream-layout regression |
| gameplay | byte-identical regression guard |
| sports | byte-identical regression guard |
| screencast and animation | byte-identical regression guards |

The last four need no quality judgement at all, which is what makes them affordable without a labelled
fixture. Layer 0 must not touch faceless shots, and that is cheap to assert.

### 6.2 Check 1 - legacy invariance

Three levels, strongest last:

1. `buildFiltergraph` over **all 96 stored `cropPlan` records** with the flag off, byte-identical to today's
   output. Free, needs no video, available before the corpus exists, and it guards the persisted plans.
2. `buildCropPlan` over the committed detector JSON, byte-identical v2 plans.
3. Full render of every corpus item with the flag off, output hash equal to the step-0 baseline, under the
   hash policy 5.4 establishes.

### 6.3 Check 2 - paired comparison, on anchor-eligible frames

Same source, same intervals, legacy against motion.

**Primary metric - anchor-eligible framing failure.** Using the detector JSON, restrict to frames where the
detector saw **the selected face group in the source** at that time. Among those, count frames where the face
is absent from the delivered vertical crop, or cut by its edge:

```
the face was in the source and was the chosen anchor
-> but it is missing or clipped in the final crop
-> the crop plan was wrong
```

This is close to a direct measurement of framing failure, and it excludes the cases that make the raw
faceless rate ambiguous: genuine cutaways, faces not visible in the source, backs of heads, scene
transitions. Overall faceless rate and edge-cut rate remain as **secondary health metrics**.

**Pass bar.** Deliberately not phrased as reaching parity with the outside-hold rate: the remainder may be
caused by real material rather than by the planner, and promising a number the material controls is how a
threshold acquires false authority.

- paired anchor-eligible failure rate inside legacy long-hold intervals **falls**, and falls on a **majority
  of clips** with a negative paired median delta - direction and consistency, since no supportable magnitude
  exists yet
- longest continuous anchor-eligible failure gap **does not grow** on any clip
- **no clip regresses by more than 2 percentage points** on the primary metric
- the locked-off talking-head control **gains no movement and loses no face**

The magnitude bar is deliberately left open until the first corpus render has been looked at. Setting one now
would invent a number the material, not the planner, largely controls.

Reported per clip as a paired delta and as a sign test across clips, not as an aggregate mean alone.

### 6.4 Check 3 - motion safety

Computed from the plan, no render required, so it runs on every corpus item cheaply: peak `|dx/dt|`, share of
shot time in motion, movement onsets per minute, direction reversals per minute, and "returns" - the camera
leaving a position and coming back within a few seconds, which is the hunting failure mode.

### 6.5 Check 4 - runtime safety

Keyframe count per clip against the 200 cap; expression length against the 131,072 wall; render duration delta
against the step-0 baseline; and zero ffmpeg failures, where any expression error is a hard fail.
`renderMs` already exists per job, so the cost delta stays visible in production after rollout.

---

## 7. Hard invariants versus provisional alerts

**Hard invariants.** Each gets a test; a violation blocks the merge.

- `REFRAME_MOTION=off` uses legacy `x`, and the encode is byte-identical to the baseline
- peak `|dx/dt|` never exceeds the configured speed cap
- `keyframeCount <= 200`, otherwise legacy `x` fallback
- filtergraph argv length stays below the measured safe ceiling
- faceless shots remain a static centre crop, byte-identical
- `split`, `stream` and `center` layouts are byte-identical
- planner and render never fail on any corpus item
- the chosen window does not move when `mouthActivity` moves (§7c's test, retained)

**Provisional review alerts.** Guardrails with no corpus support yet. They open a conversation; they do not
fail a build. They are replaced by measured values after the first corpus render is looked at.

- share of shot time in motion above 25%
- direction reversals above 4 per minute

Naming these as acceptance criteria would manufacture exactly the kind of reasonable-looking, unsupported
threshold this project has had to walk back twice.

---

## 8. Later layers

In the order their prerequisites become available:

1. **Faceless anchoring** - saliency or motion crop for gameplay, sports, screencasts, animation. Needs the
   corpus items this spec already fetches, plus judgement on them.
2. **Active-speaker selection** - needs a per-shot "who is speaking" ground-truth fixture before
   `mouthActivity` or any replacement may be trusted. §7b is explicit that this must be bought first.
3. **Per-sample group selection** - needs a multi-person fixture.
4. **The 90-shot cap** - the flat-sum form lifts it as a side effect; left alone here to keep this increment
   to one behavioural change.

---

## 9. Open questions

1. **Deadzone width and speed cap have no measured values yet.** They are configuration from day one, and
   their first values will be set by looking at the corpus render. Stated here so the numbers that appear in
   the plan are recognised as provisional.
2. **The timeout for "face lost mid-shot"** is likewise unmeasured. The behaviour is specified; the duration
   is not.
3. **Whether 2 fps sampling is enough to drive motion.** The detector samples at `REFRAME_SAMPLE_FPS = 2`.
   That is sufficient to notice a person moving across several seconds and probably insufficient to track a
   fast movement. Raising it costs detector time linearly. Left at 2 for this increment, and check 3's
   "returns" metric is where an inadequate rate would show up.
