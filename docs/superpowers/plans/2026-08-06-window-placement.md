# Window Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop the crop window's edge slicing a person in half, without moving the window off its subject.

**Architecture:** The window is currently centred on the faces it anchors, and nothing asks what its edges do
to the faces it did not anchor. A new pure function `placeWindow` scores every window position that keeps the
anchor group whole, by how badly it cuts any other face, and takes the least - breaking ties toward the
position the planner already chooses, so a shot with nothing at stake is byte-identical to today. No new
constant is introduced anywhere.

**Spec:** `docs/superpowers/specs/2026-08-06-window-placement-design.md`. Read §3 and §5.1 before writing
code. §5.1 forbids adding a cap on how far the window may move - that decision comes after looking at frames.

**Tech Stack:** TypeScript (worker), vitest, ffmpeg, Prisma/Postgres, Cloudflare R2.

**How to run things:**

```bash
# tests
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/'
# typecheck
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'
# scripts
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/<file>.ts'
```

**Branch:** `git checkout -b feat/window-placement` from `main` before Task 1.

**Baseline:** 1117 tests passing, `tsc` clean. Verify both before starting so you can tell your own breakage
from pre-existing state.

---

## File structure

| file | responsibility | task |
|---|---|---|
| `apps/worker/src/reframe/plan.ts` | `faceVisibility`, `bisectionSeverity`, `placeWindow`; two call sites rewired | 1, 2 |
| `apps/worker/src/__tests__/reframe-plan.test.ts` | unit tests for the scoring and the placement | 1, 2 |
| `apps/worker/src/scripts/eval-bisection.ts` | new. The acceptance measurement, span by span | 3 |
| `apps/worker/src/scripts/eval-shift-sheets.ts` | new. Before/after strips for the worst shifts | 4 |
| `docs/engine-notes.md` | §7f | 5 |

---

## Task 1: The scoring functions

**Files:**
- Modify: `apps/worker/src/reframe/plan.ts`
- Test: `apps/worker/src/__tests__/reframe-plan.test.ts`

**Context:** Two tiny pure functions, separated from the placement search so each can be tested on its own
and so the severity curve is visible rather than buried in a loop. `bisectionSeverity` is the whole reason
this design needs no threshold: it is exactly zero when a face is wholly inside or wholly outside the window,
so "nobody is cut" is the case where the minimum is zero rather than a separate condition with a number in
it.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/src/__tests__/reframe-plan.test.ts`:

```ts
describe("faceVisibility", () => {
  const face = (x: number, w: number) => ({
    id: 0, box: { x, y: 0, w, h: 100 }, score: 0.9, samples: 5, mouthActivity: 0.05,
  });

  it("is 1 when the face is wholly inside", () => {
    expect(faceVisibility(face(700, 100), 600, 608)).toBe(1);
  });

  it("is 0 when the face is wholly outside", () => {
    expect(faceVisibility(face(1500, 100), 0, 608)).toBe(0);
    expect(faceVisibility(face(0, 100), 700, 608)).toBe(0);
  });

  it("is the overlapping fraction when the face straddles an edge", () => {
    // window 600..1208, face 1158..1258 -> 50 of 100 px inside
    expect(faceVisibility(face(1158, 100), 600, 608)).toBeCloseTo(0.5, 6);
    // window 600..1208, face 550..650 -> 50 of 100 px inside
    expect(faceVisibility(face(550, 100), 600, 608)).toBeCloseTo(0.5, 6);
  });

  it("is 0 for a face touching the edge with zero width of overlap", () => {
    expect(faceVisibility(face(1208, 100), 600, 608)).toBe(0);
  });
});

describe("bisectionSeverity", () => {
  it("is exactly zero for a face wholly inside or wholly outside", () => {
    // This is what removes the need for a threshold anywhere in this design:
    // "nobody is cut" is severity 0, not a band someone has to choose.
    expect(bisectionSeverity(0)).toBe(0);
    expect(bisectionSeverity(1)).toBe(0);
  });

  it("peaks at exactly half showing", () => {
    expect(bisectionSeverity(0.5)).toBe(1);
  });

  it("is symmetric about a half", () => {
    expect(bisectionSeverity(0.2)).toBeCloseTo(bisectionSeverity(0.8), 9);
  });

  it("rises monotonically toward a half from either side", () => {
    expect(bisectionSeverity(0.1)).toBeLessThan(bisectionSeverity(0.3));
    expect(bisectionSeverity(0.9)).toBeLessThan(bisectionSeverity(0.7));
  });

  it("treats a barely-clipped face as barely cut", () => {
    // 99% showing is a hair off the edge, not a bisected person.
    expect(bisectionSeverity(0.99)).toBeCloseTo(0.02, 6);
  });
});
```

Add `faceVisibility` and `bisectionSeverity` to the existing `../reframe/plan` import statement - do not add a
second import statement.

- [ ] **Step 2: Run and confirm FAILURE**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/reframe-plan.test.ts'`
Expected: FAIL - neither function is exported. Do not proceed until you have seen it fail.

- [ ] **Step 3: Implement**

Add to `apps/worker/src/reframe/plan.ts`, immediately above `windowXFor`:

```ts
/** How much of this face the window at `x` shows, as a fraction of its width. */
export function faceVisibility(
  track: FaceTrack,
  x: number,
  cropW: number
): number {
  const left = Math.max(track.box.x, x);
  const right = Math.min(track.box.x + track.box.w, x + cropW);
  return Math.max(0, right - left) / track.box.w;
}

/**
 * How badly a window cuts a face, from its visible fraction.
 *
 * Exactly 0 when the face is wholly inside or wholly outside, 1 when exactly
 * half of it shows. That zero is what lets this whole design avoid inventing a
 * threshold: "no face is bisected" is not a band somebody had to choose, it is
 * the case where the minimum of this function happens to be zero.
 *
 * A face 99% inside scores 0.02 - a hair off the edge, correctly, rather than
 * being lumped in with a person split down the middle.
 */
export function bisectionSeverity(visible: number): number {
  return 1 - Math.abs(2 * visible - 1);
}
```

- [ ] **Step 4: Run tests**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/'`
Expected: PASS, 1117 + 9 new. Every pre-existing assertion at its original value.

- [ ] **Step 5: Typecheck and commit**

```bash
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'
git add apps/worker/src/reframe/plan.ts apps/worker/src/__tests__/reframe-plan.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(reframe): score how badly a window cuts a face"
```

---

## Task 2: The placement search, and both call sites

**Files:**
- Modify: `apps/worker/src/reframe/plan.ts`
- Test: `apps/worker/src/__tests__/reframe-plan.test.ts`

**Context - read the spec's §3 and §4 first.** Two branches in `buildCropPlan` emit a `single` layout and each
computes `x` its own way:

| where | branch | current expression |
|---|---|---|
| the fit branch | the whole anchorable set fits inside `FIT_MARGIN` | `evenClamp((minX + maxX) / 2 - cropW / 2, ...)` over `anchorable` |
| the group branch | no window holds everyone, `bestFaceGroup` picked a subset | `windowXFor(group, cropW, sourceWidth)` |

**They already produce the same number when the fit branch runs**, because `selectGroupForShot` returns
`anchorable` unchanged when the span fits. That is what makes it legitimate for both to route through one
tie-break definition. Verify it by reading both before you change either.

**`others` is the surviving tracks minus the group, NOT minus `anchorable`.** A face below the min-face guard
still reads as a person when the edge cuts it in half. The guard decides what may *anchor* a window, never
what may be *sliced* by one. §7e had to unpick exactly this conflation when `anchorable` turned out to answer
three questions at once; keep them separate here.

**Do not add a cap on how far the window may move.** §5.1 of the spec forbids it until frames have been
looked at. A number chosen now would be chosen from nothing.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/src/__tests__/reframe-plan.test.ts`:

```ts
describe("placeWindow", () => {
  const CROP = 608;
  const W = 1920;
  const f = (id: number, x: number, w: number) => ({
    id, box: { x, y: 0, w, h: w }, score: 0.9, samples: 9, mouthActivity: 0.05,
  });

  it("returns today's position when there is nothing to avoid", () => {
    // No other faces at all: the tie-break is the only term, so the answer is
    // exactly what the planner computes now. This is the invariant that makes
    // "unchanged where there was no defect" a property rather than a hope.
    const group = [f(0, 700, 200)];
    expect(placeWindow(group, [], CROP, W)).toBe(
      evenClamp(700 + 100 - CROP / 2, CROP, W)
    );
  });

  it("returns today's position when the other face is already whole", () => {
    const group = [f(0, 700, 200)];
    const others = [f(1, 750, 100)];
    expect(placeWindow(group, others, CROP, W)).toBe(
      placeWindow(group, [], CROP, W)
    );
  });

  it("shifts to take in a neighbour that fits, rather than slicing it", () => {
    // The measured defect: two faces spanning 603px in a 608px window. Today
    // the group is one face and the neighbour is cut by the edge.
    const group = [f(0, 614, 250)];
    const others = [f(1, 986, 231)];
    const x = placeWindow(group, others, CROP, W);
    // both must end up whole
    expect(x).toBeLessThanOrEqual(614);
    expect(x + CROP).toBeGreaterThanOrEqual(1217);
  });

  it("shifts to push a neighbour fully out when it cannot fit", () => {
    const group = [f(0, 200, 200)];
    const others = [f(1, 760, 300)]; // 760..1060, cannot join 200..400 in 608px
    const x = placeWindow(group, others, CROP, W);
    const vis = faceVisibility(others[0], x, CROP);
    expect(bisectionSeverity(vis)).toBe(0);
    // and the group is still whole
    expect(x).toBeLessThanOrEqual(200);
    expect(x + CROP).toBeGreaterThanOrEqual(400);
  });

  it("keeps every group member whole even when that costs a cleaner score", () => {
    // Two anchored faces spanning 500px. A neighbour sits where excluding it
    // would require dropping one of them. The group wins.
    const group = [f(0, 600, 200), f(1, 900, 200)];
    const others = [f(2, 1150, 200)];
    const x = placeWindow(group, others, CROP, W);
    for (const g of group) {
      expect(g.box.x).toBeGreaterThanOrEqual(x);
      expect(g.box.x + g.box.w).toBeLessThanOrEqual(x + CROP);
    }
  });

  it("takes the least-bad slice when no position spares everyone", () => {
    // A crowded shot: faces packed so that some face straddles an edge
    // wherever the window goes. The rule must still return the best available,
    // not give up and return today's.
    const group = [f(0, 800, 200)];
    const others = [f(1, 300, 200), f(2, 600, 120), f(3, 1100, 120), f(4, 1400, 200)];
    const x = placeWindow(group, others, CROP, W);
    const worst = Math.max(
      ...others.map((o) => bisectionSeverity(faceVisibility(o, x, CROP)))
    );
    // every legal alternative must be at least as bad
    for (let c = 0; c <= W - CROP; c += 2) {
      if (!(group[0].box.x >= c && group[0].box.x + group[0].box.w <= c + CROP)) continue;
      const alt = Math.max(
        ...others.map((o) => bisectionSeverity(faceVisibility(o, c, CROP)))
      );
      expect(worst).toBeLessThanOrEqual(alt + 1e-9);
    }
  });

  it("falls back to today's position when the group is wider than the window", () => {
    // A close-up. No window holds it whole, so there is no candidate range and
    // the existing clamp stands - which is what 7c already does for this case.
    const group = [f(0, 400, 900)];
    const others = [f(1, 1500, 100)];
    expect(placeWindow(group, others, CROP, W)).toBe(
      placeWindow(group, [], CROP, W)
    );
  });

  it("always returns an even x inside the frame", () => {
    const group = [f(0, 1700, 200)];
    const others = [f(1, 0, 100)];
    const x = placeWindow(group, others, CROP, W);
    expect(x % 2).toBe(0);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(W - CROP);
  });

  it("is deterministic", () => {
    const group = [f(0, 614, 250)];
    const others = [f(1, 986, 231), f(2, 300, 90)];
    const first = placeWindow(group, others, CROP, W);
    for (let i = 0; i < 5; i += 1) {
      expect(placeWindow(group, others, CROP, W)).toBe(first);
    }
  });
});

describe("buildCropPlan window placement", () => {
  it("stops the second face being sliced in the measured defect", () => {
    // The owner's clip, reproduced: two faces at 614..864 and 986..1217 in a
    // 1920x1080 source. Today the window lands at 434 and cuts the second.
    const shots = [{ start: 0, end: 10 }];
    const tracks = [{
      shotIndex: 0,
      camRect: null,
      tracks: [
        { id: 0, box: { x: 614, y: 300, w: 250, h: 250 }, score: 0.9, samples: 12, mouthActivity: 0.05 },
        { id: 1, box: { x: 986, y: 300, w: 231, h: 231 }, score: 0.93, samples: 7, mouthActivity: 0.05 },
      ],
    }];
    const plan = buildCropPlan(shots, tracks, 1920, 1080, DEFAULT_PLAN_OPTIONS, null);
    const shot = plan!.shots[0] as { layout: string; x: number };
    expect(shot.layout).toBe("single");
    // both faces whole in [x, x+608)
    expect(shot.x).toBeLessThanOrEqual(614);
    expect(shot.x + 608).toBeGreaterThanOrEqual(1217);
  });
});
```

Add `placeWindow` to the existing `../reframe/plan` import, and `DEFAULT_PLAN_OPTIONS` from
`../reframe/options` if the test file does not already import it.

- [ ] **Step 2: Run and confirm FAILURE. Do not proceed until you have seen it.**

- [ ] **Step 3: Implement `placeWindow`**

First **export `windowXFor`**. It is currently module-private, `placeWindow` needs it as the tie-break, and
Task 4's diagnostic script needs the same expression - and a second hand-written copy of "where the window
goes today" would drift from this one the moment either changed. Change `function windowXFor(` to
`export function windowXFor(` and nothing else about it.

Then add to `plan.ts`, immediately below it:

```ts
/**
 * Where the crop window goes, given the faces it must hold and the faces it
 * must not cut in half.
 *
 * The window used to be centred on its anchor group and nothing asked what its
 * edges did to anyone else, so a second person just outside the group was
 * sliced down the middle - measured at 225s of 1250s anchored time, in 13 of 53
 * real clips, worst span 68s.
 *
 * Among the positions that keep every group member whole, this takes the one
 * where the worst-cut outsider is least cut, and breaks ties toward the
 * position the planner already computes. Two consequences worth stating:
 *
 *   - when no outsider is cut at any position, the tie-break decides and the
 *     answer is byte-identical to before. "Unchanged where there was no defect"
 *     is therefore a property of this function, not a hope about it.
 *   - when nobody can be spared - a crowded shot where some face straddles an
 *     edge wherever the window goes - it still returns the least-bad position
 *     rather than giving up.
 *
 * `others` must be every surviving face that is not in the group, INCLUDING
 * those below the min-face guard. The guard decides what may anchor a window;
 * it says nothing about who may be sliced by one, and a small face still reads
 * as a person when the edge cuts it in half.
 *
 * No cap on how far the window may move, deliberately. Spec 5.1: that decision
 * waits on frame strips, and a number chosen before them would be chosen from
 * nothing.
 */
export function placeWindow(
  group: FaceTrack[],
  others: FaceTrack[],
  cropW: number,
  sourceWidth: number
): number {
  const todaysX = windowXFor(group, cropW, sourceWidth);
  if (group.length === 0 || others.length === 0) return todaysX;

  // Every group member is whole exactly on this contiguous range.
  const groupLeft = Math.min(...group.map((t) => t.box.x));
  const groupRight = Math.max(...group.map((t) => t.box.x + t.box.w));
  const lo = Math.max(0, Math.ceil((groupRight - cropW) / 2) * 2);
  const hi = Math.min(sourceWidth - cropW, Math.floor(groupLeft / 2) * 2);
  // Empty range: the group is wider than the window - a close-up. 7c already
  // centres on it and accepts the slice; there is no better position to find.
  if (lo > hi) return todaysX;

  let bestX = todaysX;
  let bestWorst = Infinity;
  for (let x = lo; x <= hi; x += 2) {
    let worst = 0;
    for (const other of others) {
      const s = bisectionSeverity(faceVisibility(other, x, cropW));
      if (s > worst) worst = s;
    }
    const better = worst < bestWorst - 1e-9;
    const tied =
      Math.abs(worst - bestWorst) <= 1e-9 &&
      Math.abs(x - todaysX) < Math.abs(bestX - todaysX);
    if (better || tied) {
      bestWorst = worst;
      bestX = x;
    }
  }
  return bestX;
}
```

Note on the loop's seed: `bestX` starts at `todaysX` and `bestWorst` at `Infinity`, so the first legal
candidate always wins on the `better` branch and the tie-break is measured against `todaysX` throughout. If
`todaysX` itself lies in `[lo, hi]` - the common case - it is visited and wins every tie.

- [ ] **Step 4: Rewire both call sites in `buildCropPlan`**

In the fit branch, replace:

```ts
      const x = evenClamp((minX + maxX) / 2 - cropW / 2, cropW, sourceWidth);
```

with:

```ts
      // `tracks` here is already the shot's surviving tracks. Everything not in
      // the group can still be sliced by the edge, guard or no guard (spec 4).
      const x = placeWindow(
        group,
        tracks.filter((t) => !group.includes(t)),
        cropW,
        sourceWidth
      );
```

In the group branch, replace:

```ts
      x: windowXFor(group, cropW, sourceWidth),
```

with:

```ts
      x: placeWindow(
        group,
        tracks.filter((t) => !group.includes(t)),
        cropW,
        sourceWidth
      ),
```

Read the surrounding code first and confirm `tracks` at those points is the surviving set. If the variable
has another name there, use the real one; the requirement is that `others` is every surviving face outside
the group.

- [ ] **Step 5: Verify**

1. Full suite: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/'`
2. `tsc --noEmit` clean.
3. **The nine layout assertions carrying `x` of 496, 656, 596, 386 and 96 must hold at their original
   values.** They are single-face fixtures with nothing to avoid, so the tie-break should return today's
   answer unchanged. If any moved, `others` is picking up a face it should not, or the tie-break is wrong -
   investigate rather than update the expectation.
4. Confirm by name that §7c's test "does not move when mouthActivity moves" passes.

- [ ] **Step 6: MUTATION TESTING - mandatory**

`git add` your files first, or `git checkout --` deletes rather than restores your work.

| # | mutation |
|---|---|
| 1 | `bisectionSeverity` returns `Math.abs(2 * visible - 1)` (inverted) |
| 2 | in `placeWindow`, drop the tie-break so the first best-scoring `x` wins |
| 3 | in `placeWindow`, `if (lo > hi) return todaysX;` deleted |
| 4 | in `placeWindow`, `others.length === 0` removed from the early return |
| 5 | in `placeWindow`, the candidate range becomes the full `[0, sourceWidth - cropW]` (group may be cut) |
| 6 | in the fit branch, `others` becomes `[]` |
| 7 | in the group branch, `placeWindow` reverted to `windowXFor` |
| 8 | `faceVisibility` drops the `Math.max(0, ...)`, allowing negative overlap |

Report a table of which test(s) die per mutation, or SURVIVED.

**Mutations 6 and 7 are the important ones** - each reverts one call site. If either survives, nothing pins
that the branch actually uses the new placement, and that branch is the change. If one survives, say what
test would kill it; **do not silently add one**.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/reframe/plan.ts apps/worker/src/__tests__/reframe-plan.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(reframe): place the window so its edge does not bisect a face"
```

---

## Task 3: The acceptance measurement

**Files:**
- Create: `apps/worker/src/scripts/eval-bisection.ts`

**Context:** Spec §5. The number that must move is 225 seconds of anchored time where the window's edge cuts a
detected face. 140s of that is expected to go to zero; 84s is two crowded shots expected to remain.

**"Near zero" is not an acceptance criterion.** Every remaining span must be printed individually so a human
can judge each one. A remainder that is a detection artefact is a pass; one the rule failed to reach is not;
only the listing separates them.

**A result below 84s is not a win.** It means the rule did something the analysis did not predict, and that
must be understood before the change is trusted. Say so in the output.

- [ ] **Step 1: Write the script**

Create `apps/worker/src/scripts/eval-bisection.ts`:

```ts
/**
 * Acceptance for the window-placement change: how much delivered time has the
 * crop edge cutting a detected face in half?
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-bisection.ts"
 *
 * Re-plans every clip of the real jobs from its own detector run, then walks
 * every `single` shot asking what the window does to the faces it did not
 * anchor. Measured at 225s of 1250s anchored time before the change, in 13 of
 * 53 clips, worst span 68s.
 *
 * A face counts as bisected when 15% to 85% of its width shows. That band is
 * the METRIC's, not the rule's - the rule itself has no threshold (spec 3) and
 * minimises a continuous severity. The band exists here only so the report can
 * say "this many seconds" rather than print a distribution.
 *
 * Faces wider than the window are excluded: they can never be whole, centring
 * on them is correct, and 7c already handles them.
 *
 * Read-only: no database writes, no R2 writes, no job touched.
 */
import { prisma, getPresignedDownloadUrl } from "@clipclap/shared";
import { execFile } from "child_process";
import { promisify } from "util";
import { detectShots } from "../reframe/shots";
import { detectFaces } from "../reframe/faces";
import { resolveCamRect } from "../reframe/cam-rect";
import { buildCropPlan, cropWidthFor, faceVisibility } from "../reframe/plan";
import { loadReframeConfig } from "../reframe/config";
import { DEFAULT_CAMERA } from "../reframe/camera";
import type { FaceTrack } from "../reframe/types";

const execFileAsync = promisify(execFile);
const SINCE = new Date("2026-08-06T00:00:00Z");
const LOW = 0.15;
const HIGH = 0.85;
const BASELINE_TOTAL = 225;
const BASELINE_IRREDUCIBLE = 84;

interface Span {
  clip: string;
  at: number;
  dur: number;
  faces: string;
}

async function probe(url: string, at: number): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0",
    "-read_intervals", `${at}%+1`, url,
  ], { maxBuffer: 32 * 1024 * 1024 });
  const [width, height] = stdout.trim().split("x").map(Number);
  if (!width || !height) throw new Error("probe_failed");
  return { width, height };
}

async function main() {
  const cfg = loadReframeConfig();
  const jobs = await prisma.job.findMany({
    where: { createdAt: { gte: SINCE }, normalizedArtifactKey: { not: null } },
    select: {
      normalizedArtifactKey: true,
      clips: {
        where: { deletedAt: null },
        select: { id: true, title: true, startTime: true, endTime: true },
      },
    },
  });

  let anchored = 0;
  let bisected = 0;
  let oversizeSkipped = 0;
  const spans: Span[] = [];
  const clipsHit = new Set<string>();
  let clipsSeen = 0;

  for (const job of jobs) {
    const url = await getPresignedDownloadUrl(job.normalizedArtifactKey!, 7200);
    for (const clip of job.clips) {
      try {
        const { width: W, height: H } = await probe(url, clip.startTime);
        const cropW = cropWidthFor(H);
        const shots = await detectShots(url, clip.startTime, clip.endTime, cfg, 120_000);
        const tracks = await detectFaces(
          url, clip.startTime, clip.endTime, shots, W, H, cfg, 180_000
        );
        const cam = resolveCamRect(tracks.map((t) => t.camRect), W, H);
        const plan = buildCropPlan(shots, tracks, W, H, {
          faceSmallFrac: cfg.faceSmallFrac,
          faceLargeFrac: cfg.faceLargeFrac,
          stream: cfg.stream,
          camShare: cfg.camShare,
          motion: false,
          camera: DEFAULT_CAMERA,
        }, cam);
        if (!plan) continue;
        clipsSeen += 1;

        for (const shot of plan.shots) {
          if (shot.layout !== "single") continue;
          const dur = shot.end - shot.start;
          anchored += dur;
          const overlapping = shots
            .map((s, i) => [s, i] as const)
            .filter(([s]) => s.end > shot.start && s.start < shot.end);
          const all: FaceTrack[] = overlapping
            .flatMap(([, i]) => tracks.find((t) => t.shotIndex === i)?.tracks ?? [])
            .filter((t) => t.samples >= 2);
          const scorable = all.filter((t) => t.box.w <= cropW);
          if (all.length > 0 && scorable.length === 0) oversizeSkipped += dur;
          const cut = scorable.filter((t) => {
            const v = faceVisibility(t, shot.x, cropW);
            return v > LOW && v < HIGH;
          });
          if (cut.length === 0) continue;
          bisected += dur;
          clipsHit.add(clip.id);
          spans.push({
            clip: clip.title.slice(0, 38),
            at: shot.start,
            dur,
            faces: cut
              .map((t) => `${(100 * faceVisibility(t, shot.x, cropW)).toFixed(0)}%vis/${(100 * t.box.w / W).toFixed(1)}%w`)
              .join(" "),
          });
        }
      } catch (error) {
        console.error(`  ! ${clip.id}: ${(error as Error).message.slice(0, 70)}`);
      }
    }
  }

  console.log(`corpus                        : ${clipsSeen} clips`);
  console.log(`time on an anchored crop      : ${anchored.toFixed(0)}s`);
  console.log(`  a face is bisected by the edge: ${bisected.toFixed(0)}s (${((100 * bisected) / anchored).toFixed(1)}%)  was ${BASELINE_TOTAL}s`);
  console.log(`  clips affected                : ${clipsHit.size} of ${clipsSeen}  was 13 of 53`);
  console.log(`  excluded, face wider than the window: ${oversizeSkipped.toFixed(0)}s`);
  console.log("");
  console.log(`every remaining bisected span, for one-by-one judgement (${spans.length}):`);
  for (const s of spans.sort((a, b) => b.dur - a.dur)) {
    console.log(`  ${s.dur.toFixed(1).padStart(6)}s @${s.at.toFixed(1).padStart(6)}s  ${s.faces.padEnd(34)} ${s.clip}`);
  }
  if (spans.length === 0) console.log("  none");
  console.log("");
  if (bisected > BASELINE_IRREDUCIBLE + 1) {
    console.log(`ABOVE the ${BASELINE_IRREDUCIBLE}s the analysis predicted would remain. Some resolvable span was not reached - find it in the listing above.`);
  } else if (bisected < BASELINE_IRREDUCIBLE - 1) {
    console.log(`BELOW the ${BASELINE_IRREDUCIBLE}s the analysis predicted would remain. This is NOT a win until it is explained: the rule did something the analysis did not predict.`);
  } else {
    console.log(`At the ${BASELINE_IRREDUCIBLE}s the analysis predicted - the two crowded shots. Confirm the listing is those two and nothing else.`);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'`
Expected: no output.

- [ ] **Step 3: Run and report**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/eval-bisection.ts'`

It takes several minutes - it re-runs the detector over every clip.

**Report the full output verbatim, and give a one-line judgement on every span in the listing.** Is it one of
the two crowded shots the analysis predicted, a detection artefact, or a case the rule failed to reach?

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/scripts/eval-bisection.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "test(reframe): measure edge-bisected faces span by span"
```

---

## Task 4: The frame strips, and the cap decision

**Files:**
- Create: `apps/worker/src/scripts/eval-shift-sheets.ts`

**Context:** Spec §5.1. The window will move on roughly 18% of anchored time, median 36px of 608 but maximum
140px - 23% of the window width. There is a regression no measurement in this plan can see: a shot where
nobody was cut before and nobody is cut after, but the subject has been pushed toward the edge to spare a
face the viewer would never have noticed.

**The order is fixed and must not be reordered:** implement uncapped, render the worst shifts, then decide
whether a cap is warranted. Do not add a cap in this task whatever you see - report, and the decision is the
owner's.

- [ ] **Step 1: Write the script**

Create `apps/worker/src/scripts/eval-shift-sheets.ts`:

```ts
/**
 * Before/after strips for the window-placement change, chosen by how far the
 * window moved rather than by what looks good.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-shift-sheets.ts"
 *
 * The measurement in eval-bisection.ts says the edge stopped cutting people.
 * It cannot say whether the subject is still well framed, and the largest
 * shifts are where it would stop being so. This renders the same instant twice
 * - once at the old x, once at the new - so a human can compare.
 *
 * Writes PNGs to .corpus/shift-sheets/ and nothing else.
 */
import { prisma, getPresignedDownloadUrl } from "@clipclap/shared";
import { execFile } from "child_process";
import { mkdir } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { detectShots } from "../reframe/shots";
import { detectFaces } from "../reframe/faces";
import { resolveCamRect } from "../reframe/cam-rect";
import {
  buildCropPlan, cropWidthFor, placeWindow, selectGroupForShot, windowXFor,
} from "../reframe/plan";
import { loadReframeConfig } from "../reframe/config";
import { DEFAULT_CAMERA } from "../reframe/camera";
import { loadManifest, corpusDir } from "./corpus-fetch";
import type { FaceTrack } from "../reframe/types";

const execFileAsync = promisify(execFile);
const SINCE = new Date("2026-08-06T00:00:00Z");
const TOP_N = 6;

interface Case {
  label: string;
  url: string;
  at: number;
  oldX: number;
  newX: number;
  cropW: number;
  height: number;
  shift: number;
}

/** One frame through a fixed crop, scaled to a readable width. */
async function frame(url: string, at: number, x: number, cropW: number, h: number, out: string) {
  await execFileAsync("ffmpeg", [
    "-nostdin", "-v", "error", "-ss", String(at), "-i", url,
    "-vf", `crop=w=${cropW}:h=${h}:x=${x}:y=0,scale=300:-2`,
    "-frames:v", "1", "-y", out,
  ], { maxBuffer: 64 * 1024 * 1024 });
}

async function main() {
  const cfg = loadReframeConfig();
  const manifest = await loadManifest();
  const outDir = join(corpusDir(manifest), "shift-sheets");
  await mkdir(outDir, { recursive: true });

  const jobs = await prisma.job.findMany({
    where: { createdAt: { gte: SINCE }, normalizedArtifactKey: { not: null } },
    select: {
      normalizedArtifactKey: true,
      clips: { where: { deletedAt: null }, select: { title: true, startTime: true, endTime: true } },
    },
  });

  const cases: Case[] = [];
  for (const job of jobs) {
    const url = await getPresignedDownloadUrl(job.normalizedArtifactKey!, 7200);
    for (const clip of job.clips) {
      try {
        const W = 1920, H = 1080, cropW = cropWidthFor(H);
        const shots = await detectShots(url, clip.startTime, clip.endTime, cfg, 120_000);
        const tracks = await detectFaces(url, clip.startTime, clip.endTime, shots, W, H, cfg, 180_000);
        const cam = resolveCamRect(tracks.map((t) => t.camRect), W, H);
        const plan = buildCropPlan(shots, tracks, W, H, {
          faceSmallFrac: cfg.faceSmallFrac, faceLargeFrac: cfg.faceLargeFrac,
          stream: cfg.stream, camShare: cfg.camShare, motion: false, camera: DEFAULT_CAMERA,
        }, cam);
        if (!plan || plan.source.width !== W) continue;

        for (const [i, shot] of shots.entries()) {
          const ts = (tracks.find((t) => t.shotIndex === i)?.tracks ?? []).filter((t) => t.samples >= 2);
          if (ts.length === 0) continue;
          const group = selectGroupForShot(
            ts,
            { minFaceWidth: cfg.faceSmallFrac * W, sourceClass: plan.profile?.class ?? "normal_face", camRect: cam?.rect ?? null },
            cropW, W
          );
          if (!group) continue;
          const others: FaceTrack[] = ts.filter((t) => !group.includes(t));
          // windowXFor IS the old placement, so call it rather than reproducing
          // the arithmetic. A second copy would drift the moment either moved,
          // and this script exists to compare the two - a drifted "before" would
          // make every strip a comparison against something that never shipped.
          const oldX = windowXFor(group, cropW, W);
          const newX = placeWindow(group, others, cropW, W);
          if (oldX === newX) continue;
          cases.push({
            label: `${clip.title.slice(0, 28).replace(/[^\p{L}\p{N}]+/gu, "-")}-${shot.start.toFixed(0)}s`,
            url, at: clip.startTime + (shot.start + shot.end) / 2,
            oldX, newX, cropW, height: H, shift: Math.abs(newX - oldX),
          });
        }
      } catch (error) {
        console.error(`  ! ${(error as Error).message.slice(0, 70)}`);
      }
    }
  }

  cases.sort((a, b) => b.shift - a.shift);
  console.log(`window moved on ${cases.length} shots; rendering the ${TOP_N} largest shifts\n`);
  for (const c of cases.slice(0, TOP_N)) {
    const before = join(outDir, `${c.label}-before.png`);
    const after = join(outDir, `${c.label}-after.png`);
    await frame(c.url, c.at, c.oldX, c.cropW, c.height, before);
    await frame(c.url, c.at, c.newX, c.cropW, c.height, after);
    const pair = join(outDir, `${c.label}-pair.png`);
    await execFileAsync("ffmpeg", ["-v", "error", "-i", before, "-i", after,
      "-filter_complex", "[0][1]hstack=inputs=2", "-y", pair], { maxBuffer: 64e6 });
    console.log(`shift ${String(c.shift).padStart(4)}px  x ${c.oldX} -> ${c.newX}  ${c.label}`);
    console.log(`   ${pair}`);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

**One risk in this script, stated so it is not mistaken for rigour.** It rebuilds the anchor group by calling
`selectGroupForShot` with `plan.profile?.class ?? "normal_face"`. If a clip's profile were ever absent, that
default would silently score a different group than the planner used - the metric-drift failure §7e's
containment script refuses outright rather than defaults around. It is tolerable here because this script
picks which frames to LOOK AT rather than producing an acceptance number, and the frames themselves are the
evidence. If it ever becomes a metric, make it refuse instead.

- [ ] **Step 2: Run it**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/eval-shift-sheets.ts'`

- [ ] **Step 3: Look at every pair and describe what you see**

Use the Read tool on each `-pair.png`. Left is the old window, right is the new. For each, in words:

- what is in frame before, and what is in frame after
- **is the subject still well composed after the shift, or has it been pushed toward the edge?**
- was a person actually being cut before, and is that person now whole or now gone?

**Report plainly if the framing got worse.** A shift that removes a bisection but leaves the main subject
jammed against the edge is the regression §5.1 predicts, and finding one is a useful result, not a failure of
the task. Do not add a cap - report, and let the owner decide.

- [ ] **Step 4: Commit the script**

```bash
git add apps/worker/src/scripts/eval-shift-sheets.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "test(reframe): before/after strips ranked by how far the window moved"
```

`.corpus/` is gitignored, so the PNGs are not committed. That is intended.

---

## Task 5: Record it

**Files:**
- Modify: `docs/engine-notes.md`

- [ ] **Step 1: Add §7f**

Add a `### 7f.` section immediately after §7e containing:

- the defect: the window was centred on its anchor group and nothing asked what its edges did to anyone else;
  the owner's clip with the two faces spanning 603px in a 608px window, rejected by `FIT_MARGIN`; 225s of
  1250s anchored time, 13 clips of 53, worst span 68s
- the rule as the scoring function, and why it needs no threshold - `bisectionSeverity` is exactly zero when
  a face is wholly in or wholly out
- why the tie-break is today's expression, and that "unchanged where there was no defect" is therefore a
  property rather than a test result
- **the two alternatives that measurement killed**: narrow-tile split, which is buildable (the 960x853
  geometry renders to 1080x1920 at SAR 1:1, contradicting §7b) and needed for 0 of the 225s; and anchor
  switching, whose 84s is two shots with alternative anchors at 0.85 and 0.08 of the largest - a rule on n=2
- the acceptance result from Task 3, **with every remaining span named**
- what the frame strips showed in Task 4, in words, and whether a shift cap was judged necessary
- the limitation from spec §3.1: the largest face is not the speaker, and the residual sits where that
  assumption is weakest

- [ ] **Step 2: Full verification**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/'
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/eval-camera-invariance.ts'
```

The invariance script's level 1 must still report 0 differences over the persisted plans - those are read
back, not recomputed. **Levels 2 and 3 compare against baselines captured under the old placement, so they
are expected to differ.** Report their numbers and say plainly which differences are intended. Note that
level 3 re-renders the CAPTURED plan and so is insensitive to any planner change - §7e records that trap.

- [ ] **Step 3: Commit and merge**

```bash
git add docs/engine-notes.md
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "docs(engine): 7f - the window no longer cuts people in half"
git checkout main && git merge --no-ff feat/window-placement
```

---

## Rollback

No flag. The change is one function and two call sites in `plan.ts`; reverting the merge restores the
previous behaviour exactly. Stored `cropPlan` records are unaffected - they are read back rather than
recomputed.

The production signal to watch is the layout mix in `renderManifest`: this change never alters which layout a
shot gets, only where a `single` window sits, so any change in the `single`/`center`/`split` proportions
after this merge means something other than this change moved.
