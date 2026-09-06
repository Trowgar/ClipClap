# Stream Webcam Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zoom out synthesized stream webcams for future videos while leaving detected webcam bounds and the full-frame gameplay tile unchanged.

**Architecture:** Change the single virtual-camera width constant at the plan source from 3.2 to the visually selected 5.2 face widths. Existing geometry helpers continue to derive an even, in-frame crop and all downstream rendering remains unchanged.

**Tech Stack:** TypeScript, Vitest, FFmpeg, Docker Compose

---

### Task 1: Pin the paid-customer geometry

**Files:**
- Modify: `apps/worker/src/__tests__/reframe-plan.test.ts`

- [ ] **Step 1: Add the failing customer-shaped regression test**

Inside `describe("D4 virtual cam tile")`, add a test using the measured face box:

```ts
it("zooms a customer-shaped virtual webcam out enough to retain shoulder context", () => {
  const customerFace: FaceTrack = {
    id: 0,
    box: {
      x: 232.88772583007812,
      y: 827.958251953125,
      w: 87.27961349487305,
      h: 114.31553649902344,
    },
    score: 0.8648213483393192,
    samples: 16,
    mouthActivity: 0.033522772043943404,
  };
  const plan = buildCropPlan(
    oneShot,
    withTracks([customerFace]),
    1920,
    1080,
    { ...vStreamOpts, streamVirtualCam: true },
    null
  );

  expect(plan?.profile?.virtualCam).toBe(true);
  expect(plan?.stream).toEqual({
    camCrop: { w: 360, h: 256, y: 742 },
    contentCrop: { w: 1012, h: 1080 },
    outCamH: 768,
    outContentH: 1152,
  });
  expect(plan?.shots[0]).toEqual({
    start: 0,
    end: 30,
    layout: "stream",
    cam: { x: 96 },
    content: { x: 504 },
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
docker compose exec -T worker-render sh -lc 'cd /app/apps/worker && npx vitest run --root ../.. apps/worker/src/__tests__/reframe-plan.test.ts -t "zooms a customer-shaped virtual webcam out"'
```

Expected: FAIL because current geometry returns `camCrop.w = 282`, not `360`.

### Task 2: Widen only synthesized webcam rectangles

**Files:**
- Modify: `apps/worker/src/reframe/plan.ts`
- Modify: `apps/worker/src/__tests__/reframe-plan.test.ts`

- [ ] **Step 1: Apply the minimal production change**

Change the existing constant and its comment:

```ts
export const VIRTUAL_CAM_WIDTH_FACES = 5.2;
```

Do not change `solveStreamGeometry`, detected `camRect` handling, tile heights,
or the filtergraph.

- [ ] **Step 2: Update existing exact virtual-camera fixtures**

Update only expectations derived from `VIRTUAL_CAM_WIDTH_FACES`:

```ts
// tox plan
camCrop: { w: 166, h: 118, y: 242 }
// tox stream shot
cam: { x: 474 }, content: { x: 134 }
// tox synthesized rect
{ x: 472, y: 242, w: 168, h: 118, score: 0 }
// bottom-right corner rect
{ x: 578, y: 324, w: 62, h: 36, score: 0 }
// top-left corner rect
{ x: 0, y: 0, w: 124, h: 88, score: 0 }
```

Keep their containment, even-dimension, frame-boundary, and real-rectangle assertions intact.

- [ ] **Step 3: Run the complete plan and geometry tests**

Run:

```bash
docker compose exec -T worker-render sh -lc 'cd /app/apps/worker && npx vitest run --root ../.. apps/worker/src/__tests__/reframe-plan.test.ts apps/worker/src/__tests__/reframe-stream-geometry.test.ts apps/worker/src/__tests__/reframe-filtergraph.test.ts apps/worker/src/__tests__/reframe-safety.test.ts'
```

Expected: all selected test files pass.

- [ ] **Step 4: Commit the implementation**

```bash
git add apps/worker/src/reframe/plan.ts apps/worker/src/__tests__/reframe-plan.test.ts
git commit -m "fix(reframe): widen virtual webcam context"
```

### Task 3: Verify the real render and deploy

**Files:**
- No repository changes expected.

- [ ] **Step 1: Recompute the retained customer range with current code**

Run detection and planning for the retained 1920x1080 source range beginning at
753.389978 seconds. Confirm the plan is `virtualCam`, its camera crop is
`360x256`, and the complete gameplay tile remains enabled.

- [ ] **Step 2: Render and inspect the candidate**

Render the 7.77-second range with the production filtergraph. Confirm the webcam
shows the full head, shoulders, microphone, and surrounding context without a
gameplay/UI strip entering the camera tile.

- [ ] **Step 3: Probe output geometry**

Run:

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,sample_aspect_ratio,display_aspect_ratio -of json <candidate.mp4>
```

Expected: `1080x1920`, SAR `1:1`, DAR `9:16`.

- [ ] **Step 4: Run build verification**

```bash
docker compose exec -T worker-render sh -lc 'cd /app && npm run typecheck -w @clipclap/worker && npm run build -w @clipclap/worker'
git diff --check
```

Expected: exit 0.

- [ ] **Step 5: Deploy only the idle render worker**

Verify the `video-render` queue has no active, waiting, delayed, or paused jobs,
then run:

```bash
docker compose up -d --build --no-deps worker-render
```

- [ ] **Step 6: Post-deploy verification**

Confirm `worker-render` is running, logs contain `ClipClap worker starting with
role=render`, the deployed source contains `VIRTUAL_CAM_WIDTH_FACES = 5.2`, and
the focused tests pass in the recreated container.
