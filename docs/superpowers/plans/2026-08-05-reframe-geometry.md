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

### Task 1: Measure the geometry before changing it

**Files:** none - measurement only

- [ ] **Step 1: Instrument and replay.**

For every shot of every clip on a rendered fixture, record: the chosen layout, `sourceWidth`, `cropW`, `tileW`, the anchorable face boxes, their span, the resulting tile x positions, and the **tile overlap as a fraction of tile width**. `computeCropPlan` needs a real video; the rendered eval jobs in the database carry their `cropPlan` per clip, and `Job.renderManifest` carries the per-clip reframe checks - start there before re-running detection, which is expensive.

Report:
- the distribution of tile overlap across every `split` shot, and how many exceed 25% / 50%
- for every `single` shot with two or more anchorable faces, how far the anchor sits from the nearest face centre, as a fraction of `cropW`
- how often `mouthActivity` actually distinguishes the faces in a shot - if it is near-zero everywhere, the anchor fix has no signal to use and you must say so

**If the measured overlap does not match the arithmetic above, stop and report.** The arithmetic is mine and it has been wrong before on this work.

- [ ] **Step 2: Commit the measurement** as a note in `docs/engine-notes.md` §7, whether or not it confirms the diagnosis.

---

### Task 2: Split only when the tiles are actually separate

**Files:** `apps/worker/src/reframe/plan.ts`, `apps/worker/src/__tests__/reframe-plan.test.ts`

- [ ] **Step 1:** Replace the split condition so a split requires the two tiles to be genuinely separate, not the faces. Derive the threshold from Task 1's distribution - do not take a number from this plan.

The hard case is the middle: two faces further apart than `FIT_MARGIN * cropW` (so a single window cannot hold both) but closer than a tile width (so tiles would overlap). Decide what that case gets - a single crop anchored on the dominant face, a centre crop, or something else - and **justify it from the measurement**, then check what it does to the fixtures.

- [ ] **Step 2:** TDD, then mutation-test and report a full matrix. The previous branch measured plan-supplied test sketches letting 6 of 8 and 19 of 29 mutants through; design your own cases.

- [ ] **Step 3:** Verify with pixels, not argument. `eval-reframe.ts` writes a contact sheet through the computed plan - that is what it is for, and `docs/engine-notes.md` records that reframe decisions are checked against pixels. Produce before/after sheets for at least the clips Task 1 found worst.

---

### Task 3: Anchor the single crop on a face, not a midpoint

**Files:** `apps/worker/src/reframe/plan.ts`, `apps/worker/src/__tests__/reframe-plan.test.ts`

- [ ] **Step 1:** When a single crop cannot hold every anchorable face comfortably, anchor it on the dominant face rather than the span midpoint. Use `dominance`, which already carries `mouthActivity`.

Keep the case that works: when the faces genuinely fit with room to spare, the midpoint is right and must not move. Task 1's measurement decides where "comfortably" sits.

- [ ] **Step 2:** TDD plus mutation matrix, as Task 2.

- [ ] **Step 3:** Contact sheets, before and after.

---

### Task 4: Re-render and look

- [ ] Re-render the sitcom set through `eval-render-set.ts`, rebuild the frame strips, and put both sets side by side. The verification for this project is **visual and human** - no agent score, and no snapshot, because `cropPlan` is not in the eval snapshots at all.

---

## Acceptance

**No shipped clip may contain a stacked pair whose tiles overlap by more than the threshold Task 1 sets.** Measured, not judged.

**The payoff frame of the clips the audit named must contain a face.** Read the contact sheets: the weak-coffee clip's closing frame is a flower vase today, and the eyelash-curler clip's opening frame has no readable face.

No clip may be lost. Reframe failures degrade to a centre crop by design (`engine-notes` §7) and must continue to - a geometry change that drops a clip is a bug in the change.
