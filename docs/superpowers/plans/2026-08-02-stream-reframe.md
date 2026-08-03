# Stream Reframe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the engine producing broken clips from stream sources, then add a layout that stacks the streamer's webcam inset over the content it sits on.

**Architecture:** Everything lives in the existing `apps/worker/src/reframe/` module and the existing Python sidecar. A source classifier decides whether a face is big enough to anchor a crop; when it is not and a webcam rectangle is found, a new `stream` shot layout stacks a cam tile over a content tile. All geometry is pure TypeScript arithmetic solved once per clip; only the two `x` offsets vary per shot, so the existing `piecewiseX` machinery and single-encode filtergraph are reused unchanged.

**Tech Stack:** TypeScript, vitest 3.2 (in-container), Python 3 + OpenCV 4.12 + numpy 2.3 (already in the worker image), ffmpeg filtergraphs, Python `unittest` (no pytest in the image).

**Spec:** [docs/superpowers/specs/2026-08-02-stream-reframe-design.md](../specs/2026-08-02-stream-reframe-design.md)

---

## Conventions used by every task

**Run TypeScript tests** (host shell, from `/srv/dev/clipclap.io`):

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/<file>.test.ts
```

**Run Python tests:**

```bash
docker compose exec -T worker-render python3 -m unittest discover -s /app/apps/worker/assets/reframe -p 'test_*.py' -v
```

**Commit identity** is already configured for this repo; use plain `git commit`. Never add a Claude attribution trailer.

**Source is bind-mounted** - edits are live in the worker containers immediately, no rebuild.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/worker/src/reframe/types.ts` | shared shapes: `CamRect`, `StreamGeometry`, `SourceProfile`, `stream` layout, `CropPlan` v2 | modify |
| `apps/worker/src/reframe/options.ts` | `PlanOptions` + defaults; the only place thresholds are named | **create** |
| `apps/worker/src/reframe/stream-geometry.ts` | pure tile arithmetic: solve, free band, cam x, content x | **create** |
| `apps/worker/src/reframe/cam-rect.ts` | resolve one clip-level rect from per-shot rects | **create** |
| `apps/worker/src/reframe/plan.ts` | min-face guard, classification, layout emission | modify |
| `apps/worker/src/reframe/filtergraph.ts` | `stream` branch of the graph | modify |
| `apps/worker/src/reframe/faces.ts` | accept + validate `camRect` from the sidecar | modify |
| `apps/worker/src/reframe/config.ts` | env knobs | modify |
| `apps/worker/src/reframe/index.ts` | wire rect resolution into `computeCropPlan` | modify |
| `apps/worker/assets/reframe/detect_faces.py` | webcam rectangle detection | modify |
| `apps/worker/assets/reframe/test_cam_rect.py` | sidecar unit tests | **create** |
| `apps/worker/assets/reframe/testdata/*.jpg` | 3 committed 640-wide frames | **create** |
| `apps/worker/src/scripts/eval-reframe.ts` | visual harness: video + timestamps -> plan JSON + contact sheet | **create** |
| `apps/worker/src/stages/render.ts` | record the profile in reframe telemetry | modify |

Geometry is split out of `plan.ts` deliberately: `plan.ts` is already 192 lines of layout policy, and the tile solver is a self-contained numeric unit that deserves its own test file.

---

# Phase 1 - The min-face guard (ships alone, no flag)

### Task 1: A face too small to anchor a crop must not anchor a crop

Spec §4.1. This is the whole fix for defect 1 and is correct independently of everything after it.

**Files:**
- Create: `apps/worker/src/reframe/options.ts`
- Modify: `apps/worker/src/reframe/plan.ts`
- Test: `apps/worker/src/__tests__/reframe-plan.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/__tests__/reframe-plan.test.ts`:

```ts
describe("min-face guard", () => {
  it("centres instead of anchoring on a face below 6% of frame width", () => {
    // 1920 * 0.06 = 115.2, so a 40px face is far below the floor.
    const plan = buildCropPlan(oneShot, withTracks([track(900, 40)]), W, H);
    expect(plan?.shots[0].layout).toBe("center");
  });

  it("still anchors on a face at or above the floor", () => {
    const plan = buildCropPlan(oneShot, withTracks([track(900, 120)]), W, H);
    expect(plan?.shots[0].layout).toBe("single");
  });

  it("ignores tiny tracks when deciding a split, rather than widening the bbox", () => {
    // Two real faces at the edges plus one speck in the middle: the speck must
    // not survive into the pair, and the two real faces must still split.
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(100, 200), track(1600, 200), track(950, 30)]),
      W,
      H
    );
    expect(plan?.shots[0].layout).toBe("split");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-plan.test.ts
```

Expected: the first test FAILS with `expected 'single' to be 'center'`. (The third may pass by accident through the existing `MIN_SAMPLE_FRAC` filter - that is fine, it locks the behaviour in.)

- [ ] **Step 3: Create the options module**

Create `apps/worker/src/reframe/options.ts`:

```ts
/**
 * Thresholds that decide WHICH layout a shot gets. Unlike the geometry
 * constants in plan.ts (which are deliberately not env knobs), these rest on a
 * single measured fixture and are expected to move once real stream sources
 * arrive - so they are overridable, and every decision records its inputs.
 */
export interface PlanOptions {
  /** At or below this fraction of frame width, a face may not anchor a crop. */
  faceSmallFrac: number;
  /** At or above this fraction, the existing single/split logic applies. */
  faceLargeFrac: number;
  /** Emit the stream layout at all. */
  stream: boolean;
  /** Target cam tile share of output height. */
  camShare: number;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  faceSmallFrac: 0.06,
  faceLargeFrac: 0.1,
  stream: false,
  camShare: 0.4,
};
```

- [ ] **Step 4: Add the guard to `buildCropPlan`**

In `apps/worker/src/reframe/plan.ts`, add the import at the top:

```ts
import { DEFAULT_PLAN_OPTIONS, type PlanOptions } from "./options";
```

Change the signature (the new parameter is optional, so all existing callers and tests keep working):

```ts
export function buildCropPlan(
  shots: Shot[],
  tracksByShot: ShotTracks[],
  sourceWidth: number,
  sourceHeight: number,
  opts: PlanOptions = DEFAULT_PLAN_OPTIONS
): CropPlan | null {
```

Inside the `shots.map` callback, immediately after the existing `const tracks = shotTracks.filter(...)` block, insert:

```ts
    // A face occupying 3% of frame width is a webcam inset or a distant
    // bystander, not a subject. Centring a 9:16 window on it yields a
    // truncated inset plus whatever overlay sits under it (spec section 4.1).
    const minFaceWidth = opts.faceSmallFrac * sourceWidth;
    const anchorable = tracks.filter((t) => t.box.w >= minFaceWidth);
    if (anchorable.length === 0) {
      return { start: shot.start, end: shot.end, layout: "center", x: centerX };
    }
```

Then replace every remaining use of `tracks` inside that callback with `anchorable` - there are four: the `minX` reduce, the `maxX` reduce, `let pair = tracks;` and `if (tracks.length > 2)`.

Delete the now-dead `if (tracks.length === 0)` early return that sat above, since `anchorable.length === 0` subsumes it.

- [ ] **Step 5: Run the tests and confirm green**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-plan.test.ts
```

Expected: PASS, 26 tests. If any pre-existing test now fails, its fixture face is below 6% of its frame width - widen the fixture face rather than lowering the threshold, and note it in the commit.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/reframe/options.ts apps/worker/src/reframe/plan.ts apps/worker/src/__tests__/reframe-plan.test.ts
git commit -m "fix(reframe): never anchor a crop on a face under 6% of frame width

On stream sources the detector finds the streamer's face inside a small
webcam inset and the planner centres a 9:16 window on it, yielding a
truncated webcam, the chat overlay under it and a slice of game floor.
Measured on a real CS2 VOD: face 43x56 in a 1280x720 frame, 3.4% of width,
against 15-30% for a podcast. Below the floor the shot now centres instead."
```

---

# Phase 2 - Geometry (pure arithmetic, no detector yet)

### Task 2: Types for CropPlan v2

**Files:**
- Modify: `apps/worker/src/reframe/types.ts`

- [ ] **Step 1: Add the new shapes**

Append to `apps/worker/src/reframe/types.ts`:

```ts
export type SourceClass = "faceless" | "normal_face" | "small_face" | "stream";

/** Webcam inset in SOURCE pixels. x/y even and inside frame; w/h even. */
export interface CamRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Minimum of the four border energies, normalised by frame mean. */
  score: number;
}

/** Clip-constant tile geometry. Only the two x offsets vary per shot. */
export interface StreamGeometry {
  camCrop: { w: number; h: number; y: number };
  contentCrop: { w: number; h: number };
  outCamH: number;
  outContentH: number;
}

export interface SourceProfile {
  class: SourceClass;
  /** Widest surviving face box width as a fraction of source width. */
  faceFrac: number;
  camRectScore?: number;
  reason?: string;
}
```

- [ ] **Step 2: Extend `ShotLayout` and `CropPlan`**

Replace the existing `ShotLayout` union and `CropPlan` interface with:

```ts
export type ShotLayout =
  | { start: number; end: number; layout: "center"; x: number }
  | { start: number; end: number; layout: "single"; x: number }
  | {
      start: number;
      end: number;
      layout: "split";
      top: { x: number };
      bottom: { x: number };
    }
  | {
      start: number;
      end: number;
      layout: "stream";
      cam: { x: number };
      content: { x: number };
    };

export interface CropPlan {
  version: 1 | 2;
  engine: "faces";
  source: { width: number; height: number };
  profile?: SourceProfile;
  /** Present iff at least one shot has layout "stream". */
  stream?: StreamGeometry;
  shots: ShotLayout[];
}
```

- [ ] **Step 3: Typecheck**

```bash
docker compose exec -T worker-render npx tsc --noEmit -p /app/apps/worker/tsconfig.json
```

Expected: errors only in `plan.ts` (`planLayoutCounts` has no `stream` key) and `filtergraph.ts` (unhandled union member). Both are fixed in Tasks 5 and 10. Record the exact error list; do not fix it here.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/reframe/types.ts
git commit -m "feat(reframe): CropPlan v2 shapes for the stream layout"
```

---

### Task 3: The tile solver

Spec §6.2 and §6.3. This is the numeric heart of the feature and the one part where an off-by-two produces an ffmpeg error -22 that bypasses every fallback.

**Files:**
- Create: `apps/worker/src/reframe/stream-geometry.ts`
- Test: `apps/worker/src/__tests__/reframe-stream-geometry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/reframe-stream-geometry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CAM_SHARE_MIN,
  evenRound,
  freeBand,
  solveStreamGeometry,
  streamCamX,
  streamContentX,
} from "../reframe/stream-geometry";

// The measured CS2 fixture: 1280x720, inset flush to the top-left corner,
// 427x240 in raw pixels, snapped outward to even.
const FIXTURE = {
  sourceWidth: 1280,
  sourceHeight: 720,
  camRect: { x: 0, y: 0, w: 428, h: 240, score: 4.7 },
  camShare: 0.4,
};

describe("evenRound", () => {
  it("matches evenClamp's rounding at halfway values", () => {
    expect(evenRound(675)).toBe(676);
    expect(evenRound(336.62)).toBe(336);
    expect(evenRound(1150.29)).toBe(1150);
  });
});

describe("freeBand", () => {
  it("takes the wider side of a left-hand inset", () => {
    expect(freeBand(FIXTURE.camRect, 1280)).toEqual({ x: 428, w: 852 });
  });

  it("takes the left side when the inset is on the right", () => {
    expect(freeBand({ x: 852, y: 0, w: 428, h: 240, score: 1 }, 1280)).toEqual({
      x: 0,
      w: 852,
    });
  });
});

describe("solveStreamGeometry", () => {
  it("solves the fixture to the numbers in the spec", () => {
    const g = solveStreamGeometry(FIXTURE);
    expect(g).not.toBeNull();
    expect(g!.contentCrop).toEqual({ w: 676, h: 720 });
    expect(g!.outContentH).toBe(1150);
    expect(g!.outCamH).toBe(770);
    expect(g!.camCrop).toEqual({ w: 336, h: 240, y: 0 });
  });

  it("always fills the output exactly", () => {
    const g = solveStreamGeometry(FIXTURE)!;
    expect(g.outCamH + g.outContentH).toBe(1920);
  });

  it("emits only even dimensions", () => {
    const g = solveStreamGeometry(FIXTURE)!;
    for (const v of [
      g.camCrop.w,
      g.camCrop.h,
      g.camCrop.y,
      g.contentCrop.w,
      g.outCamH,
      g.outContentH,
    ]) {
      expect(v % 2).toBe(0);
    }
  });

  it("never proposes a content window wider than the source", () => {
    const g = solveStreamGeometry({
      ...FIXTURE,
      sourceWidth: 720,
      sourceHeight: 720,
      camRect: { x: 0, y: 0, w: 240, h: 136, score: 4 },
    });
    if (g) expect(g.contentCrop.w).toBeLessThanOrEqual(720);
  });

  it("reduces the cam share when the free band is too narrow, never raises it", () => {
    // Inset eats the left half: only 640px of free band remains, and the
    // default share needs 676. A SMALLER cam tile needs a NARROWER window.
    const g = solveStreamGeometry({
      ...FIXTURE,
      camRect: { x: 0, y: 0, w: 640, h: 360, score: 4 },
    })!;
    expect(g.contentCrop.w).toBeLessThanOrEqual(640);
    expect(g.outCamH).toBeLessThan(770);
  });

  it("gives up rather than slicing the inset in half", () => {
    // Inset dead centre: the widest free band is 320px, which no allowed share
    // can fill without overlapping the inset.
    expect(
      solveStreamGeometry({
        ...FIXTURE,
        camRect: { x: 320, y: 0, w: 640, h: 360, score: 4 },
      })
    ).toBeNull();
  });

  it("cover-crops a 4:3 inset by width instead of height", () => {
    const g = solveStreamGeometry({
      ...FIXTURE,
      camRect: { x: 0, y: 0, w: 320, h: 240, score: 4 },
    })!;
    // 320/240 = 1.333 which is below 1080/outCamH, so width is the limit.
    expect(g.camCrop.w).toBe(320);
    expect(g.camCrop.h).toBeLessThan(240);
    expect(g.camCrop.y).toBeGreaterThan(0);
  });

  it("never crops outside the inset", () => {
    const rect = { x: 40, y: 30, w: 320, h: 240, score: 4 };
    const g = solveStreamGeometry({ ...FIXTURE, camRect: rect })!;
    expect(g.camCrop.w).toBeLessThanOrEqual(rect.w);
    expect(g.camCrop.h).toBeLessThanOrEqual(rect.h);
    expect(g.camCrop.y).toBeGreaterThanOrEqual(rect.y);
    expect(g.camCrop.y + g.camCrop.h).toBeLessThanOrEqual(rect.y + rect.h);
  });

  it("clamps a share above the ceiling instead of honouring it", () => {
    const g = solveStreamGeometry({ ...FIXTURE, camShare: 0.9 })!;
    expect(g.outCamH / 1920).toBeLessThanOrEqual(0.56);
  });

  it("clamps a share below the floor", () => {
    const g = solveStreamGeometry({ ...FIXTURE, camShare: 0.05 })!;
    expect(g.outCamH / 1920).toBeGreaterThanOrEqual(CAM_SHARE_MIN - 0.01);
  });
});

describe("per-shot x", () => {
  it("anchors the cam window on the face, clamped inside the inset", () => {
    const g = solveStreamGeometry(FIXTURE)!;
    expect(streamCamX(FIXTURE.camRect, g.camCrop.w, 201)).toBe(34);
    expect(streamCamX(FIXTURE.camRect, g.camCrop.w, 0)).toBe(0);
    expect(streamCamX(FIXTURE.camRect, g.camCrop.w, 9999)).toBe(92);
  });

  it("clamps the content window into the free band", () => {
    const g = solveStreamGeometry(FIXTURE)!;
    const band = freeBand(FIXTURE.camRect, 1280);
    // Ideal centring would start at 302, which is inside the inset.
    expect(streamContentX(band, g.contentCrop.w, 1280, 640)).toBe(428);
    expect(streamContentX(band, g.contentCrop.w, 1280, 9999)).toBe(604);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-stream-geometry.test.ts
```

Expected: FAIL, `Failed to resolve import "../reframe/stream-geometry"`.

- [ ] **Step 3: Implement the solver**

Create `apps/worker/src/reframe/stream-geometry.ts`:

```ts
import type { CamRect, StreamGeometry } from "./types";

export const OUT_W = 1080;
export const OUT_H = 1920;
export const CAM_SHARE_MIN = 0.3;
export const CAM_SHARE_MAX = 0.55;
const SHARE_STEP = 0.025;

/** Same rounding as evenClamp in plan.ts, so the two agree at .5 values. */
export function evenRound(v: number): number {
  return 2 * Math.round(v / 2);
}

export interface Band {
  x: number;
  w: number;
}

/** The wider of the two horizontal strips the inset does not cover. */
export function freeBand(camRect: CamRect, sourceWidth: number): Band {
  const left: Band = { x: 0, w: Math.max(0, camRect.x) };
  const right: Band = {
    x: camRect.x + camRect.w,
    w: Math.max(0, sourceWidth - (camRect.x + camRect.w)),
  };
  return right.w >= left.w ? right : left;
}

export interface StreamSolveInput {
  sourceWidth: number;
  sourceHeight: number;
  camRect: CamRect;
  camShare: number;
}

/**
 * Solves both tiles from one free parameter.
 *
 *   Hg = Hs * OUT_W / Wg     content tile height
 *   Hc = OUT_H - Hg          cam tile height
 *
 * The relationship inverts the obvious adjustment: a TALLER cam tile needs a
 * WIDER content window, because a shorter content tile is proportionally wider.
 * So when the window will not fit the free band, the share is reduced.
 *
 * Returns null when no allowed share fits - rendering the inset twice, once
 * large and once as a sliced fragment, is worse than not splitting at all.
 */
export function solveStreamGeometry(
  input: StreamSolveInput
): StreamGeometry | null {
  const { sourceWidth: ws, sourceHeight: hs, camRect } = input;
  if (camRect.w < 2 || camRect.h < 2) return null;
  const band = freeBand(camRect, ws);
  const start = Math.min(CAM_SHARE_MAX, Math.max(CAM_SHARE_MIN, input.camShare));

  for (let share = start; share >= CAM_SHARE_MIN - 1e-9; share -= SHARE_STEP) {
    const targetCamH = evenRound(share * OUT_H);
    const targetContentH = OUT_H - targetCamH;
    if (targetContentH <= 0) continue;
    const contentW = evenRound((hs * OUT_W) / targetContentH);
    if (contentW < 2 || contentW > ws || contentW > band.w) continue;

    // Re-derive from the rounded width so the tiles sum to OUT_H exactly.
    const outContentH = evenRound((hs * OUT_W) / contentW);
    const outCamH = OUT_H - outContentH;
    if (outCamH < 2 || outContentH < 2) continue;

    // Cover-crop the inset to the cam tile's aspect: one branch or the other
    // always yields a rectangle inside camRect.
    const aspect = OUT_W / outCamH;
    let camW: number;
    let camH: number;
    if (camRect.w / camRect.h >= aspect) {
      camH = camRect.h;
      camW = evenRound(camH * aspect);
    } else {
      camW = camRect.w;
      camH = evenRound(camW / aspect);
    }
    camW = Math.min(evenRound(camW), evenRound(camRect.w));
    camH = Math.min(evenRound(camH), evenRound(camRect.h));
    if (camW < 2 || camH < 2) continue;

    const camY = Math.max(
      camRect.y,
      Math.min(
        evenRound(camRect.y + (camRect.h - camH) / 2),
        camRect.y + camRect.h - camH
      )
    );

    return {
      camCrop: { w: camW, h: camH, y: evenRound(camY) },
      contentCrop: { w: contentW, h: hs },
      outCamH,
      outContentH,
    };
  }
  return null;
}

/** Cam window centred on the face, clamped inside the inset. */
export function streamCamX(
  camRect: CamRect,
  camW: number,
  faceCenterX: number
): number {
  const lo = camRect.x;
  const hi = Math.max(lo, camRect.x + camRect.w - camW);
  return evenRound(Math.min(Math.max(faceCenterX - camW / 2, lo), hi));
}

/** Content window centred on the target, clamped into the free band. */
export function streamContentX(
  band: Band,
  contentW: number,
  sourceWidth: number,
  targetCenterX: number
): number {
  const lo = Math.max(0, band.x);
  const hi = Math.max(lo, Math.min(band.x + band.w, sourceWidth) - contentW);
  return evenRound(Math.min(Math.max(targetCenterX - contentW / 2, lo), hi));
}
```

- [ ] **Step 4: Run the tests and confirm green**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-stream-geometry.test.ts
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/reframe/stream-geometry.ts apps/worker/src/__tests__/reframe-stream-geometry.test.ts
git commit -m "feat(reframe): stream tile solver

One free parameter drives both tiles. A taller cam tile needs a WIDER
content window, so a window that will not fit the free band shrinks the
cam share rather than growing it. Gives up rather than slicing the inset."
```

---

### Task 4: Plan slicing and layout counts for v2

**Files:**
- Modify: `apps/worker/src/reframe/plan.ts:158-191`
- Test: `apps/worker/src/__tests__/reframe-plan.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/__tests__/reframe-plan.test.ts`:

```ts
describe("v2 plan handling", () => {
  const v2: CropPlan = {
    version: 2,
    engine: "faces",
    source: { width: 1280, height: 720 },
    profile: { class: "stream", faceFrac: 0.034, camRectScore: 4.7 },
    stream: {
      camCrop: { w: 336, h: 240, y: 0 },
      contentCrop: { w: 676, h: 720 },
      outCamH: 770,
      outContentH: 1150,
    },
    shots: [
      { start: 0, end: 10, layout: "stream", cam: { x: 34 }, content: { x: 428 } },
      { start: 10, end: 20, layout: "center", x: 302 },
    ],
  };

  it("slices a v2 plan and keeps the clip-level geometry", () => {
    const sliced = sliceCropPlan(v2, 5, 15);
    expect(sliced?.version).toBe(2);
    expect(sliced?.stream).toEqual(v2.stream);
    expect(sliced?.profile).toEqual(v2.profile);
    expect(sliced?.shots).toHaveLength(2);
    expect(sliced?.shots[0]).toMatchObject({ start: 0, end: 5, layout: "stream" });
  });

  it("counts stream shots", () => {
    expect(planLayoutCounts(v2)).toEqual({
      single: 0,
      split: 0,
      center: 1,
      stream: 1,
    });
  });

  it("still rejects an unknown version", () => {
    expect(sliceCropPlan({ ...v2, version: 3 as 2 }, 0, 10)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-plan.test.ts
```

Expected: FAIL - `planLayoutCounts` returns an object without `stream`, and `sliceCropPlan` returns null for version 2.

- [ ] **Step 3: Widen the version guard**

In `apps/worker/src/reframe/plan.ts`, inside `sliceCropPlan`, replace:

```ts
    plan.version !== 1 ||
```

with:

```ts
    (plan.version !== 1 && plan.version !== 2) ||
```

The existing `return { ...plan, shots }` already carries `stream` and `profile` through, so nothing else changes.

- [ ] **Step 4: Add the stream counter**

Replace `planLayoutCounts` with:

```ts
export function planLayoutCounts(
  plan: CropPlan
): Record<"single" | "split" | "center" | "stream", number> {
  const counts = { single: 0, split: 0, center: 0, stream: 0 };
  for (const s of plan.shots) counts[s.layout] += 1;
  return counts;
}
```

- [ ] **Step 5: Run the tests and confirm green**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-plan.test.ts
```

Expected: PASS, 29 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/reframe/plan.ts apps/worker/src/__tests__/reframe-plan.test.ts
git commit -m "feat(reframe): slice and count v2 plans

Stored v1 plans on existing Clip rows keep rendering unchanged."
```

---

# Phase 3 - Detecting the inset

### Task 5: Webcam rectangle detection in the sidecar

Spec §5.2. Runs on the frames already extracted for face detection. No new dependencies: OpenCV 4.12.0 and numpy 2.3.5 are already in the image (verified).

**Files:**
- Modify: `apps/worker/assets/reframe/detect_faces.py`
- Create: `apps/worker/assets/reframe/test_cam_rect.py`
- Create: `apps/worker/assets/reframe/testdata/pip-gameplay.jpg`, `pip-scoreboard.jpg`, `no-cam-ad.jpg`

- [ ] **Step 1: Build the committed test frames**

The 1 GB source VOD is gitignored and must not be committed. Three 640-wide frames are enough and total well under 200 KB. Full-resolution frames were already extracted to `apps/worker/eval-media/frames/`:

```bash
docker compose exec -T worker-render sh -lc '
set -e
D=/app/apps/worker/assets/reframe/testdata; mkdir -p $D
for pair in "t600 pip-gameplay" "t1815 pip-scoreboard" "t735 no-cam-ad"; do
  set -- $pair
  ffmpeg -nostdin -v error -i /app/apps/worker/eval-media/frames/$1.jpg \
    -vf scale=640:-2 -q:v 4 $D/$2.jpg -y
done
ls -la $D'
```

Expected: three files, each roughly 30-60 KB. If `eval-media/frames/` is gone, re-extract from any stream VOD with a corner inset - the tests assert a rectangle *shape*, and the expected values in Step 3 must then be re-derived from the new frames and the change noted in the commit.

- [ ] **Step 2: Write the failing test**

Create `apps/worker/assets/reframe/test_cam_rect.py`:

```python
import os
import unittest

import cv2
import numpy as np

import detect_faces as df

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "testdata")


def load(name):
    img = cv2.imread(os.path.join(DATA, name), cv2.IMREAD_GRAYSCALE)
    assert img is not None, name
    return img


class TestEdgeMap(unittest.TestCase):
    def test_flat_image_has_no_edges(self):
        flat = np.full((360, 640), 128, np.uint8)
        vx, hy = df.median_edge_map([flat])
        self.assertAlmostEqual(float(np.mean(vx)), 0.0, places=3)
        self.assertAlmostEqual(float(np.mean(hy)), 0.0, places=3)

    def test_median_suppresses_a_transient_edge(self):
        base = np.full((360, 640), 128, np.uint8)
        moving = base.copy()
        moving[:, 300:] = 20  # a hard edge present in ONE frame of five
        vx, _ = df.median_edge_map([base, base, moving, base, base])
        self.assertLess(float(np.max(vx[:, 295:305])), 1.0)

    def test_median_keeps_a_persistent_edge(self):
        frames = []
        for shift in range(5):
            f = np.full((360, 640), 128, np.uint8)
            f[:, 300:] = 20  # same edge every frame
            f[shift * 10 : shift * 10 + 5, :] = 200  # noise that moves
            frames.append(f)
        vx, _ = df.median_edge_map(frames)
        self.assertGreater(float(np.max(vx[:, 295:305])), 50.0)


class TestFindCamRect(unittest.TestCase):
    def test_finds_the_corner_inset_on_gameplay(self):
        img = load("pip-gameplay.jpg")
        h, w = img.shape[:2]
        vx, hy = df.median_edge_map([img])
        # Face box in 640-wide detection pixels: source 179,110,43,56 halved.
        rect = df.find_cam_rect(vx, hy, (90, 55, 22, 28), w, h, 0.5, 3.0)
        self.assertIsNotNone(rect)
        # Inset is one third of the frame, flush to the top-left corner.
        self.assertLess(rect["x"], 0.03 * w)
        self.assertLess(rect["y"], 0.03 * h)
        self.assertAlmostEqual(rect["w"] / w, 1 / 3, delta=0.06)
        self.assertAlmostEqual(rect["h"] / h, 1 / 3, delta=0.06)

    def test_agrees_across_two_different_moments(self):
        boxes = {"pip-gameplay.jpg": (90, 55, 22, 28),
                 "pip-scoreboard.jpg": (90, 55, 22, 28)}
        rects = []
        for name, face in boxes.items():
            img = load(name)
            h, w = img.shape[:2]
            vx, hy = df.median_edge_map([img])
            r = df.find_cam_rect(vx, hy, face, w, h, 0.5, 3.0)
            self.assertIsNotNone(r, name)
            rects.append(r)
        for key in ("x", "y", "w", "h"):
            self.assertLess(abs(rects[0][key] - rects[1][key]), 0.02 * 640, key)

    def test_returns_none_on_a_flat_frame(self):
        flat = np.full((360, 640), 128, np.uint8)
        vx, hy = df.median_edge_map([flat])
        self.assertIsNone(df.find_cam_rect(vx, hy, (90, 55, 22, 28), 640, 360, 0.5, 3.0))

    def test_rejects_a_rectangle_larger_than_the_cap(self):
        img = load("pip-gameplay.jpg")
        h, w = img.shape[:2]
        vx, hy = df.median_edge_map([img])
        # A 5% cap admits no rectangle that could contain the face.
        self.assertIsNone(df.find_cam_rect(vx, hy, (90, 55, 22, 28), w, h, 0.05, 3.0))

    def test_rejects_everything_at_an_impossible_energy_bar(self):
        img = load("pip-gameplay.jpg")
        h, w = img.shape[:2]
        vx, hy = df.median_edge_map([img])
        self.assertIsNone(df.find_cam_rect(vx, hy, (90, 55, 22, 28), w, h, 0.5, 1e6))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run it and watch it fail**

```bash
docker compose exec -T worker-render python3 -m unittest discover -s /app/apps/worker/assets/reframe -p 'test_*.py' -v
```

Expected: FAIL with `AttributeError: module 'detect_faces' has no attribute 'median_edge_map'`.

- [ ] **Step 4: Implement detection**

In `apps/worker/assets/reframe/detect_faces.py`, add below the existing constants:

```python
EDGE_SAMPLE_MAX = 24     # frames fed to the median edge map
BORDER_CANDIDATES = 12   # strongest projection peaks kept per axis
MIN_RECT_PX = 16         # a rectangle thinner than this is noise
FACE_MARGIN_FRAC = 0.02  # rect must clear the face by this much of frame width


def median_edge_map(grays):
    """Per-pixel MEDIAN Sobel magnitude across frames.

    Median, not mean: moving game content contributes a strong edge in only
    some frames and is suppressed, while a static compositing border survives.
    """
    xs, ys = [], []
    for g in grays:
        if g is None:
            continue
        xs.append(np.abs(cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)))
        ys.append(np.abs(cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)))
    if not xs:
        return None, None
    return np.median(np.stack(xs), axis=0), np.median(np.stack(ys), axis=0)


def _peaks(proj, limit):
    med = float(np.median(proj))
    out = []
    for i in range(1, len(proj) - 1):
        if proj[i] > med and proj[i] >= proj[i - 1] and proj[i] >= proj[i + 1]:
            out.append(i)
    out.sort(key=lambda i: -float(proj[i]))
    return out[:limit]


def find_cam_rect(vx, hy, face, W, H, pip_max_frac, edge_min):
    """Face-anchored rectangle search scored by border edge energy.

    face is (x, y, w, h) in the SAME pixel space as vx/hy. Returns a dict with
    x, y, w, h, score in that space, or None.
    """
    if vx is None or hy is None:
        return None
    gmean = (float(np.mean(vx)) + float(np.mean(hy))) / 2.0
    if gmean <= 1e-6:
        return None
    fx, fy, fw, fh = face
    margin = FACE_MARGIN_FRAC * W
    need_x0, need_y0 = fx - margin, fy - margin
    need_x1, need_y1 = fx + fw + margin, fy + fh + margin
    face_area = max(1.0, fw * fh)
    max_w = pip_max_frac * W

    xs = sorted(set([0, W] + _peaks(vx.sum(axis=0), BORDER_CANDIDATES)))
    ys = sorted(set([0, H] + _peaks(hy.sum(axis=1), BORDER_CANDIDATES)))

    best = None
    for x0 in xs:
        if x0 > need_x0:
            continue
        for x1 in xs:
            if x1 < need_x1 or x1 - x0 < MIN_RECT_PX or x1 - x0 > max_w:
                continue
            for y0 in ys:
                if y0 > need_y0:
                    continue
                for y1 in ys:
                    if y1 < need_y1 or y1 - y0 < MIN_RECT_PX:
                        continue
                    if (x1 - x0) * (y1 - y0) < 4.0 * face_area:
                        continue
                    left = float(np.mean(vx[y0:y1, min(x0, W - 1)]))
                    right = float(np.mean(vx[y0:y1, min(max(x1 - 1, 0), W - 1)]))
                    top = float(np.mean(hy[min(y0, H - 1), x0:x1]))
                    bottom = float(np.mean(hy[min(max(y1 - 1, 0), H - 1), x0:x1]))
                    # MINIMUM, not mean: one weak side must reject the
                    # rectangle rather than be averaged into acceptance.
                    score = min(left, right, top, bottom) / gmean
                    if best is None or score > best["score"]:
                        best = {"x": x0, "y": y0, "w": x1 - x0,
                                "h": y1 - y0, "score": score}
    if best is None or best["score"] < edge_min:
        return None
    return best
```

- [ ] **Step 5: Run the tests and confirm green**

```bash
docker compose exec -T worker-render python3 -m unittest discover -s /app/apps/worker/assets/reframe -p 'test_*.py' -v
```

Expected: PASS, 8 tests. If `test_finds_the_corner_inset_on_gameplay` fails on the size assertion, print the returned rect and check it against `apps/worker/eval-media/grid.jpg` before touching the tolerance - the inset is genuinely one third of the frame in this fixture.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/assets/reframe/detect_faces.py apps/worker/assets/reframe/test_cam_rect.py apps/worker/assets/reframe/testdata
git commit -m "feat(reframe): detect the webcam inset in the sidecar

Median Sobel magnitude across sampled frames suppresses moving game content
and keeps static compositing borders. Rectangles are anchored on the face and
scored by the MINIMUM of their four border energies, so one weak side rejects
rather than averages. OpenCV and numpy were already in the image."
```

---

### Task 6: Emit the rect from the sidecar and validate it in TypeScript

**Files:**
- Modify: `apps/worker/assets/reframe/detect_faces.py` (CLI + output)
- Modify: `apps/worker/src/reframe/faces.ts`
- Test: `apps/worker/src/__tests__/reframe-faces.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/__tests__/reframe-faces.test.ts`:

```ts
describe("camRect in the sidecar contract", () => {
  const track = {
    id: 0,
    box: { x: 179, y: 110, w: 43, h: 56 },
    score: 0.89,
    samples: 111,
    mouthActivity: 0.05,
  };

  it("parses a camRect when present", () => {
    const raw = JSON.stringify({
      shots: [
        {
          shotIndex: 0,
          tracks: [track],
          camRect: { x: 0, y: 0, w: 428, h: 240, score: 4.7 },
        },
      ],
    });
    const parsed = parseDetectorOutput(raw, 1);
    expect(parsed[0].camRect).toEqual({ x: 0, y: 0, w: 428, h: 240, score: 4.7 });
  });

  it("treats an absent camRect as null, not as a violation", () => {
    const raw = JSON.stringify({
      shots: [{ shotIndex: 0, tracks: [track] }],
    });
    expect(parseDetectorOutput(raw, 1)[0].camRect).toBeNull();
  });

  it("rejects a malformed camRect", () => {
    const raw = JSON.stringify({
      shots: [
        { shotIndex: 0, tracks: [track], camRect: { x: 0, y: 0, w: "wide" } },
      ],
    });
    expect(() => parseDetectorOutput(raw, 1)).toThrow("detector_invalid_json");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-faces.test.ts
```

Expected: FAIL - `camRect` is undefined on the parsed shot.

- [ ] **Step 3: Extend the `ShotTracks` type**

In `apps/worker/src/reframe/types.ts`, replace the `ShotTracks` interface:

```ts
export interface ShotTracks {
  shotIndex: number;
  tracks: FaceTrack[];
  /** Null when the sidecar found no inset, or is an older build. */
  camRect: CamRect | null;
}
```

This breaks the `withTracks` helper at the top of `apps/worker/src/__tests__/reframe-plan.test.ts`, which builds `ShotTracks` literals. Update it now:

```ts
const withTracks = (tracks: FaceTrack[]): ShotTracks[] => [
  { shotIndex: 0, tracks, camRect: null },
];
```

- [ ] **Step 4: Validate it in `parseDetectorOutput`**

In `apps/worker/src/reframe/faces.ts`, inside the `shots.map` callback, after the `tracks` mapping and before the return, insert:

```ts
    const rawRect = (s as { camRect?: unknown }).camRect;
    let camRect: CamRect | null = null;
    if (rawRect != null) {
      const r = rawRect as Record<string, unknown>;
      if (!num(r.x) || !num(r.y) || !num(r.w) || !num(r.h) || !num(r.score)) {
        throw new Error("detector_invalid_json");
      }
      camRect = { x: r.x, y: r.y, w: r.w, h: r.h, score: r.score };
    }
```

Change the return to `return { shotIndex: st.shotIndex, tracks, camRect };` and add `CamRect` to the type import at the top of the file.

- [ ] **Step 5: Emit it from the sidecar**

In `detect_faces.py`, add the new arguments after `--min-score`:

```python
    ap.add_argument("--face-small-frac", type=float, default=0.06)
    ap.add_argument("--pip-max-frac", type=float, default=0.50)
    ap.add_argument("--pip-edge-min", type=float, default=3.0)
```

Collect grayscale frames for the edge map while the existing loop runs. Immediately after `gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)` add:

```python
        if len(edge_frames) < EDGE_SAMPLE_MAX:
            edge_frames.append(gray)
```

and initialise `edge_frames = []` next to `states = [...]`.

Then, in the output loop, compute the rect once and attach it to every shot whose dominant face is small enough to warrant it. Replace the `out["shots"].append(...)` line with:

```python
        rect = None
        if rendered:
            dom = max(rendered, key=lambda t: t["samples"])
            if dom["box"]["w"] <= args.face_small_frac * args.source_width:
                if edge_vx is None:
                    edge_vx, edge_hy = median_edge_map(edge_frames)
                face = (dom["box"]["x"] / scale, dom["box"]["y"] / scale,
                        dom["box"]["w"] / scale, dom["box"]["h"] / scale)
                r = find_cam_rect(edge_vx, edge_hy, face, det_w, det_h,
                                  args.pip_max_frac, args.pip_edge_min)
                if r is not None:
                    rect = {"x": r["x"] * scale, "y": r["y"] * scale,
                            "w": r["w"] * scale, "h": r["h"] * scale,
                            "score": r["score"]}
        out["shots"].append({"shotIndex": i, "tracks": rendered, "camRect": rect})
```

Initialise `edge_vx = edge_hy = None` and `det_w = det_h = 0` before the frame loop, and set `det_w, det_h = w, h` where `scale` is currently assigned. The gate means podcasts and facecams never pay for the edge map at all.

- [ ] **Step 6: Pass the knobs through `detectFaces`**

In `apps/worker/src/reframe/faces.ts`, add three arguments to the `python3` argv, after `--min-score`:

```ts
        "--face-small-frac", String(cfg.faceSmallFrac),
        "--pip-max-frac", String(cfg.pipMaxFrac),
        "--pip-edge-min", String(cfg.pipEdgeMin),
```

Those three config fields do not exist yet. Add them now so the file compiles - in `apps/worker/src/reframe/config.ts`, append to the `ReframeConfig` interface:

```ts
  pipMaxFrac: number;
  pipEdgeMin: number;
  faceSmallFrac: number;
```

and to the object returned by `loadReframeConfig`, importing `DEFAULT_PLAN_OPTIONS` from `./options` so the shared threshold has exactly one source of truth:

```ts
    pipMaxFrac: positive(env.REFRAME_PIP_MAX_FRAC, 0.5),
    pipEdgeMin: positive(env.REFRAME_PIP_EDGE_MIN, 3.0),
    faceSmallFrac: positive(
      env.REFRAME_FACE_SMALL_FRAC,
      DEFAULT_PLAN_OPTIONS.faceSmallFrac
    ),
```

Task 9 rewrites this file in full and adds the remaining knobs; these three are only what this task needs to typecheck.

- [ ] **Step 7: Run both suites**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-faces.test.ts
docker compose exec -T worker-render python3 -m unittest discover -s /app/apps/worker/assets/reframe -p 'test_*.py' -v
```

Expected: both PASS.

- [ ] **Step 8: Verify end to end against the real fixture**

```bash
docker compose exec -T worker-render sh -lc '
set -e
W=/tmp/rectchk; rm -rf $W; mkdir -p $W/frames
ffmpeg -nostdin -v error -ss 600 -to 660 -i /app/apps/worker/eval-media/stream-cs2.mp4 \
  -vf "fps=2,scale=640:-2" -q:v 5 $W/frames/frame-%05d.jpg -y
echo "[{\"start\":0,\"end\":60}]" > $W/shots.json
python3 /app/apps/worker/assets/reframe/detect_faces.py \
  --frames-dir $W/frames --shots $W/shots.json --fps 2 \
  --model /app/apps/worker/assets/reframe/face_detection_yunet_2023mar.onnx \
  --min-score 0.7 --source-width 1280 --source-height 720' | python3 -m json.tool | tail -20
```

Expected: a `camRect` near `{x: 0, y: 0, w: 427, h: 240}` in source pixels. If it is absent, lower `--pip-edge-min` in the command until it appears and record the value that works - that number becomes the evidence for the default, replacing the provisional 3.0.

- [ ] **Step 9: Commit**

```bash
git add apps/worker/assets/reframe/detect_faces.py apps/worker/src/reframe/faces.ts apps/worker/src/reframe/types.ts apps/worker/src/__tests__/reframe-faces.test.ts
git commit -m "feat(reframe): sidecar reports the webcam inset

Gated on a small dominant face, so podcasts and facecams never build the
edge map. An absent camRect parses as null rather than as a contract
violation, so an older sidecar cannot break a newer worker."
```

---

### Task 7: One rect per clip

Spec §5.4. Per-shot rects are collected; the clip gets the median only if the shots agree.

**Files:**
- Create: `apps/worker/src/reframe/cam-rect.ts`
- Test: `apps/worker/src/__tests__/reframe-cam-rect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/reframe-cam-rect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveCamRect } from "../reframe/cam-rect";
import type { CamRect } from "../reframe/types";

const r = (x: number, w: number): CamRect => ({ x, y: 0, w, h: 240, score: 4 });

describe("resolveCamRect", () => {
  it("reports no rect when nothing was found", () => {
    expect(resolveCamRect([null, null, null], 1280)).toEqual({
      rect: null,
      reason: "stream_no_rect",
    });
  });

  it("takes the median when the shots agree", () => {
    const got = resolveCamRect([r(0, 427), r(1, 428), r(0, 426)], 1280);
    expect(got.rect).toMatchObject({ x: 0, w: 428 });
    expect(got.reason).toBeUndefined();
  });

  it("snaps outward to even so the crop never exceeds the inset", () => {
    const got = resolveCamRect([r(3, 427), r(3, 427), r(3, 427)], 1280).rect!;
    expect(got.x % 2).toBe(0);
    expect(got.w % 2).toBe(0);
    expect(got.x).toBeLessThanOrEqual(3);
    expect(got.x + got.w).toBeGreaterThanOrEqual(3 + 427);
  });

  it("distinguishes a composition that MOVES from one that was never found", () => {
    // Half the shots put the inset left, half put it right: found, but unstable.
    expect(
      resolveCamRect([r(0, 428), r(0, 428), r(800, 428), r(800, 428)], 1280)
    ).toEqual({ rect: null, reason: "stream_rect_unstable" });
  });

  it("reports no rect when fewer than half the shots found anything", () => {
    expect(resolveCamRect([r(0, 428), null, null, null], 1280)).toEqual({
      rect: null,
      reason: "stream_no_rect",
    });
  });

  it("keeps the rect inside the frame", () => {
    const got = resolveCamRect([r(1200, 200), r(1200, 200)], 1280).rect!;
    expect(got.x + got.w).toBeLessThanOrEqual(1280);
  });
});
```

The two null cases are deliberately distinguishable: "there is no inset here" and "the inset moved mid-clip" are different facts about a source, and §11 exists to count them separately once real users upload anything.

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-cam-rect.test.ts
```

Expected: FAIL, `Failed to resolve import "../reframe/cam-rect"`.

- [ ] **Step 3: Implement it**

Create `apps/worker/src/reframe/cam-rect.ts`:

```ts
import type { CamRect } from "./types";

/** Shots may disagree by this much of frame width and still count as agreeing. */
const AGREE_TOL_FRAC = 0.02;

export interface CamRectResolution {
  rect: CamRect | null;
  /** Why there is no rect. Absent when one was resolved. */
  reason?: "stream_no_rect" | "stream_rect_unstable";
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Collapses per-shot rects into one clip-level rect. The inset is static in
 * real OBS scenes, so disagreement means the scene composition changes
 * mid-clip - and that is a reason to decline, not to average.
 */
export function resolveCamRect(
  perShot: Array<CamRect | null>,
  sourceWidth: number
): CamRectResolution {
  const found = perShot.filter((r): r is CamRect => r !== null);
  if (found.length === 0 || found.length * 2 < perShot.length) {
    return { rect: null, reason: "stream_no_rect" };
  }

  const rect = {
    x: median(found.map((r) => r.x)),
    y: median(found.map((r) => r.y)),
    w: median(found.map((r) => r.w)),
    h: median(found.map((r) => r.h)),
    score: median(found.map((r) => r.score)),
  };

  const tol = AGREE_TOL_FRAC * sourceWidth;
  const agree = found.filter(
    (r) =>
      Math.abs(r.x - rect.x) <= tol &&
      Math.abs(r.y - rect.y) <= tol &&
      Math.abs(r.w - rect.w) <= tol &&
      Math.abs(r.h - rect.h) <= tol
  );
  if (agree.length * 2 < perShot.length) {
    return { rect: null, reason: "stream_rect_unstable" };
  }

  // Snap outward: the crop must never be asked for a pixel the inset lacks.
  const x = Math.max(0, 2 * Math.floor(rect.x / 2));
  const y = Math.max(0, 2 * Math.floor(rect.y / 2));
  const w = 2 * Math.ceil((rect.x + rect.w - x) / 2);
  const h = 2 * Math.ceil((rect.y + rect.h - y) / 2);
  return {
    rect: {
      x,
      y,
      w: Math.min(w, 2 * Math.floor((sourceWidth - x) / 2)),
      h,
      score: rect.score,
    },
  };
}
```

- [ ] **Step 4: Run the tests and confirm green**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-cam-rect.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/reframe/cam-rect.ts apps/worker/src/__tests__/reframe-cam-rect.test.ts
git commit -m "feat(reframe): resolve one webcam rect per clip

Disagreement across shots means the scene composition changes mid-clip,
which is a reason to decline the stream layout rather than to average."
```

---

# Phase 4 - Wiring it together

### Task 8: Classify the source and emit the stream layout

Spec §4 and §6.4.

**Files:**
- Modify: `apps/worker/src/reframe/plan.ts`
- Test: `apps/worker/src/__tests__/reframe-plan.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/__tests__/reframe-plan.test.ts`:

```ts
describe("stream layout", () => {
  const SW = 1280;
  const SH = 720;
  const camRect = { x: 0, y: 0, w: 428, h: 240, score: 4.7 };
  const camRes = { rect: camRect };
  const streamOpts = {
    faceSmallFrac: 0.06,
    faceLargeFrac: 0.1,
    stream: true,
    camShare: 0.4,
  };
  // Face measured on the fixture: 43x56 at (179,110), 3.4% of frame width.
  const insetFace: FaceTrack = {
    id: 0,
    box: { x: 179, y: 110, w: 43, h: 56 },
    score: 0.89,
    samples: 111,
    mouthActivity: 0.05,
  };

  it("emits a stream layout with the solved geometry", () => {
    const plan = buildCropPlan(
      oneShot,
      withTracks([insetFace]),
      SW,
      SH,
      streamOpts,
      camRes
    );
    expect(plan?.version).toBe(2);
    expect(plan?.profile?.class).toBe("stream");
    expect(plan?.stream).toEqual({
      camCrop: { w: 336, h: 240, y: 0 },
      contentCrop: { w: 676, h: 720 },
      outCamH: 770,
      outContentH: 1150,
    });
    expect(plan?.shots[0]).toMatchObject({
      layout: "stream",
      cam: { x: 34 },
      content: { x: 428 },
    });
  });

  it("falls back to center when the killswitch is off", () => {
    const plan = buildCropPlan(
      oneShot,
      withTracks([insetFace]),
      SW,
      SH,
      { ...streamOpts, stream: false },
      camRes
    );
    expect(plan?.shots[0].layout).toBe("center");
    expect(plan?.profile?.class).toBe("small_face");
    expect(plan?.profile?.reason).toBe("stream_disabled");
  });

  it("propagates an unstable rect as its own reason, not as 'no rect'", () => {
    const plan = buildCropPlan(oneShot, withTracks([insetFace]), SW, SH, streamOpts, {
      rect: null,
      reason: "stream_rect_unstable",
    });
    expect(plan?.profile?.reason).toBe("stream_rect_unstable");
  });

  it("centres a shot that has no face inside the inset", () => {
    // Second shot's face sits in the game area, not in the webcam.
    const shots: Shot[] = [
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ];
    const tracks: ShotTracks[] = [
      { shotIndex: 0, tracks: [insetFace], camRect },
      {
        shotIndex: 1,
        tracks: [{ ...insetFace, box: { x: 900, y: 400, w: 43, h: 56 } }],
        camRect,
      },
    ];
    const plan = buildCropPlan(shots, tracks, SW, SH, streamOpts, camRes);
    expect(plan?.shots[0].layout).toBe("stream");
    expect(plan?.shots[1].layout).toBe("center");
  });

  it("never mixes stream and split in one plan", () => {
    const wide: FaceTrack[] = [
      { ...insetFace, box: { x: 40, y: 200, w: 200, h: 260 } },
      { ...insetFace, id: 1, box: { x: 1000, y: 200, w: 200, h: 260 } },
    ];
    const shots: Shot[] = [
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ];
    const plan = buildCropPlan(
      shots,
      [
        { shotIndex: 0, tracks: [insetFace], camRect },
        { shotIndex: 1, tracks: wide, camRect },
      ],
      SW,
      SH,
      streamOpts,
      camRes
    );
    const kinds = new Set(plan!.shots.map((s) => s.layout));
    expect(kinds.has("stream") && kinds.has("split")).toBe(false);
  });

  it("declines the stream layout when no share fits the free band", () => {
    const centred = { x: 320, y: 0, w: 640, h: 360, score: 4 };
    const plan = buildCropPlan(
      oneShot,
      withTracks([{ ...insetFace, box: { x: 600, y: 150, w: 43, h: 56 } }]),
      SW,
      SH,
      streamOpts,
      { rect: centred }
    );
    expect(plan?.shots[0].layout).toBe("center");
    expect(plan?.profile?.reason).toBe("stream_no_fit");
  });
});
```

Note: `withTracks` in the existing test file must be updated to include `camRect: null`, since `ShotTracks` gained the field in Task 6:

```ts
const withTracks = (tracks: FaceTrack[]): ShotTracks[] => [
  { shotIndex: 0, tracks, camRect: null },
];
```

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-plan.test.ts
```

Expected: FAIL - `buildCropPlan` takes no sixth argument and emits no `stream` layout.

- [ ] **Step 3: Implement classification and emission**

In `apps/worker/src/reframe/plan.ts`, extend the imports:

```ts
import {
  freeBand,
  solveStreamGeometry,
  streamCamX,
  streamContentX,
} from "./stream-geometry";
import type {
  CamRect,
  CropPlan,
  FaceTrack,
  Shot,
  ShotLayout,
  ShotTracks,
  SourceProfile,
  StreamGeometry,
} from "./types";
```

Extend the signature:

```ts
export function buildCropPlan(
  shots: Shot[],
  tracksByShot: ShotTracks[],
  sourceWidth: number,
  sourceHeight: number,
  opts: PlanOptions = DEFAULT_PLAN_OPTIONS,
  cam: CamRectResolution | null = null
): CropPlan | null {
```

and add `import type { CamRectResolution } from "./cam-rect";`.

After `const byIndex = ...`, insert the classification block:

```ts
  const camRect = cam?.rect ?? null;
  const allTracks = tracksByShot.flatMap((s) => s.tracks);
  const widestFace = Math.max(0, ...allTracks.map((t) => t.box.w));
  const faceFrac = sourceWidth > 0 ? widestFace / sourceWidth : 0;
  const minFaceWidth = opts.faceSmallFrac * sourceWidth;

  let streamGeom: StreamGeometry | null = null;
  let contentX = centerX;
  let profile: SourceProfile;

  if (allTracks.length === 0) {
    profile = { class: "faceless", faceFrac };
  } else if (widestFace >= minFaceWidth) {
    profile = { class: "normal_face", faceFrac };
  } else if (!camRect) {
    // "no inset here" and "the inset moved" are different facts about a
    // source, and section 11 counts them separately.
    profile = {
      class: "small_face",
      faceFrac,
      reason: cam?.reason ?? "stream_no_rect",
    };
  } else if (!opts.stream) {
    profile = { class: "small_face", faceFrac, reason: "stream_disabled",
                camRectScore: camRect.score };
  } else {
    streamGeom = solveStreamGeometry({
      sourceWidth,
      sourceHeight,
      camRect,
      camShare: opts.camShare,
    });
    if (!streamGeom) {
      profile = { class: "small_face", faceFrac, reason: "stream_no_fit",
                  camRectScore: camRect.score };
    } else {
      profile = { class: "stream", faceFrac, camRectScore: camRect.score };
      contentX = streamContentX(
        freeBand(camRect, sourceWidth),
        streamGeom.contentCrop.w,
        sourceWidth,
        sourceWidth / 2
      );
    }
  }
```

Inside the `shots.map` callback, immediately before the existing min-face guard, insert the stream branch:

```ts
    if (streamGeom && camRect) {
      // A shot only splits if it actually shows the streamer: advertisement
      // cards, intermissions and replays have no face inside the inset.
      const inInset = shotTracks.find(
        (t) =>
          t.box.x >= camRect.x - 2 &&
          t.box.x + t.box.w <= camRect.x + camRect.w + 2 &&
          t.box.y >= camRect.y - 2 &&
          t.box.y + t.box.h <= camRect.y + camRect.h + 2
      );
      if (!inInset) {
        return { start: shot.start, end: shot.end, layout: "center", x: centerX };
      }
      return {
        start: shot.start,
        end: shot.end,
        layout: "stream",
        cam: {
          x: streamCamX(
            camRect,
            streamGeom.camCrop.w,
            inInset.box.x + inInset.box.w / 2
          ),
        },
        content: { x: contentX },
      };
    }
```

Because that branch returns before any `single`/`split` can be produced, the "never mix stream and split" invariant holds by construction.

Finally, replace the return with:

```ts
  return {
    version: streamGeom ? 2 : 1,
    engine: "faces",
    source: { width: sourceWidth, height: sourceHeight },
    profile,
    ...(streamGeom ? { stream: streamGeom } : {}),
    shots: merged,
  };
```

- [ ] **Step 4: Extend the merge rule**

In `mergeAdjacentLayouts`, add a fourth clause to the `same` expression:

```ts
        (prev.layout === "stream" &&
          shot.layout === "stream" &&
          Math.abs(prev.cam.x - shot.cam.x) <= maxDx &&
          Math.abs(prev.content.x - shot.content.x) <= maxDx);
```

- [ ] **Step 5: Run the tests and confirm green**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-plan.test.ts
```

Expected: PASS, 34 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/reframe/plan.ts apps/worker/src/__tests__/reframe-plan.test.ts
git commit -m "feat(reframe): classify the source and emit the stream layout

The rect is resolved once per clip; each shot decides for itself whether it
shows the streamer, so ad cards and replays centre instead of splitting."
```

---

### Task 9: Config knobs and the killswitch

Spec §10.

**Files:**
- Modify: `apps/worker/src/reframe/config.ts`
- Test: `apps/worker/src/__tests__/reframe-config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/__tests__/reframe-config.test.ts`:

```ts
describe("stream knobs", () => {
  it("defaults to the stream layout being OFF", () => {
    const cfg = loadReframeConfig({});
    expect(cfg.stream).toBe(false);
    expect(cfg.camShare).toBe(0.4);
    expect(cfg.faceSmallFrac).toBe(0.06);
    expect(cfg.faceLargeFrac).toBe(0.1);
    expect(cfg.pipMaxFrac).toBe(0.5);
    expect(cfg.pipEdgeMin).toBe(3.0);
  });

  it("enables the stream layout only on the exact literal", () => {
    expect(loadReframeConfig({ REFRAME_STREAM: "on" }).stream).toBe(true);
    expect(loadReframeConfig({ REFRAME_STREAM: "true" }).stream).toBe(false);
  });

  it("overrides numeric knobs", () => {
    const cfg = loadReframeConfig({
      REFRAME_CAM_SHARE: "0.35",
      REFRAME_PIP_EDGE_MIN: "2.2",
    });
    expect(cfg.camShare).toBe(0.35);
    expect(cfg.pipEdgeMin).toBe(2.2);
  });

  it("ignores a nonsense override rather than emitting a broken plan", () => {
    expect(loadReframeConfig({ REFRAME_CAM_SHARE: "banana" }).camShare).toBe(0.4);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-config.test.ts
```

Expected: FAIL - `cfg.stream` is undefined.

- [ ] **Step 3: Add the fields**

Replace `apps/worker/src/reframe/config.ts` in full. Note the three layout thresholds default from `DEFAULT_PLAN_OPTIONS` rather than repeating their literals: `options.ts` stays the single source of truth for what the engine believes, and `config.ts` only decides whether the environment overrides it.

```ts
import { DEFAULT_PLAN_OPTIONS } from "./options";

export interface ReframeConfig {
  engine: "off" | "faces";
  sampleFps: number;
  sceneThreshold: number;
  minShotSec: number;
  faceMinScore: number;
  maxDetectSec: number;
  /** Stream layout killswitch. Classification runs regardless. */
  stream: boolean;
  camShare: number;
  faceSmallFrac: number;
  faceLargeFrac: number;
  pipMaxFrac: number;
  pipEdgeMin: number;
}

function positive(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadReframeConfig(
  env: NodeJS.ProcessEnv = process.env
): ReframeConfig {
  return {
    engine: env.REFRAME_ENGINE === "faces" ? "faces" : "off",
    sampleFps: positive(env.REFRAME_SAMPLE_FPS, 2),
    sceneThreshold: positive(env.REFRAME_SCENE_THRESHOLD, 0.3),
    minShotSec: positive(env.REFRAME_MIN_SHOT_SEC, 1.0),
    faceMinScore: positive(env.REFRAME_FACE_MIN_SCORE, 0.7),
    maxDetectSec: positive(env.REFRAME_MAX_DETECT_SEC, 30),
    stream: env.REFRAME_STREAM === "on",
    camShare: positive(env.REFRAME_CAM_SHARE, DEFAULT_PLAN_OPTIONS.camShare),
    faceSmallFrac: positive(
      env.REFRAME_FACE_SMALL_FRAC,
      DEFAULT_PLAN_OPTIONS.faceSmallFrac
    ),
    faceLargeFrac: positive(
      env.REFRAME_FACE_LARGE_FRAC,
      DEFAULT_PLAN_OPTIONS.faceLargeFrac
    ),
    pipMaxFrac: positive(env.REFRAME_PIP_MAX_FRAC, 0.5),
    pipEdgeMin: positive(env.REFRAME_PIP_EDGE_MIN, 3.0),
  };
}
```

`pipMaxFrac` and `pipEdgeMin` keep their literals here: they are detector knobs, not layout thresholds, and `PlanOptions` has no business knowing them.

- [ ] **Step 4: Wire the rect into `computeCropPlan`**

In `apps/worker/src/reframe/index.ts`, add the imports:

```ts
import { resolveCamRect } from "./cam-rect";
```

and replace the `buildCropPlan` call:

```ts
    const cam = resolveCamRect(
      tracks.map((t) => t.camRect),
      width
    );
    const plan = buildCropPlan(
      shots,
      tracks,
      width,
      height,
      {
        faceSmallFrac: cfg.faceSmallFrac,
        faceLargeFrac: cfg.faceLargeFrac,
        stream: cfg.stream,
        camShare: cfg.camShare,
      },
      cam
    );
```

- [ ] **Step 5: Document the knobs**

Append to `.env.example`:

```bash
# Smart reframe - stream layout (spec 2026-08-02). Classification and telemetry
# run regardless; REFRAME_STREAM=on is what actually changes the picture.
REFRAME_STREAM=off
REFRAME_CAM_SHARE=0.40
REFRAME_FACE_SMALL_FRAC=0.06
REFRAME_FACE_LARGE_FRAC=0.10
REFRAME_PIP_MAX_FRAC=0.50
REFRAME_PIP_EDGE_MIN=3.0
```

- [ ] **Step 6: Run the tests and confirm green**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-config.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/reframe/config.ts apps/worker/src/reframe/index.ts apps/worker/src/__tests__/reframe-config.test.ts .env.example
git commit -m "feat(reframe): stream knobs, default off

Thresholds rest on a single fixture, so they are env-tunable and every
decision records its inputs in the plan."
```

---

### Task 10: The filtergraph branch

Spec §8. `setsar=1` after each `scale` is not optional - ffmpeg 8.x segfaults stacking these exact tile sizes without it.

**Files:**
- Modify: `apps/worker/src/reframe/filtergraph.ts`
- Test: `apps/worker/src/__tests__/reframe-filtergraph.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/__tests__/reframe-filtergraph.test.ts`:

```ts
describe("stream filtergraph", () => {
  const plan: CropPlan = {
    version: 2,
    engine: "faces",
    source: { width: 1280, height: 720 },
    stream: {
      camCrop: { w: 336, h: 240, y: 0 },
      contentCrop: { w: 676, h: 720 },
      outCamH: 770,
      outContentH: 1150,
    },
    shots: [
      { start: 0, end: 10, layout: "stream", cam: { x: 34 }, content: { x: 428 } },
      { start: 10, end: 20, layout: "center", x: 302 },
    ],
  };

  it("emits a complex graph with both tiles", () => {
    const spec = buildFiltergraph(plan);
    expect(spec.kind).toBe("complex");
    expect(spec.graph).toContain("crop=w=336:h=240");
    expect(spec.graph).toContain("scale=1080:770");
    expect(spec.graph).toContain("crop=w=676:h=ih");
    expect(spec.graph).toContain("scale=1080:1150");
  });

  it("pins SAR on every scaled tile", () => {
    // Without this ffmpeg 8.x segfaults while stacking these sizes.
    const graph = buildFiltergraph(plan).graph;
    expect(graph.match(/setsar=1/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("stacks the content tile directly under the cam tile", () => {
    expect(buildFiltergraph(plan).graph).toContain("overlay=x=0:y=770");
  });

  it("enables the tiles only on stream windows, half-open", () => {
    const graph = buildFiltergraph(plan).graph;
    expect(graph).toContain("gte(t,0.00)*lt(t,10.00)");
    expect(graph).not.toContain("between(");
  });

  it("appends the subtitle burn last", () => {
    const graph = buildFiltergraph(plan, "ass=x.ass").graph;
    expect(graph.endsWith("[o2]ass=x.ass[vout]")).toBe(true);
  });

  it("leaves a plan with no stream shots on the existing path", () => {
    const v1: CropPlan = {
      version: 1,
      engine: "faces",
      source: { width: 1920, height: 1080 },
      shots: [{ start: 0, end: 10, layout: "center", x: 656 }],
    };
    expect(buildFiltergraph(v1).kind).toBe("vf");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-filtergraph.test.ts
```

Expected: FAIL - the stream plan currently compiles to a `vf` graph.

- [ ] **Step 3: Implement the branch**

In `apps/worker/src/reframe/filtergraph.ts`, add after the `SplitLayout` type:

```ts
type StreamLayout = Extract<ShotLayout, { layout: "stream" }>;
```

Inside `buildFiltergraph`, immediately after `const splits = ...`, insert:

```ts
  const streams = plan.shots.filter(
    (s): s is StreamLayout => s.layout === "stream"
  );
  if (streams.length > 0 && plan.stream) {
    const geom = plan.stream;
    // Outside stream windows the tile overlays are disabled, so their x values
    // there are irrelevant - carry the nearest stream geometry forward so the
    // expressions stay total for every t.
    let lastCam = streams[0].cam.x;
    let lastContent = streams[0].content.x;
    const camSegs: Array<{ end: number; x: number }> = [];
    const contentSegs: Array<{ end: number; x: number }> = [];
    for (const s of plan.shots) {
      if (s.layout === "stream") {
        lastCam = s.cam.x;
        lastContent = s.content.x;
      }
      camSegs.push({ end: s.end, x: lastCam });
      contentSegs.push({ end: s.end, x: lastContent });
    }
    const enable = streams
      .map((s) => `gte(t,${fmt(s.start)})*lt(t,${fmt(s.end)})`)
      .join("+");
    const chains = [
      `[0:v]split=3[b0][c0][m0]`,
      `[b0]${baseChain}[base]`,
      `[c0]crop=w=${geom.camCrop.w}:h=${geom.camCrop.h}:x='${piecewiseX(camSegs)}':y=${geom.camCrop.y},scale=1080:${geom.outCamH},setsar=1[cam]`,
      `[m0]crop=w=${geom.contentCrop.w}:h=ih:x='${piecewiseX(contentSegs)}':y=0,scale=1080:${geom.outContentH},setsar=1[cont]`,
      `[base][cam]overlay=x=0:y=0:enable='${enable}'[o1]`,
      assSnippet
        ? `[o1][cont]overlay=x=0:y=${geom.outCamH}:enable='${enable}'[o2]`
        : `[o1][cont]overlay=x=0:y=${geom.outCamH}:enable='${enable}'[vout]`,
    ];
    if (assSnippet) chains.push(`[o2]${assSnippet}[vout]`);
    return { kind: "complex", graph: chains.join(";") };
  }
```

For non-stream shots the base chain already carries their own `x`; for stream shots `piecewiseX` receives the centre value, which is never visible because the overlays cover the full frame during those windows. Add `stream` to the ternary in `baseX` so it does not read a missing `.x`:

```ts
  const baseX = piecewiseX(
    plan.shots.map((s) => ({
      end: s.end,
      x: s.layout === "split" || s.layout === "stream" ? centerX : s.x,
    }))
  );
```

- [ ] **Step 4: Run the tests and confirm green**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-filtergraph.test.ts
```

Expected: PASS.

- [ ] **Step 5: Prove the graph actually encodes**

A green string test does not prove ffmpeg accepts the graph. Render two seconds from the fixture:

```bash
docker compose exec -T worker-render sh -lc '
ffmpeg -nostdin -v error -ss 600 -t 2 -i /app/apps/worker/eval-media/stream-cs2.mp4 \
 -filter_complex "[0:v]split=3[b0][c0][m0];\
[b0]crop=w=406:h=ih:x=437:y=0,scale=1080:1920,setsar=1[base];\
[c0]crop=w=336:h=240:x=34:y=0,scale=1080:770,setsar=1[cam];\
[m0]crop=w=676:h=ih:x=428:y=0,scale=1080:1150,setsar=1[cont];\
[base][cam]overlay=x=0:y=0:enable=1[o1];\
[o1][cont]overlay=x=0:y=770:enable=1[vout]" \
 -map "[vout]" -map 0:a -c:v libx264 -preset veryfast -t 2 \
 /app/apps/worker/eval-media/stream-proof.mp4 -y && echo ENCODE_OK'
```

Expected: `ENCODE_OK`. Then confirm the output really is 1080x1920:

```bash
docker compose exec -T worker-render ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height -of csv=s=x:p=0 \
  /app/apps/worker/eval-media/stream-proof.mp4
```

Expected: `1080x1920`.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/reframe/filtergraph.ts apps/worker/src/__tests__/reframe-filtergraph.test.ts
git commit -m "feat(reframe): stream branch of the filtergraph

setsar=1 after each scale is required: without it ffmpeg 8.x segfaults
stacking these exact tile sizes. Verified by encoding the real fixture."
```

---

### Task 11: Record the profile in render telemetry

Spec §11.

The existing render tests do not mock `../reframe`, so asserting this inside `render-clips-subtitles.test.ts` would mean adding a new mock to an already heavy file. Extract the check-building instead: it is pure, it is directly testable, and `render.ts` is 514 lines and does not need more.

**Files:**
- Create: `apps/worker/src/reframe/telemetry.ts`
- Modify: `apps/worker/src/stages/render.ts` (the `reframeChecks.push` at ~line 155 and the array type at ~line 100)
- Test: `apps/worker/src/__tests__/reframe-telemetry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/reframe-telemetry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildReframeCheck } from "../reframe/telemetry";
import type { CropPlan } from "../reframe/types";

const streamPlan: CropPlan = {
  version: 2,
  engine: "faces",
  source: { width: 1280, height: 720 },
  profile: { class: "stream", faceFrac: 0.034, camRectScore: 4.7 },
  stream: {
    camCrop: { w: 336, h: 240, y: 0 },
    contentCrop: { w: 676, h: 720 },
    outCamH: 770,
    outContentH: 1150,
  },
  shots: [
    { start: 0, end: 10, layout: "stream", cam: { x: 34 }, content: { x: 428 } },
  ],
};

describe("buildReframeCheck", () => {
  it("carries the profile and the layout counts", () => {
    expect(
      buildReframeCheck({ plan: streamPlan, shotCount: 1, detectMs: 900 })
    ).toEqual({
      shotCount: 1,
      detectMs: 900,
      layouts: { single: 0, split: 0, center: 0, stream: 1 },
      profile: { class: "stream", faceFrac: 0.034, camRectScore: 4.7 },
    });
  });

  it("records why there is no plan, and omits layouts entirely", () => {
    const check = buildReframeCheck({
      plan: null,
      shotCount: 3,
      detectMs: 120,
      fallbackReason: "timeout",
    });
    expect(check).toEqual({ shotCount: 3, detectMs: 120, fallbackReason: "timeout" });
    expect("layouts" in check).toBe(false);
  });

  it("keeps a v1 plan's counts and omits the absent profile", () => {
    const v1: CropPlan = {
      version: 1,
      engine: "faces",
      source: { width: 1920, height: 1080 },
      shots: [{ start: 0, end: 5, layout: "center", x: 656 }],
    };
    const check = buildReframeCheck({ plan: v1, shotCount: 1, detectMs: 50 });
    expect(check.layouts).toEqual({ single: 0, split: 0, center: 1, stream: 0 });
    expect("profile" in check).toBe(false);
  });

  it("marks a check as an encode failure without inventing layouts", () => {
    const check = buildReframeCheck({ plan: streamPlan, shotCount: 1, detectMs: 900 });
    expect(markEncodeFailed(check)).toEqual({
      shotCount: 1,
      detectMs: 900,
      profile: { class: "stream", faceFrac: 0.034, camRectScore: 4.7 },
      fallbackReason: "encode_failed",
    });
  });
});
```

Add `markEncodeFailed` to the import on line 2.

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-telemetry.test.ts
```

Expected: FAIL, `Failed to resolve import "../reframe/telemetry"`.

- [ ] **Step 3: Implement it**

Create `apps/worker/src/reframe/telemetry.ts`:

```ts
import { planLayoutCounts } from "./plan";
import type { CropPlan, SourceProfile } from "./types";

export interface ReframeCheck {
  shotCount: number;
  detectMs: number;
  layouts?: Record<"single" | "split" | "center" | "stream", number>;
  profile?: SourceProfile;
  fallbackReason?: string;
}

export interface ReframeCheckInput {
  plan: CropPlan | null;
  shotCount: number;
  detectMs: number;
  fallbackReason?: string;
}

/** Pure: what the render stage records about one reframe attempt. */
export function buildReframeCheck(input: ReframeCheckInput): ReframeCheck {
  return {
    shotCount: input.shotCount,
    detectMs: input.detectMs,
    ...(input.plan ? { layouts: planLayoutCounts(input.plan) } : {}),
    ...(input.plan?.profile ? { profile: input.plan.profile } : {}),
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
  };
}

/**
 * The plan was built but ffmpeg rejected it. The layout counts describe a
 * picture that was never produced, so they are dropped - but the profile
 * describes the SOURCE and stays, since that is what the encode failure is
 * evidence about.
 */
export function markEncodeFailed(check: ReframeCheck): ReframeCheck {
  const { layouts: _dropped, ...rest } = check;
  return { ...rest, fallbackReason: "encode_failed" };
}
```

- [ ] **Step 4: Use it in `render.ts`**

Replace the `reframeChecks.push({...})` call inside the reframe block with:

```ts
          reframeChecks.push(
            buildReframeCheck({
              plan: reframe.plan,
              shotCount: reframe.shotCount,
              detectMs: reframe.detectMs,
              fallbackReason: reframe.fallbackReason,
            })
          );
```

Replace the encode-failure mutation in the `catch` block:

```ts
        const idx = reframeChecks.length - 1;
        if (idx >= 0) reframeChecks[idx] = markEncodeFailed(reframeChecks[idx]);
```

Replace the inline `reframeChecks` array type declaration with `const reframeChecks: ReframeCheck[] = [];`, and import `buildReframeCheck`, `markEncodeFailed` and the `ReframeCheck` type from `../reframe/telemetry`. The `skipped_after_timeouts` push becomes `buildReframeCheck({ plan: null, shotCount: 0, detectMs: 0, fallbackReason: "skipped_after_timeouts" })`.

- [ ] **Step 5: Run the telemetry and render suites**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-telemetry.test.ts apps/worker/src/__tests__/render-clips-subtitles.test.ts apps/worker/src/__tests__/render-trim-fallback.test.ts
```

Expected: all PASS. The render tests exercise the same push sites, so a green run here is the regression check on the refactor.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/reframe/telemetry.ts apps/worker/src/stages/render.ts apps/worker/src/__tests__/reframe-telemetry.test.ts
git commit -m "feat(reframe): record the source profile in render telemetry

Check-building moves out of render.ts into a pure function, so what the
engine records about a source is testable without mocking the whole stage.
Substrate for answering which source shapes users actually upload with a
query rather than an opinion."
```

---

# Phase 5 - Making it checkable

### Task 12: The visual harness

Spec §12. Without this, every future framing decision is argued rather than seen.

**Files:**
- Create: `apps/worker/src/scripts/eval-reframe.ts`

- [ ] **Step 1: Write the harness**

Create `apps/worker/src/scripts/eval-reframe.ts`:

```ts
/**
 * Visual harness for the reframe engine.
 *
 *   npx tsx src/scripts/eval-reframe.ts <video> <start> <end> [outDir]
 *
 * Writes <outDir>/plan.json and <outDir>/sheet.jpg - the computed plan and a
 * contact sheet of frames rendered through it. Reframe decisions are checked
 * against pixels, not against argument.
 */
import { execFile } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { computeCropPlan } from "../reframe";
import { loadReframeConfig } from "../reframe/config";
import { buildFiltergraph } from "../reframe/filtergraph";

const execFileAsync = promisify(execFile);

async function main() {
  const [video, startArg, endArg, outArg] = process.argv.slice(2);
  if (!video || !startArg || !endArg) {
    console.error("usage: tsx src/scripts/eval-reframe.ts <video> <start> <end> [outDir]");
    process.exit(1);
  }
  const start = Number(startArg);
  const end = Number(endArg);
  const outDir = outArg || "/tmp/eval-reframe";
  await mkdir(outDir, { recursive: true });

  const cfg = { ...loadReframeConfig(), engine: "faces" as const };
  const result = await computeCropPlan(video, start, end, cfg);
  await writeFile(
    join(outDir, "plan.json"),
    JSON.stringify(result, null, 2),
    "utf-8"
  );
  console.log(
    `shots=${result.shotCount} detectMs=${result.detectMs} fallback=${result.fallbackReason ?? "none"}`
  );
  if (!result.plan) {
    console.log("no plan - nothing to render");
    return;
  }
  console.log(JSON.stringify(result.plan.profile ?? {}, null, 2));

  const spec = buildFiltergraph(result.plan);
  const frames = 6;
  const step = (end - start) / frames;
  for (let i = 0; i < frames; i++) {
    const t = start + step * i;
    const args = ["-nostdin", "-v", "error", "-ss", String(t), "-i", video, "-frames:v", "1"];
    if (spec.kind === "vf") args.push("-vf", `${spec.graph},setsar=1`);
    else args.push("-filter_complex", spec.graph, "-map", "[vout]");
    args.push("-q:v", "3", join(outDir, `f${i}.jpg`), "-y");
    await execFileAsync("ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 });
  }
  await execFileAsync("ffmpeg", [
    "-nostdin", "-v", "error",
    "-pattern_type", "glob", "-i", join(outDir, "f*.jpg"),
    "-filter_complex", "scale=270:480,setsar=1,tile=6x1",
    "-frames:v", "1", "-q:v", "3", join(outDir, "sheet.jpg"), "-y",
  ]);
  console.log(`wrote ${join(outDir, "sheet.jpg")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Note: the time-enabled `enable` expressions are clip-relative, so a single frame grabbed at absolute time `t` will not activate them. Grab through the whole clip instead when checking enable windows; for layout geometry the per-frame sheet is sufficient.

- [ ] **Step 2: Run it against the fixture**

```bash
docker compose exec -T worker-render sh -lc '
REFRAME_ENGINE=faces REFRAME_STREAM=on npx tsx /app/apps/worker/src/scripts/eval-reframe.ts \
  /app/apps/worker/eval-media/stream-cs2.mp4 600 640 /app/apps/worker/eval-media/eval600'
```

Expected: a profile printed with `"class": "stream"`, and `sheet.jpg` written. Open `apps/worker/eval-media/eval600/sheet.jpg` and confirm the webcam sits on top with the game below, with no second copy of the webcam inside the lower tile.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/scripts/eval-reframe.ts
git commit -m "feat(reframe): visual harness for reframe decisions

Video plus a time range in, plan JSON and a contact sheet out."
```

---

### Task 13: Cover the three paths that have never been tested

Spec §12. `computeCropPlan`, `detectShots` and the reframe branch of `render.ts` currently have zero coverage and are all inside this change's blast radius.

**Files:**
- Create: `apps/worker/src/__tests__/reframe-compute.test.ts`
- Create: `apps/worker/src/__tests__/reframe-shots-detect.test.ts`

- [ ] **Step 1: Write the tests**

Create `apps/worker/src/__tests__/reframe-compute.test.ts`, mocking the three child-process boundaries so no video is needed:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

describe("computeCropPlan fallbacks", () => {
  beforeEach(() => execFileMock.mockReset());

  it("returns scdet_failed when probing throws", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: Function) =>
      cb(new Error("boom"))
    );
    const { computeCropPlan } = await import("../reframe");
    const r = await computeCropPlan("/x.mp4", 0, 10);
    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("scdet_failed");
  });

  it("maps a killed process to timeout", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: Function) => {
      const err = new Error("killed") as Error & { killed: boolean };
      err.killed = true;
      cb(err);
    });
    const { computeCropPlan } = await import("../reframe");
    expect((await computeCropPlan("/x.mp4", 0, 10)).fallbackReason).toBe("timeout");
  });

  it("never throws, whatever the sidecar does", async () => {
    execFileMock.mockImplementation(() => {
      throw new Error("sync explosion");
    });
    const { computeCropPlan } = await import("../reframe");
    await expect(computeCropPlan("/x.mp4", 0, 10)).resolves.toMatchObject({
      plan: null,
    });
  });
});
```

For `detectShots`, create `apps/worker/src/__tests__/reframe-shots-detect.test.ts` - a separate file, because `reframe-shots.test.ts` tests the pure `cutsToShots` and must stay free of module mocks:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (e: Error | null, r: { stdout: string; stderr: string }) => void
  ) => {
    execFileMock(args);
    cb(null, { stdout: "", stderr: execFileMock.stderrQueue.shift() ?? "" });
  },
})) as unknown;

// Threshold used by each scdet invocation, read back out of the -vf argument.
const thresholds = () =>
  execFileMock.mock.calls.map((c: [string[]]) => {
    const vf = c[0][c[0].indexOf("-vf") + 1];
    return Number(/gte\(scene,([0-9.]+)\)/.exec(vf)![1]);
  });

const cfg = {
  engine: "faces" as const,
  sampleFps: 2,
  sceneThreshold: 0.3,
  minShotSec: 1.0,
  faceMinScore: 0.7,
  maxDetectSec: 30,
  stream: false,
  camShare: 0.4,
  faceSmallFrac: 0.06,
  faceLargeFrac: 0.1,
  pipMaxFrac: 0.5,
  pipEdgeMin: 3.0,
};

describe("detectShots retry", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.stderrQueue = [];
  });

  it("retries a long zero-cut window at half the threshold", async () => {
    // Both passes find nothing; we assert only that the second pass happened
    // and that it used the halved threshold.
    execFileMock.stderrQueue = ["", ""];
    const { detectShots } = await import("../reframe/shots");
    await detectShots("/x.mp4", 0, 40, cfg, 5000);
    expect(thresholds()).toEqual([0.3, 0.15]);
  });

  it("does not retry when the first pass found cuts", async () => {
    execFileMock.stderrQueue = ["pts_time:12.4\npts_time:31.0"];
    const { detectShots } = await import("../reframe/shots");
    const shots = await detectShots("/x.mp4", 0, 40, cfg, 5000);
    expect(thresholds()).toEqual([0.3]);
    expect(shots).toHaveLength(3);
  });

  it("does not retry a window shorter than the long-take bar", async () => {
    execFileMock.stderrQueue = [""];
    const { detectShots } = await import("../reframe/shots");
    await detectShots("/x.mp4", 0, 10, cfg, 5000);
    expect(thresholds()).toEqual([0.3]);
  });

  it("never lets the retry threshold fall below the floor", async () => {
    execFileMock.stderrQueue = ["", ""];
    const { detectShots } = await import("../reframe/shots");
    await detectShots("/x.mp4", 0, 40, { ...cfg, sceneThreshold: 0.2 }, 5000);
    expect(thresholds()[1]).toBe(0.15);
  });
});
```

`execFileMock.stderrQueue` is a plain property hung off the vi.fn; declare it as `(execFileMock as unknown as { stderrQueue: string[] }).stderrQueue` if the TypeScript config rejects the loose access.

- [ ] **Step 2: Run them**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src/__tests__/reframe-compute.test.ts apps/worker/src/__tests__/reframe-shots-detect.test.ts
```

Expected: PASS. If `computeCropPlan` throws instead of returning a fallback, that is a real defect this design's contract depends on - fix `index.ts` rather than the test.

- [ ] **Step 3: Full suite**

```bash
docker compose exec -T worker-render npx vitest run --root /app apps/worker/src
```

Expected: all green. Record the total count in the commit message.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/__tests__/reframe-compute.test.ts apps/worker/src/__tests__/reframe-shots-detect.test.ts
git commit -m "test(reframe): cover computeCropPlan and the scdet retry

Both are load-bearing for the stream layout's fallback contract and had no
coverage at all."
```

---

### Task 14: Update the engine notes

The living record is the reason this project does not re-derive the same facts every session.

**Files:**
- Modify: `docs/engine-notes.md` §7

- [ ] **Step 1: Write the additions**

Add to the "Measured gotchas" list in §7:

```markdown
- Stream sources with a corner webcam inset were rendering as garbage: the detector finds the face inside a
  427x240 inset (3.4% of frame width against 15-30% for a podcast), and the planner centred a 9:16 window on
  it, producing a truncated webcam, the chat overlay under it and a slice of game floor. Fixed in two parts:
  a min-face guard (a face under 6% of frame width may not anchor a crop) and a `stream` layout.
- The cam/content tile relationship inverts the obvious adjustment. `Hg = Hs * 1080 / Wg` and `Hc = 1920 - Hg`,
  so a TALLER cam tile needs a WIDER content window. When the window will not fit beside the inset, the cam
  share must be REDUCED, not raised. This was got backwards once during design.
- `setsar=1` is required after every `scale` in the stacked graph. Without it ffmpeg 8.x **segfaults** while
  stacking 1080x770 over 1080x1150. Reproduced, then fixed by pinning SAR.
- Webcam upscale is more forgiving than the arithmetic suggests: a 427px inset filling a 1080-wide tile is
  2.53x, and the 40% composition is 3.21x. Inspected at 1:1 against source pixels - a clean, well-lit webcam
  softens rather than breaks up. No resolution floor is imposed, because the measurement does not support one.
```

Add to §9 or the open-follow-ups section:

```markdown
- Stream reframe thresholds (`REFRAME_FACE_SMALL_FRAC`, `REFRAME_PIP_EDGE_MIN`, `REFRAME_CAM_SHARE`) rest on
  ONE fixture - one streamer, one OBS layout, corner inset. The mechanism is validated; the numbers are not.
  A second and third source of different shape are needed before any of them is treated as known.
- `buildCropPlan` computes `maxSamples` over ALL tracks, including ones the min-face guard is about to
  discard, so `MIN_SAMPLE_FRAC` is measured against a track that will not survive. Never produces a wrong
  anchor - the failure mode is only "more conservative than necessary" - but it bites in an unmeasured case:
  a PODCAST with a persistently-detected background face plus an intermittently-detected speaker drops the
  speaker for being rare relative to a track that is then discarded anyway. Applying the size filter first
  is a two-line reorder and strictly at-least-as-good, but it silently changes which sources get anchored,
  so it needs its own measurement rather than riding along on unrelated work. Found during the task 1 code
  review, 2026-08-02, and deliberately not fixed then.
```

- [ ] **Step 2: Commit**

```bash
git add docs/engine-notes.md
git commit -m "docs(engine): record what the stream reframe work measured"
```

---

## Rollout after the plan is complete

Spec §13. Not code steps - operational ones, in order:

1. Ship Tasks 1-14 with `REFRAME_STREAM` unset. The min-face guard is live; classification and telemetry run; the picture does not change except where it was broken.
2. Run the existing podcast fixtures through `eval-reframe.ts` and confirm every one classifies as `normal_face`. A podcast classified as `stream` is a stop-the-line defect.
3. Set `REFRAME_STREAM=on` in the live `.env`, then `docker compose restart worker-render`. Note that `compose restart` does **not** re-read `env_file` - recreate the container instead if the variable does not take effect.
4. Re-run `eval-reframe.ts` on the CS2 fixture and inspect the sheet.
5. Delete `apps/worker/eval-media/stream-cs2.mp4` once the harness has been run and the committed `testdata` frames are proven sufficient.
