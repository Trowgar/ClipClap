# In-Point Repair: The Black Opening Frame

**Date:** 2026-08-05
**Status:** Draft - awaiting owner review
**Scope:** RENDER stage only. Adds a new module `apps/worker/src/inpoint/` and moves one variable
inside the highlights loop of `apps/worker/src/stages/render.ts`. Does **not** touch ANALYZE, the
`reframe` module, the queue, the Prisma schema, or any user-facing surface.

Follows the fallback discipline established by
[2026-07-24-smart-reframe-design.md](2026-07-24-smart-reframe-design.md): every failure degrades to
today's behaviour and nothing here may fail a render.

---

## 1. Problem

A clip that opens on a black frame reads as a video that failed to load, and the viewer is gone
before the first word does any work. The in-point is chosen by ANALYZE from the transcript, and
ANALYZE never sees a frame, so nothing in the pipeline currently knows what the first frame looks
like.

**Measured 2026-08-05** on job `cmsg4y7rw0001fqbf8dimdrb0` (the `sitcom-friends` fixture rendered
through the shipping engine, 10 clips). Method: first 3 seconds of each **rendered** clip sampled at
10 fps, per frame mean luma and YuNet faces, and the same instants sampled from the source.

| Signal | Count |
|---|---|
| Clips whose frame 0 is black (mean luma < 40, the survey criterion) | **1 of 10** |
| Clips with no detected face in frame 0 | 2 of 10 |
| Clips where no face appears anywhere in the first 3 s | 0 of 10 |

That survey used mean luma because it was a survey. The shipping probe uses ffmpeg `blackdetect`,
and the same 10 clips were re-measured with it at the source's full 30 fps, over the first 3 seconds
of each:

| Clip | Black run | Begins at the in-point? |
|---|---|---|
| 01 | 0.000 - 0.267 s (**0.267 s**, 8 frames) | **yes** |
| 03 | 0.217 - 0.483 s (0.267 s, 8 frames) | no |
| the other 8 | none at all | - |

**Two facts from that table govern the whole design.** The run that must be repaired and the run that
must be ignored are **exactly the same length** - both are the standard eight-frame black of this
compilation source - so a duration threshold discriminates nothing here. What separates them is
**position**: one begins at the in-point, the other 0.217 s inside the clip. And 0.267 s is shorter
than the 0.3-0.5 s minimum first proposed for this repair, so that threshold as stated would have
produced zero repairs on the only set anyone has measured.

The one black opening is clip 01. Its opening timeline, mean luma / widest face as a fraction of
frame width:

```
t     0.0   0.1   0.2   0.3   0.4  ...  1.3   1.4   1.5
luma  2     2     2     29    36        36    49    50
face  0.00  0.00  0.00  0.00  0.00      0.00  0.42  0.42
```

Both judge agents reached it independently and unprompted. The viewer agent: *"It is a black
rectangle with the words 'So come on' sitting in the lower third ... a totally black opening frame
reads as a video that failed to load"*, and it opened its verdict with `swipe`. The editor agent
binned the clip and named the black frame as the deciding fact.

**The prior estimate was wrong, and the correction is the point of this section.** The 2026-08-04
audit recorded *"11 of 12 clips open on a frame that loses the viewer"*
([2026-08-04-clip-quality-programme-design.md](2026-08-04-clip-quality-programme-design.md) §3.5).
That was a subjective judgement covering black frames, letterboxed wide shots, backs of heads and
empty rooms. Measured mechanically, only **one** clip in ten opens black. This design repairs that
one case and claims nothing about the others.

## 2. Fixed product decisions

Taken by the owner on 2026-08-05, during the design conversation.

- **A faceless opening is not a defect.** The product processes gameplay, sports, screen recordings
  and animation, all of which are faceless by nature. A face gate at the in-point would turn correct
  output into a defect for whole content classes. Only objective blackness qualifies.
- **The end never moves.** Only the in-point shifts; the clip becomes shorter. Moving the whole
  window would silently push the out-point into material that no stage of ANALYZE has approved, and
  end extension is a separate stage that is deliberately off by default.
- **Speech over the black frame does not protect it.** In the one measured case the black frame
  carries the words "So come on". The frame still loses the viewer before those words can work, so
  the repair proceeds and the words are lost with it.
- **The shift is capped at 2 seconds.** Beyond that the repair is doing content editing, which is
  ANALYZE's job.

## 3. Non-goals

- Faceless, letterboxed, wide-shot or back-of-head openings. Named in §1, out of scope by decision.
- The in-point chosen by ANALYZE in any case where the first frame is not black.
- The out-point. Untouched.
- Mid-clip black frames. Clip 03 of the measured set has a black run at 0.2-0.4 s from an
  inter-scene cut in the source; it is not at the in-point and this design must leave it alone.
  It exists in this document as the negative test case, not as a target.
- Any repair to the framing of the first frame. Clip 07 opens on a face that the crop window slices
  at the left border, which is a real defect with a different mechanism (the window is anchored on a
  per-shot median face box, so it misses wherever the face is not in its average position). That is
  the same root cause as the mid-clip mis-framing recorded in `engine-notes.md` §7d and belongs with
  the face-timeline work, not here.

## 4. The rule

Given a clip `[start, end]` and its cues:

1. Probe the source over `[start, start + probeSec]` for black runs.
2. If no run begins at `start` (within one frame), do nothing.
3. If that run is shorter than `blackMinSec`, do nothing.
4. Otherwise let `t` be the end of the run. Shift the in-point to the **first word boundary at or
   after `t`**, taken from the word timings already present inside the cues.
5. Refuse the shift, leaving the clip untouched, if any of these hold:
   - no word boundary exists in the clip-relative range `[t, maxShiftSec]`;
   - the shift exceeds `maxShiftSec`;
   - the resulting clip would be shorter than the clip-length floor;
   - the clip has no cues at all (a dialogue-free highlight has no word boundary to land on).

Every refusal is recorded with a machine-readable reason. Refusing is always safe: it is today's
behaviour exactly.

**Worked example, clip 01.** The black run is 0.000-0.267 s. The word "So" spans 0.00-0.34 s and the
next word "come" begins at 0.70 s, so the first word boundary at or after 0.267 is **0.34 s**. The
in-point moves to 0.34, the word "So" is lost, and the clip opens in the silence before "come on"
on a frame of luma 29 rather than luma 2. Duration goes from 18.6 s to 18.3 s.

**Negative example, clip 03.** Its black run is the same 0.267 s long but begins at 0.217 s, so step
2 refuses it and the clip is untouched. This pair is the reason the position test, not the duration
test, carries the design.

Note what this example also shows: the repair removes the **black frame**, not the dim one, and does
not put a face on screen. Per §2 that is the whole intent, but nobody should expect this clip's
viewer score to move on its own.

## 5. Components

New module `apps/worker/src/inpoint/`, split on the same seam as the rest of this worker: I/O in one
file, policy in another, so the policy is testable without a video file.

### 5.1 `black.ts` - the probe

```ts
export function parseBlackRuns(stderr: string): Array<{ start: number; end: number }>;

export async function detectLeadingBlack(
  sourcePath: string,
  startSec: number,
  probeSec: number,
  cfg: InPointConfig,
  timeoutMs: number
): Promise<number>;   // seconds of black beginning at the in-point; 0 when none
```

Runs `ffmpeg -ss <start> -to <start+probeSec> -i <source> -vf blackdetect=... -f null -`. As in
[`shots.ts`](../../../apps/worker/src/reframe/shots.ts), `-ss` precedes `-i`, so reported timestamps
are clip-relative and a run starting at the in-point reports `black_start:0`.

`blackdetect` is given a **small** minimum duration (`d`), not the policy threshold. The filter drops
any run shorter than `d` outright, so putting the policy threshold there would hide the measurement
from the pure resolver and make the threshold untestable. The filter reports, the resolver decides.

`parseBlackRuns` is pure and reads the `black_start` / `black_end` pairs out of stderr, mirroring how
`scdetPass` reads `pts_time`.

### 5.2 `resolve.ts` - the decision

```ts
export interface InPointDecision {
  shiftSec: number;                 // 0 when the clip is left alone
  reason: "shifted" | "no_black" | "black_too_short" | "no_word_boundary"
        | "exceeds_cap" | "clip_too_short" | "no_cues";
}

export function resolveInPoint(input: {
  blackRunSec: number;
  cues: Cue[];                      // clip-relative, with word timings
  clipDurationSec: number;
  minClipSec: number;
  cfg: InPointConfig;
}): InPointDecision;
```

Pure. No filesystem, no ffmpeg, no clock. Every branch in §4 is one test.

### 5.3 `config.ts`

```ts
export interface InPointConfig {
  repair: boolean;        // INPOINT_REPAIR === "on", exact literal
  blackMinSec: number;    // INPOINT_BLACK_MIN_SEC, default 0.10
  maxShiftSec: number;    // INPOINT_MAX_SHIFT_SEC, default 2.0
  probeSec: number;       // INPOINT_PROBE_SEC,     default 3.0
  blackPixTh: number;     // INPOINT_BLACK_PIX_TH,  default 0.10
}
```

**`blackMinSec` is 0.10 and it is not a measured number.** Its only job is to ignore a one or two
frame flash; at 30 fps it admits anything three frames or longer. It was **0.3 in the first draft of
this design, which the §1 measurement then falsified** - the one run that must be repaired is
0.267 s. Nothing in the measured set discriminates on duration, because both black runs in it are
the same length, so this threshold currently separates nothing and must not be described as tuned.
The position test in step 2 of §4 is what does the work.

`INPOINT_REPAIR` must equal the literal `"on"` - not truthy, not `"true"`, not `"1"`. A killswitch
that can be flipped by accident is not one. This matches `REFRAME_STREAM`.

**The clip-length floor is not a new number.** `resolveInPoint` takes `minClipSec` as a parameter and
RENDER passes the existing `hardMinSec` from the analyze config (`CLIP_HARD_MIN_SEC`, default 6). A
second constant here would drift from the first, and the drift would be silent.

## 6. Data flow

Inside the highlights loop of `render.ts`, the shift is resolved **before** cues and the crop plan
are derived, so both are built against the window that will actually be encoded:

```
probe black at highlight.start
  -> resolveInPoint(...)                     -> shiftSec
  -> effectiveStart = highlight.start + shiftSec
  -> segmentsToCues(segments, effectiveStart, highlight.end)
  -> computeCropPlan(source, effectiveStart, highlight.end)
  -> cutClips(source, [{ ...highlight, start: effectiveStart }], ...)
```

Consequence worth stating because it removes work: **`sliceCues` and `sliceCropPlan` are not
needed.** Neither the cue track nor the crop plan is ever built against the old window, so neither
has to be re-windowed afterwards.

`Clip.startTime` stores `effectiveStart` and `Clip.duration` is recomputed from it. The trim editor
reads `startTime` as the source offset, so it inherits the repair with no change.

`Clip.hookStart`, `hookEnd` and `payoffAt` are copied from the highlight today. Whether they are
source-relative or clip-relative decides whether a shift can leave them inconsistent; the
implementation plan must check this and clamp if required. Flagged rather than assumed.

## 7. Failure policy

Identical to the reframe contract already in this stage: **the repair never fails a render.** Probe
timeout, unparseable stderr, missing cues, ffmpeg error - all produce `shiftSec: 0` and a recorded
reason, and the clip renders exactly as it does today. The probe runs under its own timeout and its
cost is bounded by `probeSec` of decoding, roughly 0.2-0.5 s against the 30 s detection budget the
stage already spends per highlight.

## 8. Telemetry

`renderManifest` gains an `inpoint` block beside the existing `reframe` block, built by a pure
`buildInPointCheck` in the shape of
[`buildReframeCheck`](../../../apps/worker/src/reframe/telemetry.ts):

```json
"inpoint": {
  "enabled": true,
  "checks": [{ "blackRunSec": 0.267, "shiftSec": 0.34, "reason": "shifted", "probeMs": 210 }]
}
```

Without this we cannot answer "does the repair ever fire in production", which is the only question
that matters after rollout.

## 9. Invariants

- The out-point is never modified.
- The in-point only ever moves **forward**, never backward.
- The in-point always lands on a word boundary that exists in the cue data, so a word is never cut
  in half. This is the RENDER-side echo of the ANALYZE invariant that boundaries are code-owned.
- With `INPOINT_REPAIR` off, the bytes produced are identical to today's. A test asserts the encode
  arguments are unchanged when the flag is off.
- A refusal is indistinguishable from today's behaviour, by construction.

## 10. Testing

**Pure unit tests** on `resolveInPoint`, one per branch of §4: below threshold, above threshold with
a boundary, no boundary in range, shift over the cap, clip would fall under the floor, no cues at
all, and the worked example of §4 asserted to the exact 0.34.

**Parser test** on `parseBlackRuns` against real `blackdetect` stderr, including two cases that must
behave differently: a run beginning at 0 (clip 01, fires) and a run beginning at 0.2 (clip 03, must
be ignored because it is not at the in-point).

**Measurement, already done once, and it is the acceptance test.** The probe was run across all 10
clips of `cmsg4y7rw0001fqbf8dimdrb0` at the source's full 30 fps; the result is the table in §1 and
it must be reproduced by the shipped code: **fires on clip 01, silent on the other nine.**

State the corridor honestly rather than inventing one. There is **no duration corridor** in this
data: the firing run and the nearest non-firing run are both 0.267 s. The separation is positional
and it is large - 0.000 s against 0.217 s, which is 6.5 frames at 30 fps. `blackMinSec` therefore
has no measured support at any value below 0.267, and the plan must not claim otherwise. A second
source with a different black length is what would give it one.

**Title evidence check.** Also measured once, over the same set: does any shipped title cite
evidence from the first two seconds of its own clip? This is the risk in §11 and it should be a
number before the flag goes on.

**Regression.** Existing render tests must pass unchanged with the flag off.

## 11. Risks

**A head shift is a boundary move, and a boundary move can void a title.** This engine has been
bitten twice: a trim that moves a clip past the nodes its title cites leaves `regroundCopy`
installing a raw transcript node as the title (`engine-notes.md` §4, §5a). RENDER knows nothing about
nodes and cannot re-check evidence, and nothing runs after RENDER that could repair copy.

Mitigations: the shift is capped at 2 seconds; it lands on a word boundary; and §10 requires the
frequency to be measured before rollout. The residual cost is also lower than it was when those
defects were found, because the owner confirmed on 2026-08-05 that the title is an informational
label shown on delivery, not a published caption. It is not zero: a label that quotes a line no
longer inside the clip is wrong in a way a user can see.

**The prize is small and should not be oversold.** One clip in ten on the only set that has been
measured. This design is worth doing because the defect is unambiguous, the repair is cheap, and
the fix is bounded - not because it will move the viewer score.

## 12. Rollout

Ships **off**. `INPOINT_REPAIR=on` in `.env` enables it, and `.env` is not in git.

Order: land the code with the flag off, run the §10 measurement, record the corridor and the title
number in `engine-notes.md`, then enable and re-render the measured set. Rollback is
`INPOINT_REPAIR=off` followed by `docker compose up -d worker-render` - `compose restart` does not
re-read `env_file` - and then `npx prisma generate --schema=/app/prisma/schema.prisma` inside the
recreated container.

## 13. What this design does not settle

- Whether a dim-but-not-black opening (clip 01 still opens at luma 29 after the repair) is worth
  treating. Deliberately unanswered: it needs a threshold nobody has measured.
- The sliced-face opening of clip 07, and the per-shot median box that causes it. Named in §3.
- Whether the in-point repair should eventually live in ANALYZE, which owns boundaries. It cannot
  today, because ANALYZE has no access to the video.
