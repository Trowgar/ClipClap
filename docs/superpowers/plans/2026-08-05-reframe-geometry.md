# Reframe Geometry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the vertical crop showing the same person twice, and stop it pointing at the furniture between two people.

**Architecture:** Both defects live in the two branches of one condition, `plan.ts:195`. Neither is a tuning problem - the split branch gates on the wrong quantity, and the single branch anchors on a midpoint that is nobody. This plan fixes the branch conditions, not the constants.

**Tech Stack:** TypeScript, vitest, ffmpeg via the existing `eval-reframe.ts` contact-sheet harness.

---

## Why this shape - read before starting

Source: [`docs/superpowers/specs/2026-08-04-clip-quality-programme-design.md`](../specs/2026-08-04-clip-quality-programme-design.md) §3.5, project 4.

**`broken framing` stands in 11 of 11 editor verdicts** on the 2026-08-04 audit and again in 11 of 11 on the re-judged set. It is the most universal defect the audit found, and the only one the product owner spotted unaided, within fifteen seconds of opening the set, before any agent ran.

### The split branch gates on face span, never on tile separation

`tileWidthFor` is `h*9/8` and `cropWidthFor` is `h*9/16`, so **a tile is exactly twice the width of a normal crop**. The gate at `plan.ts:195` fires when the face bbox span exceeds `FIT_MARGIN * cropW` (0.9), and each tile is then centred on a face. Two faces just past that threshold therefore produce two tiles whose centres are `0.9 * cropW` apart while each tile is `2 * cropW` wide - an overlap of `1.1 * cropW`, **55% of each tile at the commonest firing**.

Measured on the real plan for the sitcom job, first clip: tiles at `x = 0` and `x = 202` with `tileW` about 392, so **48% of each tile is the same pixels**. Present in 7 of 12 clips. Every judge read it the same way before reading it as a scene: *"this video is broken"*, *"one shot pretending to be two"*, *"it looks like a player glitch"*.

### The single branch anchors on a midpoint that is nobody

When the span fits, `x = (minX + maxX) / 2 - cropW / 2` centres the window on the midpoint of the face span. With two faces near the window's edges, the centre of the frame is whatever sits between them. The editor's phrasing: *"the crop is tracking the table, not the speaker."* On the weak-coffee clip the payoff frame is a flower vase with both speakers sliced by the borders.

### The signal for who to anchor on already exists and is unused

`dominance` (`plan.ts:44-57`) already weights area, centrality **and `mouthActivity`**. The engine computes who is speaking and then throws it away when it picks a window. It is used only to choose which two of three-plus faces get tiles.

### Out of scope, deliberately

**The dead opening frame.** 11 of 12 clips open on something that loses the viewer - an empty room, a pure black inter-scene cut, a letterboxed wide shot, a back of a head. That is a real defect and a bigger one, but it is a different mechanism: the in-point is chosen by ANALYZE, which never sees the video. Fixing it needs either a probe that ANALYZE does not have or a RENDER-side nudge, and it deserves its own design. Do not attempt it here.

---

## MEASURED 2026-08-05 - half this diagnosis was wrong, and the real defect is a third branch

Task 1 ran and is committed (`b704924`, `engine-notes` §7). What it found rewrites the rest of this plan.

**The split arithmetic reproduces, and the defect is structural rather than a bad threshold.** Two
tiles of `h*9/8` need `2.25h` of width; a 16:9 source has `1.778h`. **They cannot be disjoint.** The
floor is 42% overlap, reached only at an aspect of 2.25:1, and **55 of 124 shipped splits already sit
on that floor** with both tiles clamped to opposite edges. Median overlap 48.0%, max 98.5% - the same
picture stacked on itself 8px apart. 124 of 124 exceed 25%. So "split only when the tiles are
separate" means "never split" on every source this product has seen, and the original Task 2 is
withdrawn.

**The single branch was not guilty.** Of 22 single shots only 4 carry two or more anchorable faces,
and the anchor sits at most 0.118 `cropW` - 23px on a 198px window - from the nearest face centre,
with every face inside the window. Structural, not luck: that branch is only reached when the span
already fits in `0.9 * cropW`. The original Task 3 is withdrawn.

**The crop that tracks the table is the CENTRE branch.** 12 of 16 centre shots HAVE anchorable faces
and are centred blind anyway, because the three-plus-face `DOMINANCE_LEAD` test failed. That is
**147.8s of 333.5s - 44% of shot time - across 9 of 12 clips**, median centre-to-nearest-face 0.27
`cropW`, max 0.59, and **in 4 of 12 clips the nearest face is outside the crop window entirely**. The
weak-coffee clip closes on 26.2 seconds of it. Centre is the modal layout by screen time, 47.2%.

**`mouthActivity` is live but is not trustworthy yet.** 126 observations, median 0.049, no zeros,
within-shot max/min ratio median 1.83. But `dominance` weights it 0.2 against 0.8 for area and
centrality and agrees with the mouthiest face in only **17 of 35** multi-face shots. More
importantly the signal itself is unvalidated: it is a 2fps mean-absolute-difference of a mouth patch,
and a head turn or box jitter produces it as readily as speech. **Do not anchor on it before a
per-shot ground truth exists.**

---

### Task 2 (rewritten): stop splitting where a split cannot work

**Files:** `apps/worker/src/reframe/plan.ts`, `apps/worker/src/__tests__/reframe-plan.test.ts`

- [ ] **Step 1: Decide what replaces a split, and justify it from the measurement.**

The split layout is sound only where `2 * tileW <= sourceWidth`, i.e. an aspect at or beyond 2.25:1.
Gate it on that, and send everything else to whichever branch the measurement says is better -
which will usually mean a single crop anchored on one face rather than a centre crop, given the
centre branch's own numbers above.

Do not redesign the tiles. Making them narrower means cropping each tile vertically as well, which is
a different filtergraph and a different project; say so and leave it.

- [ ] **Step 2: TDD, then mutation-test with a full matrix.** Include a source at exactly 2.25:1 and
  either side of it.

- [ ] **Step 3: Contact sheets before and after** on the clips §7 names as worst. Pixels, not
  argument - `engine-notes` §7 already says reframe decisions are checked that way.

---

### Task 3 (rewritten): stop centring blind when a face is available

**Files:** `apps/worker/src/reframe/plan.ts`, `apps/worker/src/__tests__/reframe-plan.test.ts`

- [ ] **Step 1:** When `DOMINANCE_LEAD` fails among three or more faces, the current answer is a
  centre crop that ignores every face it just measured. Anchor on a face instead. Which face is the
  design question, and `dominance` is the obvious candidate **with the caveat above** - it is
  size-and-centrality-led, and the mouth term it carries is unvalidated.

  Prefer a choice that does not depend on `mouthActivity` being speech. If you conclude the honest
  answer needs that ground truth first, say so and stop - a wrong anchor is worse than a centre crop,
  because it points confidently at the wrong person.

- [ ] **Step 2:** TDD plus mutation matrix.

- [ ] **Step 3:** Contact sheets, before and after, including the weak-coffee clip's closing 26s.

---

### Task 4: Re-render and look

- [ ] Re-render the sitcom set, rebuild the frame strips, put both sets side by side. Verification
  here is **visual and human**: `cropPlan` is not in the eval snapshots, so no snapshot and no agent
  score can see this change.

---

## Acceptance

**No shipped clip may contain a stacked pair on a source narrower than 2.25:1.** Measured from
`cropPlan`, not judged.

**Centre-with-faces-available must fall from 12 of 16 shots** to whatever the fix leaves, and the
four clips whose nearest face is outside the crop window must be zero.

No clip may be lost. Reframe failures degrade to a centre crop by design (`engine-notes` §7) and must
continue to.
