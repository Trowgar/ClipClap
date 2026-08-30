# Reframe Safety Shadow Slice 1A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure deterministic per-sample face containment for the rendered `single`, `center`, `split`, and `stream` layouts without changing any crop plan or rendered frame.

**Architecture:** Face paths become ephemeral mandatory regions. A pure evaluator converts each existing layout into its source-space visible windows, including single-camera trajectories and composite layouts, then reports the worst per-sample coverage. The result travels beside `CropPlan` as aggregate shadow telemetry; it is never written into the plan and cannot affect rendering.

**Tech Stack:** TypeScript, Vitest, existing ffmpeg/reframe pipeline, Docker Compose.

**Scope:** This plan implements Slice 1A only. `safe-fit`, plan version 4, active rejection, UI/OCR/VLM, and post-render retry are Slice 1B or later and must not be added here.

---

## File map

- Modify `apps/worker/src/reframe/plan.ts`: stop fabricating pre-first-observation boxes.
- Create `apps/worker/src/reframe/regions.ts`: canonical ephemeral face-region adapter.
- Create `apps/worker/src/reframe/safety.ts`: layout window transforms and 90% coverage evaluation.
- Modify `apps/worker/src/reframe/config.ts` and `index.ts`: exact-literal shadow flag and non-behavioural computation.
- Modify `apps/worker/src/reframe/telemetry.ts` and `stages/render.ts`: aggregate-only manifest telemetry.
- Create `apps/worker/src/__tests__/reframe-safety.test.ts` and extend existing focused suites.
- Create `apps/worker/src/scripts/eval-reframe-safety-shadow.ts`: private manual replay report; media and detector sidecars remain ignored.

### Task 1: Correct the pre-first-observation target

**Files:** Modify `apps/worker/src/reframe/plan.ts`; Test `apps/worker/src/__tests__/reframe-plan.test.ts`.

- [ ] **Step 1: Add a failing staggered-lifecycle test.** Import the existing `FaceTrack` type and add:

```ts
it("does not carry a later face backward before its first observation", () => {
  const early: FaceTrack = {
    id: 1, box: { x: 100, y: 0, w: 100, h: 100 }, score: 0.9,
    samples: 2, mouthActivity: 0,
    path: [
      { t: 0, x: 100, y: 0, w: 100, h: 100 },
      { t: 1, x: 120, y: 0, w: 100, h: 100 },
    ],
  };
  const late: FaceTrack = {
    id: 2, box: { x: 1000, y: 0, w: 100, h: 100 }, score: 0.9,
    samples: 1, mouthActivity: 0,
    path: [{ t: 1, x: 1000, y: 0, w: 100, h: 100 }],
  };

  expect(buildTargetSamples([early, late], 0, 1)).toEqual([
    { t: 0, cx: 150 },
    { t: 1, cx: 610 },
  ]);
});
```

- [ ] **Step 2: Prove the regression.** Run:

```bash
docker compose exec -T worker-render /app/node_modules/.bin/vitest run --root /app \
  apps/worker/src/__tests__/reframe-plan.test.ts \
  -t "does not carry a later face backward"
```

Expected: FAIL because the first target includes `late.path[0]` before `t=1`.

- [ ] **Step 3: Implement the minimal lifecycle correction.** Replace `boxAt` and the target map with:

```ts
function boxAt(path: PathSample[], t: number): PathSample | undefined {
  let chosen: PathSample | undefined;
  for (const sample of path) {
    if (sample.t > t) break;
    chosen = sample;
  }
  return chosen;
}

return times.flatMap((t) => {
  const boxes = withPath
    .map((track) => boxAt(track.path!, t))
    .filter((box): box is PathSample => box !== undefined);
  if (boxes.length === 0) return [];
  const minX = Math.min(...boxes.map((box) => box.x));
  const maxX = Math.max(...boxes.map((box) => box.x + box.w));
  return [{ t, cx: (minX + maxX) / 2 }];
});
```

- [ ] **Step 4: Verify the whole planner suite.** Run the full `reframe-plan.test.ts`; expect 165 tests passing and no changed legacy fixtures other than the new regression.

- [ ] **Step 5: Commit.**

```bash
git add apps/worker/src/reframe/plan.ts apps/worker/src/__tests__/reframe-plan.test.ts
git commit -m "fix(reframe): respect face appearance lifecycle"
```

### Task 2: Add canonical ephemeral face regions

**Files:** Create `apps/worker/src/reframe/regions.ts`; Test `apps/worker/src/__tests__/reframe-safety.test.ts`.

- [ ] **Step 1: Write the missing-module test.** The fixture must assert path-only samples, shot clipping, mandatory priority, and ephemeral prefixed IDs:

```ts
const regions = faceTracksToRegions([track], { start: 1, end: 3 }, "shot-2");
expect(regions).toEqual([{
  id: "shot-2:face-7",
  kind: "face",
  priority: "mandatory",
  samples: [
    { t: 1, box: { x: 20, y: 10, w: 80, h: 80 }, confidence: 0.92 },
    { t: 2, box: { x: 30, y: 10, w: 80, h: 80 }, confidence: 0.92 },
  ],
}]);
```

- [ ] **Step 2: Run `reframe-safety.test.ts`.** Expected: FAIL because `../reframe/regions` does not exist.

- [ ] **Step 3: Create the exact region contract and adapter.**

```ts
import type { FaceBox, FaceTrack, Shot } from "./types";

export type RegionKind = "face" | "saliency" | "ui" | "text";

export interface FocalRegionSample {
  t: number;
  box: FaceBox;
  confidence: number;
}

export interface FocalRegionTrack {
  id: string;
  kind: RegionKind;
  priority: "mandatory" | "supporting";
  samples: FocalRegionSample[];
}

export function faceTracksToRegions(
  tracks: FaceTrack[],
  span: Shot,
  idPrefix: string
): FocalRegionTrack[] {
  return tracks.flatMap((track) => {
    const samples = (track.path ?? [])
      .filter(({ t }) => t >= span.start && t <= span.end)
      .map(({ t, x, y, w, h }) => ({
        t,
        box: { x, y, w, h },
        confidence: track.score,
      }));
    return samples.length === 0 ? [] : [{
      id: `${idPrefix}:face-${track.id}`,
      kind: "face" as const,
      priority: "mandatory" as const,
      samples,
    }];
  });
}
```

- [ ] **Step 4: Run the focused test.** Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/worker/src/reframe/regions.ts apps/worker/src/__tests__/reframe-safety.test.ts
git commit -m "feat(reframe): normalize face paths into focal regions"
```

### Task 3: Evaluate actual layout geometry

**Files:** Create `apps/worker/src/reframe/safety.ts`; Extend `apps/worker/src/__tests__/reframe-safety.test.ts`.

- [ ] **Step 1: Add failing table tests.** Cover: `0.90` passes and `0.899` fails; missing layout is `not_evaluable`; `single.xs` interpolates; `split` uses the maximum coverage of top/bottom windows; `stream` uses cam/content windows; one failed mandatory sample makes the whole evaluation fail.

```ts
expect(coverageForBox(
  { x: 0, y: 0, w: 100, h: 100 },
  { x: 10, y: 0, w: 100, h: 100 }
)).toBe(0.9);

expect(evaluatePlanCoverage(plan, regions, 0.9)).toMatchObject({
  status: "pass",
  minimumCoverage: 0.9,
  evaluatedSamples: 1,
  rejectedSamples: 0,
});
```

- [ ] **Step 2: Run the safety test.** Expected: FAIL because the geometry API is missing.

- [ ] **Step 3: Create the public result and rectangle primitive.**

```ts
import { cropWidthFor, tileWidthFor } from "./geometry";
import type { CropPlan, FaceBox, Keyframe, ShotLayout } from "./types";
import type { FocalRegionTrack } from "./regions";

export interface SafetyShadowTelemetry {
  status: "not_evaluable" | "pass" | "fail";
  threshold: number;
  minimumCoverage: number | null;
  evaluatedSamples: number;
  rejectedSamples: number;
  unmappedSamples: number;
}

export function coverageForBox(region: FaceBox, window: FaceBox): number {
  if (region.w <= 0 || region.h <= 0) return 0;
  const w = Math.max(0, Math.min(region.x + region.w, window.x + window.w) - Math.max(region.x, window.x));
  const h = Math.max(0, Math.min(region.y + region.h, window.y + window.h) - Math.max(region.y, window.y));
  return (w * h) / (region.w * region.h);
}

function trajectoryX(keys: Keyframe[], t: number): number {
  if (t <= keys[0].t) return keys[0].x;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.t) {
      const progress = (t - a.t) / Math.max(b.t - a.t, 0.001);
      return a.x + (b.x - a.x) * Math.min(1, Math.max(0, progress));
    }
  }
  return keys[keys.length - 1].x;
}
```

- [ ] **Step 4: Implement layout-to-window transforms and evaluation.**

```ts
function windowsAt(plan: CropPlan, shot: ShotLayout, t: number): FaceBox[] {
  const { width, height } = plan.source;
  if (shot.layout === "center" || shot.layout === "single") {
    const x = shot.layout === "single" && shot.xs?.length
      ? trajectoryX(shot.xs, t)
      : shot.x;
    return [{ x, y: 0, w: cropWidthFor(height), h: height }];
  }
  if (shot.layout === "split") {
    const w = tileWidthFor(height);
    return [
      { x: shot.top.x, y: 0, w, h: height },
      { x: shot.bottom.x, y: 0, w, h: height },
    ];
  }
  const geometry = plan.stream;
  if (!geometry) return [];
  return [
    { x: shot.cam.x, y: geometry.camCrop.y, w: geometry.camCrop.w, h: geometry.camCrop.h },
    { x: shot.content.x, y: 0, w: geometry.contentCrop.w, h: geometry.contentCrop.h },
  ];
}

export function evaluatePlanCoverage(
  plan: CropPlan,
  regions: FocalRegionTrack[],
  threshold = 0.9
): SafetyShadowTelemetry {
  let minimum = 1;
  let evaluatedSamples = 0;
  let rejectedSamples = 0;
  let unmappedSamples = 0;
  for (const region of regions) {
    if (region.priority !== "mandatory") continue;
    for (const sample of region.samples) {
      const shot = plan.shots.find(({ start, end }, index) =>
        sample.t >= start &&
        (sample.t < end || (index === plan.shots.length - 1 && sample.t <= end))
      );
      const windows = shot ? windowsAt(plan, shot, sample.t) : [];
      if (windows.length === 0) {
        unmappedSamples++;
        continue;
      }
      const visible = Math.max(...windows.map((window) => coverageForBox(sample.box, window)));
      minimum = Math.min(minimum, visible);
      evaluatedSamples++;
      if (visible < threshold) rejectedSamples++;
    }
  }
  if (evaluatedSamples === 0 || unmappedSamples > 0) {
    return {
      status: "not_evaluable",
      threshold,
      minimumCoverage: evaluatedSamples > 0 ? minimum : null,
      evaluatedSamples,
      rejectedSamples,
      unmappedSamples,
    };
  }
  return {
    status: rejectedSamples === 0 ? "pass" : "fail",
    threshold,
    minimumCoverage: minimum,
    evaluatedSamples,
    rejectedSamples,
    unmappedSamples,
  };
}
```

- [ ] **Step 5: Run the focused suite and commit.** Expect every geometry table to pass.

```bash
git add apps/worker/src/reframe/safety.ts apps/worker/src/__tests__/reframe-safety.test.ts
git commit -m "feat(reframe): measure per-sample layout containment"
```

### Task 4: Thread shadow mode without changing plans

**Files:** Modify `apps/worker/src/reframe/config.ts`, `index.ts`; Tests `reframe-config.test.ts`, `reframe-compute.test.ts`.

- [ ] **Step 1: Add failing exact-literal and invariance tests.** `REFRAME_SAFETY_SHADOW=on` must enable computation; missing, `ON`, `true`, and `1` must not. Serialize `planDetected(detection, off).plan` and `planDetected(detection, on).plan`; strings must be identical.

- [ ] **Step 2: Run the two focused test files.** Expected: FAIL for missing config/result fields.

- [ ] **Step 3: Add the exact config field.** Add required `safetyShadow: boolean` to `ReframeConfig` and this loader entry:

```ts
safetyShadow: env.REFRAME_SAFETY_SHADOW === "on",
```

Do not add the flag to `PlanOptions` or read it in `buildCropPlan`; shadow
measurement belongs after the final plan is chosen and must not enter layout
selection.

- [ ] **Step 4: Compute aggregate evidence beside the plan.** Add `safetyShadow?: SafetyShadowTelemetry` to `PlannedDetection` and `ReframeResult`. After the existing stream coverage gate has finalized `plan`, build regions only from `survivingTracks(trackSet.tracks)` with `faceTracksToRegions`, then return:

```ts
const safetyShadow = cfg.safetyShadow && plan
  ? evaluatePlanCoverage(
      plan,
      tracks.flatMap((trackSet, index) =>
        faceTracksToRegions(
          survivingTracks(trackSet.tracks),
          shots[index],
          `shot-${index}`
        )
      )
    )
  : undefined;

return {
  plan,
  ...(cutRecovery ? { cutRecovery } : {}),
  ...(decisions ? { decisions } : {}),
  ...(safetyShadow ? { safetyShadow } : {}),
};
```

Copy it through both successful `computeCropPlan` return shapes; do not attach it to `CropPlan`.

- [ ] **Step 5: Run `reframe-config`, `reframe-compute`, and full `reframe-plan` suites.** Assert flag-off byte identity and flag-on plan identity. Commit:

```bash
git add apps/worker/src/reframe/config.ts apps/worker/src/reframe/index.ts \
  apps/worker/src/__tests__/reframe-config.test.ts \
  apps/worker/src/__tests__/reframe-compute.test.ts
git commit -m "feat(reframe): add non-behavioural safety shadow"
```

### Task 5: Persist aggregate telemetry only

**Files:** Modify `apps/worker/src/reframe/telemetry.ts`, `stages/render.ts`; Test `apps/worker/src/__tests__/reframe-telemetry.test.ts`.

- [ ] **Step 1: Add a failing telemetry test.** Pass a `SafetyShadowTelemetry` value to `buildReframeCheck`, assert exact equality, recursively serialize the check, and assert it contains none of `box`, `x`, `y`, `path`, `url`, `userId`, or `storageKey`.

- [ ] **Step 2: Run the telemetry test.** Expected: FAIL because the input/result field is absent.

- [ ] **Step 3: Add the aggregate-only field.** Import `SafetyShadowTelemetry`, add optional `safetyShadow` to `ReframeCheck` and `ReframeCheckInput`, and append:

```ts
...(input.safetyShadow ? { safetyShadow: input.safetyShadow } : {}),
```

In `render.ts`, pass the already aggregated result:

```ts
safetyShadow: reframe.safetyShadow,
```

Do not log or persist regions, samples, boxes, titles, transcript text, URLs, keys, or identifiers.

- [ ] **Step 4: Run telemetry and render suites.**

```bash
docker compose exec -T worker-render /app/node_modules/.bin/vitest run --root /app \
  apps/worker/src/__tests__/reframe-telemetry.test.ts \
  apps/worker/src/__tests__/render-reframe.test.ts
```

Expected: PASS. Commit:

```bash
git add apps/worker/src/reframe/telemetry.ts apps/worker/src/stages/render.ts \
  apps/worker/src/__tests__/reframe-telemetry.test.ts
git commit -m "feat(reframe): record aggregate safety shadow telemetry"
```

### Task 6: Synthetic replay and private evidence harness

**Files:** Create `apps/worker/src/__tests__/reframe-safety-replay.test.ts`, `apps/worker/src/scripts/eval-reframe-safety-shadow.ts`.

- [ ] **Step 1: Add checked-in synthetic replay fixtures.** Reuse one immutable `Detection` object for flag off/on. Include: staggered faces, a wide group that fails 90%, a split plan that passes through two windows, and the existing historical virtual-stream shape. Assert plan JSON equality and expected shadow status.

- [ ] **Step 2: Run the replay test.** Expected: FAIL until the fixtures are wired through `planDetected`.

- [ ] **Step 3: Add a private manual CLI.** The script accepts an ignored
  `corpus-baseline.ts` capture containing `{ shots, tracks, plan, source,
  clip }`, adapts surviving tracks for each captured shot, evaluates the
  already captured plan, and writes only this aggregate JSON to stdout:

```ts
console.log(JSON.stringify({
  safetyShadow: plan ? evaluatePlanCoverage(plan, regions) : null,
}));
```

It must never print source paths, frames, face coordinates, transcripts, storage keys, URLs, or IDs. Contact sheets continue to use the existing ignored `apps/worker/.corpus/negative-feedback-2026-08-30/contact-sheets/` workflow.

- [ ] **Step 4: Run the synthetic suite and then the private replay.** Use the
  existing capture format so detection is performed once and replayed
  immutably:

```bash
docker compose exec -T worker-render sh -lc \
  'cd /app/apps/worker && /app/node_modules/.bin/tsx src/scripts/eval-reframe-safety-shadow.ts .corpus/reframe-safety/case-03.plan.json'
```

Repeat for `case-04.plan.json`, `case-05.plan.json`, and `case-11.plan.json`.
Capturing those ignored inputs is a prerequisite; a missing source is reported
as missing evidence, never replaced by a guessed fixture. The private replay
is an acceptance gate, not a dependency of committed tests. Produce aligned
`source | current` sheets now; `source | current | new` belongs to active
Slice 1B.

- [ ] **Step 5: Commit only code and synthetic fixtures.**

```bash
git add apps/worker/src/__tests__/reframe-safety-replay.test.ts \
  apps/worker/src/scripts/eval-reframe-safety-shadow.ts
git commit -m "test(reframe): add deterministic safety shadow replay"
```

## Final verification

- [ ] Run all worker reframe tests:

```bash
docker compose exec -T worker-render /app/node_modules/.bin/vitest run --root /app \
  apps/worker/src/__tests__/reframe-plan.test.ts \
  apps/worker/src/__tests__/reframe-safety.test.ts \
  apps/worker/src/__tests__/reframe-safety-replay.test.ts \
  apps/worker/src/__tests__/reframe-filtergraph.test.ts \
  apps/worker/src/__tests__/reframe-config.test.ts \
  apps/worker/src/__tests__/reframe-compute.test.ts \
  apps/worker/src/__tests__/reframe-telemetry.test.ts \
  apps/worker/src/__tests__/render-reframe.test.ts
```

- [ ] Run `docker compose exec -T worker-render npm run typecheck -w @clipclap/worker`. The baseline currently fails only because the image lacks `fs-ext` typings/native module in `feedback-learning/lock.ts`; record that separately and reject any new TypeScript error.
- [ ] Run `git diff --check` and confirm `git status --short` contains no corpus media, frames, detector sidecars, or the pre-existing user file `apps/worker/src/tmp-audit.ts` in any commit.
- [ ] Review private aggregate results. Slice 1B may start only after flag-on plans are byte-identical to flag-off plans and the four audited shapes plus controls produce credible coverage measurements.
