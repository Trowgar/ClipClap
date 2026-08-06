# Small-Face Anchoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop the planner refusing every face in a wide two-shot and framing the table between them, without
letting a streamer's webcam become an anchor.

**Architecture:** A 6%-of-frame-width minimum-face guard is currently applied to every face on every source.
It exists for one case - a webcam inset on a stream. This plan scopes it: a face may anchor the window when
its clip classified `normal_face` and the face is not inside a resolved webcam rectangle. The threshold is
unchanged, no constant is added, and the two existing uses of `minFaceWidth` become two separately named
functions so a later reader cannot merge them back.

**Spec:** `docs/superpowers/specs/2026-08-06-small-face-anchoring-design.md`. Read §3 and §3.2 before
touching `plan.ts`.

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

**Branch:** `git checkout -b feat/small-face-anchor` from `main` before Task 1.

**Baseline to beat:** 1099 tests passing, `tsc` clean. The corpus is already materialised at
`apps/worker/.corpus/` with baselines and `<id>.plan.json` captures from the Layer 0 work.

---

## File structure

| file | responsibility | task |
|---|---|---|
| `apps/worker/src/reframe/plan.ts` | extract `isInsideInset`; add `hasNormalSizedFace` and `canAnchor`; rewire | 1, 2 |
| `apps/worker/src/__tests__/reframe-plan.test.ts` | tests for both helpers and the rewired selection | 1, 2 |
| `apps/worker/src/scripts/eval-camera-containment.ts` | one call site updated for the new signature | 2 |
| `apps/worker/src/scripts/eval-blind-centre.ts` | new. The acceptance measurement, before and after | 3 |
| `apps/worker/src/scripts/eval-anchor-sheets.ts` | new. Before/after frame strips for the four required cases | 4 |
| `docs/engine-notes.md` | §7e | 5 |

---

## Task 1: Extract the containment predicate

**Files:**
- Modify: `apps/worker/src/reframe/plan.ts:205-213`
- Test: `apps/worker/src/__tests__/reframe-plan.test.ts`

**Context:** `faceInInset(tracks, rect)` answers "does any face sit in the inset" and is used to decide
whether a stream shot shows the streamer. The new rule needs the same test **per face**. The 2px tolerance
must not be duplicated - it exists because both the rect and the track box are medians, so exact containment
is luck, and a second copy would drift from it.

This task is a pure extraction. No behaviour changes.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/__tests__/reframe-plan.test.ts`:

```ts
describe("isInsideInset", () => {
  const rect = { x: 100, y: 50, w: 200, h: 150, score: 5 };
  const face = (x: number, y: number, w = 40, h = 40) => ({
    id: 0, box: { x, y, w, h }, score: 0.9, samples: 5, mouthActivity: 0.05,
  });

  it("accepts a face wholly inside", () => {
    expect(isInsideInset(face(150, 80), rect)).toBe(true);
  });

  it("rejects a face wholly outside", () => {
    expect(isInsideInset(face(900, 80), rect)).toBe(false);
  });

  it("rejects a face that only half overlaps", () => {
    expect(isInsideInset(face(280, 80), rect)).toBe(false);
  });

  it("tolerates 2px of slop on every edge, because both boxes are medians", () => {
    // exactly 2px outside on the left and top, and 2px past the right and bottom
    expect(isInsideInset({ ...face(98, 48), box: { x: 98, y: 48, w: 204, h: 154 } }, rect))
      .toBe(true);
  });

  it("rejects 3px of slop", () => {
    expect(isInsideInset({ ...face(97, 47), box: { x: 97, y: 47, w: 206, h: 156 } }, rect))
      .toBe(false);
  });
});
```

Add `isInsideInset` to the existing `../reframe/plan` import in that file.

- [ ] **Step 2: Run and confirm FAILURE**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/reframe-plan.test.ts'`
Expected: FAIL - `isInsideInset` is not exported.

- [ ] **Step 3: Extract it**

In `apps/worker/src/reframe/plan.ts`, replace the existing `faceInInset` with:

```ts
/** Is this face inside the resolved inset?
 *
 *  Tolerant by 2px on each edge: the rect is a median of per-shot detections and
 *  the track box is a median of per-sample boxes, so exact containment is luck.
 *
 *  Exported because two different questions need it - "does this shot show the
 *  streamer" and "may this face anchor the window" - and a second copy of the
 *  tolerance would drift from this one. The tolerance is the part that was
 *  reasoned about; the comparison is not. */
export function isInsideInset(track: FaceTrack, rect: CamRect): boolean {
  return (
    track.box.x >= rect.x - 2 &&
    track.box.x + track.box.w <= rect.x + rect.w + 2 &&
    track.box.y >= rect.y - 2 &&
    track.box.y + track.box.h <= rect.y + rect.h + 2
  );
}

/** The face this shot shows inside the resolved inset, if any. */
function faceInInset(tracks: FaceTrack[], rect: CamRect): FaceTrack | undefined {
  return tracks.find((t) => isInsideInset(t, rect));
}
```

- [ ] **Step 4: Run tests**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/'`
Expected: PASS, with every pre-existing assertion at its original value. This is a pure move - if any
pre-existing test changes, you have changed behaviour and must stop and report it.

- [ ] **Step 5: Typecheck and commit**

```bash
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'
git add apps/worker/src/reframe/plan.ts apps/worker/src/__tests__/reframe-plan.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "refactor(reframe): extract the inset containment predicate, no behaviour change"
```

---

## Task 2: Two named questions, and the new anchor rule

**Files:**
- Modify: `apps/worker/src/reframe/plan.ts`
- Modify: `apps/worker/src/scripts/eval-camera-containment.ts:393`
- Test: `apps/worker/src/__tests__/reframe-plan.test.ts`

**Context - read this before writing code.** `minFaceWidth` currently answers two unrelated questions with
one expression:

| question | today | after |
|---|---|---|
| is this clip stream-shaped? | `widestFace >= minFaceWidth` | **unchanged, absolute** |
| may this face anchor the window? | `t.box.w >= minFaceWidth` | conditional |

The failure mode this task exists to prevent is a later reader seeing `minFaceWidth` twice, "unifying" it,
and either breaking the stream layout or making the streamer's webcam an anchor. Both are the defect
engine-notes §7a was written to fix. **Two separately named functions, named for the question, not the
threshold.**

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/src/__tests__/reframe-plan.test.ts`:

```ts
describe("hasNormalSizedFace", () => {
  it("is true at and above the guard", () => {
    expect(hasNormalSizedFace(115, 115)).toBe(true);
    expect(hasNormalSizedFace(300, 115)).toBe(true);
  });
  it("is false below it", () => {
    expect(hasNormalSizedFace(114, 115)).toBe(false);
    expect(hasNormalSizedFace(0, 115)).toBe(false);
  });
});

describe("canAnchor", () => {
  const rect = { x: 0, y: 0, w: 300, h: 200, score: 5 };
  const face = (x: number, w: number) => ({
    id: 0, box: { x, y: 10, w, h: w }, score: 0.9, samples: 9, mouthActivity: 0.05,
  });
  const GUARD = 115;

  it("accepts any face at or above the guard, whatever the class", () => {
    for (const cls of ["normal_face", "small_face", "stream", "faceless"] as const) {
      expect(canAnchor(face(500, 200), GUARD, cls, null)).toBe(true);
    }
  });

  it("accepts a small face on a normal_face clip with no inset", () => {
    // The measured defect: two men at 5.2% and 5.5% of a 1920 frame, both
    // refused, so the window centred on the table between them.
    expect(canAnchor(face(435, 101), GUARD, "normal_face", null)).toBe(true);
  });

  it("refuses a small face on a small_face clip", () => {
    // Stream-shaped. Both small_face clips in the corpus are stream_no_rect,
    // including the Booster CS2 source, and this is what stops the streamer's
    // 3.1% webcam face becoming an anchor.
    expect(canAnchor(face(435, 60), GUARD, "small_face", null)).toBe(false);
  });

  it("refuses a small face on a stream clip", () => {
    expect(canAnchor(face(435, 60), GUARD, "stream", null)).toBe(false);
  });

  it("refuses a small face that sits inside the inset, even on normal_face", () => {
    expect(canAnchor(face(20, 60), GUARD, "normal_face", rect)).toBe(false);
  });

  it("accepts a small face outside the inset on a normal_face clip", () => {
    expect(canAnchor(face(900, 60), GUARD, "normal_face", rect)).toBe(true);
  });
});

describe("selectGroupForShot under the anchor policy", () => {
  const t = (id: number, x: number, w = 60) => ({
    id, box: { x, y: 0, w, h: 60 }, score: 0.9, samples: 10, mouthActivity: 0.05,
  });
  const strict = { minFaceWidth: 115, sourceClass: "small_face" as const, camRect: null };
  const relaxed = { minFaceWidth: 115, sourceClass: "normal_face" as const, camRect: null };

  it("returns null on a stream-shaped clip whose faces are all small", () => {
    expect(selectGroupForShot([t(0, 435, 101), t(1, 1481, 106)], strict, 608, 1920)).toBeNull();
  });

  it("anchors on those same faces when the clip is normal_face", () => {
    const group = selectGroupForShot([t(0, 435, 101), t(1, 1481, 106)], relaxed, 608, 1920);
    expect(group).not.toBeNull();
    expect(group!.length).toBeGreaterThan(0);
  });

  it("still returns null when there are no tracks at all", () => {
    expect(selectGroupForShot([], relaxed, 608, 1920)).toBeNull();
  });
});
```

Add `hasNormalSizedFace` and `canAnchor` to the `../reframe/plan` import.

**Every pre-existing `selectGroupForShot` call in this file must also be updated** to the new signature -
they currently pass `40` as the second argument. Replace that argument with
`{ minFaceWidth: 40, sourceClass: "normal_face", camRect: null }`, which preserves what each of those tests
was checking, and add a comment above the describe saying so.

- [ ] **Step 2: Run and confirm FAILURE**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/reframe-plan.test.ts'`
Expected: FAIL - the helpers do not exist and the signature does not match.

- [ ] **Step 3: Add the two named questions**

In `apps/worker/src/reframe/plan.ts`, above `selectGroupForShot`:

```ts
/**
 * Question one: is this clip stream-shaped?
 *
 * The ABSOLUTE guard, unchanged, and the thing that decides `normal_face` versus
 * `small_face` and therefore whether the stream layout is even considered.
 *
 * Deliberately a different function from `canAnchor` even though both read
 * `minFaceWidth`. They answer different questions and now answer them
 * differently; merging them back breaks the stream layout in one direction and
 * makes a streamer's webcam an anchor in the other, which is engine-notes 7a's
 * defect from either side.
 */
export function hasNormalSizedFace(
  widestFace: number,
  minFaceWidth: number
): boolean {
  return widestFace >= minFaceWidth;
}

/**
 * Question two: may this face anchor the crop window?
 *
 * The guard exists for one case - a streamer's webcam inset, where centring a
 * 9:16 window on a small face yields a truncated webcam plus a slice of chat
 * overlay (7a, measured). Applied to every source it also refuses the two men at
 * opposite ends of a podcast table, at 5.2% and 5.5% of frame width, and centres
 * on the table between them. Measured at 298 seconds of 1679 delivered.
 *
 * So the guard is relaxed only where the case it protects cannot arise:
 *   - the clip must classify `normal_face`. Classification runs per clip, and
 *     both `small_face` clips in the corpus are the stream-shaped ones,
 *     including the Booster CS2 source. This condition is what makes the webcam
 *     unreachable as an anchor, by construction rather than by inspection.
 *   - the face must not sit inside a resolved inset. Belt and braces: no
 *     measured case needs it, it costs nothing because the predicate already
 *     exists, and it closes a clip that classifies `normal_face` on a large
 *     facecam while carrying a small inset as well.
 *
 * No new constant. `minFaceWidth` is unchanged at 6% of frame width.
 */
export function canAnchor(
  track: FaceTrack,
  minFaceWidth: number,
  sourceClass: SourceClass,
  camRect: CamRect | null
): boolean {
  if (track.box.w >= minFaceWidth) return true;
  if (sourceClass !== "normal_face") return false;
  if (camRect && isInsideInset(track, camRect)) return false;
  return true;
}
```

Add `SourceClass` to the type import from `./types` if it is not already there.

- [ ] **Step 4: Give `selectGroupForShot` a policy**

Replace its signature and guard filter:

```ts
/** What governs whether a face may anchor. Passed as one object so a caller
 *  cannot supply the threshold and forget the class - the combination is the
 *  rule, not the number. */
export interface AnchorPolicy {
  minFaceWidth: number;
  sourceClass: SourceClass;
  camRect: CamRect | null;
}

export function selectGroupForShot(
  tracks: FaceTrack[],
  policy: AnchorPolicy,
  cropW: number,
  sourceWidth: number
): FaceTrack[] | null {
  const anchorable = survivingTracks(tracks).filter((t) =>
    canAnchor(t, policy.minFaceWidth, policy.sourceClass, policy.camRect)
  );
  if (anchorable.length === 0) return null;
  const minX = Math.min(...anchorable.map((t) => t.box.x));
  const maxX = Math.max(...anchorable.map((t) => t.box.x + t.box.w));
  if (maxX - minX <= FIT_MARGIN * cropW) return anchorable;
  return bestFaceGroup(anchorable, cropW, sourceWidth);
}
```

Keep the whole existing docstring above it and add one line recording that the guard is now conditional.

- [ ] **Step 5: Rewire `buildCropPlan`**

Two edits inside `buildCropPlan`.

First, the classification branch. Replace `} else if (widestFace >= minFaceWidth) {` with:

```ts
  } else if (hasNormalSizedFace(widestFace, minFaceWidth)) {
```

Second, inside the `shots.map` callback. The `anchorable` filter at the top of the non-stream path and the
`selectGroupForShot` call must both go through the policy. Build the policy once above the callback:

```ts
  // The anchor rule. `profile` is settled before this point, which is what lets
  // the rule read the class. Built once so the two reads below cannot disagree.
  const anchorPolicy: AnchorPolicy = {
    minFaceWidth,
    sourceClass: profile.class,
    camRect,
  };
```

Then replace:

```ts
    const anchorable = tracks.filter((t) => t.box.w >= minFaceWidth);
```

with:

```ts
    const anchorable = tracks.filter((t) =>
      canAnchor(t, anchorPolicy.minFaceWidth, anchorPolicy.sourceClass, anchorPolicy.camRect)
    );
```

and replace:

```ts
    const group = selectGroupForShot(tracks, minFaceWidth, cropW, sourceWidth);
```

with:

```ts
    const group = selectGroupForShot(tracks, anchorPolicy, cropW, sourceWidth);
```

- [ ] **Step 6: Update the one script call site**

In `apps/worker/src/scripts/eval-camera-containment.ts` around line 393, the call passes `minFaceWidth`.
Replace it with the policy object, reading the class and rect from the captured plan:

```ts
      const group = selectGroupForShot(
        tracks,
        {
          minFaceWidth,
          sourceClass: cap.plan.profile?.class ?? "normal_face",
          camRect: resolveCamRect(cap.tracks.map((t) => t.camRect), W, H)?.rect ?? null,
        },
        cropW,
        W
      );
```

Import `resolveCamRect` from `../reframe/cam-rect` if it is not already imported there.

**Read the surrounding code and adapt the variable names to what is actually there** - that file already
computes `W`, `H`, `cropW`, `minFaceWidth` and the captured `cap`, but under whatever names it chose. The
requirement is not the names: it is that the script asks the planner the same question the planner asks
itself, which is the property that file's own docstring claims and the reason it calls `selectGroupForShot`
rather than re-deriving the group. If you cannot make it ask the same question, stop and report that -
silently letting the metric drift from the planner is the specific failure this whole design guards against.

- [ ] **Step 7: Run everything**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/'
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'
```

Expected: PASS. **The nine layout assertions in `reframe-plan.test.ts` carrying `x` of 496, 656, 596, 386 and
96 must hold at their original values** - they are the guard that behaviour above 6% is untouched. Confirm by
name that the §7c test "does not move when mouthActivity moves" still passes.

- [ ] **Step 8: MUTATION TESTING - mandatory**

`git add` your files first, or `git checkout --` deletes rather than restores.

| # | mutation |
|---|---|
| 1 | in `canAnchor`, `if (sourceClass !== "normal_face") return false;` deleted |
| 2 | in `canAnchor`, `if (camRect && isInsideInset(...)) return false;` deleted |
| 3 | in `canAnchor`, `if (track.box.w >= minFaceWidth) return true;` deleted |
| 4 | in `canAnchor`, `sourceClass !== "normal_face"` becomes `sourceClass === "normal_face"` |
| 5 | in `buildCropPlan`, the `anchorable` filter reverts to `t.box.w >= minFaceWidth` |
| 6 | `hasNormalSizedFace` returns `widestFace > minFaceWidth` (strict) |

Report a table of which test(s) die per mutation, or SURVIVED. **If one survives, report it - do not
silently add a test.** Mutation 5 in particular: if it survives, nothing pins that `buildCropPlan` actually
uses the new rule, and that is the whole change.

- [ ] **Step 9: Commit**

```bash
git add apps/worker/src/reframe/plan.ts apps/worker/src/scripts/eval-camera-containment.ts apps/worker/src/__tests__/reframe-plan.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(reframe): scope the min-face guard to the case it was built for"
```

---

## Task 3: The acceptance measurement

**Files:**
- Create: `apps/worker/src/scripts/eval-blind-centre.ts`

**Context:** Spec §5. The number that must move is 298 seconds of blind-centre time where real people are
visible in the source. This script produces it, and it must be runnable both before and after the change -
it takes the rule from `buildCropPlan`, so running it on this branch measures the new behaviour and running
it on `main` measures the old.

- [ ] **Step 1: Write the script**

Create `apps/worker/src/scripts/eval-blind-centre.ts`:

```ts
/**
 * Acceptance for the small-face anchoring change: how much delivered time is
 * framed on nothing while people are visible in the source?
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-blind-centre.ts"
 *
 * Re-plans every clip of the real jobs from its own detector run and splits the
 * centre-crop time three ways. The middle bucket is the defect: measured at 298
 * seconds of 1679 delivered before this change.
 *
 * "Near zero" is not an acceptance criterion. Every remaining second is printed
 * with its clip, its shot and its face sizes so it can be inspected one by one -
 * a remainder that is genuinely a one-frame detection artefact is a pass, and a
 * remainder the rule failed to reach is not, and only the listing tells them
 * apart.
 *
 * Read-only: no database writes, no R2 writes, no job touched.
 */
import { prisma, getPresignedDownloadUrl } from "@clipclap/shared";
import { detectShots } from "../reframe/shots";
import { detectFaces } from "../reframe/faces";
import { resolveCamRect } from "../reframe/cam-rect";
import { buildCropPlan } from "../reframe/plan";
import { loadReframeConfig } from "../reframe/config";
import { DEFAULT_CAMERA } from "../reframe/camera";
import type { CropPlan, FaceTrack } from "../reframe/types";

const SINCE = new Date("2026-08-06T00:00:00Z");

interface Remainder {
  clip: string;
  span: string;
  faces: string;
}

async function main() {
  const cfg = loadReframeConfig();
  const jobs = await prisma.job.findMany({
    where: { createdAt: { gte: SINCE }, normalizedArtifactKey: { not: null } },
    select: {
      id: true,
      originalFilename: true,
      normalizedArtifactKey: true,
      clips: {
        where: { deletedAt: null },
        select: { id: true, title: true, startTime: true, endTime: true },
      },
    },
  });

  let noFace = 0;
  let underGuard = 0;
  let otherCause = 0;
  let deliveredSec = 0;
  const remainders: Remainder[] = [];

  for (const job of jobs) {
    const url = await getPresignedDownloadUrl(job.normalizedArtifactKey!, 7200);
    for (const clip of job.clips) {
      deliveredSec += clip.endTime - clip.startTime;
      try {
        const { width: W, height: H } = await probe(url, clip.startTime);
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

        const guard = cfg.faceSmallFrac * W;
        for (const shot of plan.shots) {
          if (shot.layout !== "center") continue;
          const dur = shot.end - shot.start;
          const overlapping = shots
            .map((s, i) => [s, i] as const)
            .filter(([s]) => s.end > shot.start && s.start < shot.end);
          const ts: FaceTrack[] = overlapping
            .flatMap(([, i]) => tracks.find((t) => t.shotIndex === i)?.tracks ?? [])
            .filter((t) => t.samples >= 2);
          if (ts.length === 0) { noFace += dur; continue; }
          if (ts.some((t) => t.box.w >= guard)) { otherCause += dur; continue; }
          underGuard += dur;
          remainders.push({
            clip: clip.title.slice(0, 40),
            span: `${shot.start.toFixed(1)}-${shot.end.toFixed(1)}s (${dur.toFixed(1)}s)`,
            faces: ts
              .map((t) => `${(100 * t.box.w / W).toFixed(1)}%/${t.samples}smp`)
              .join(" "),
          });
        }
      } catch (error) {
        console.error(`  ! ${clip.id}: ${(error as Error).message.slice(0, 70)}`);
      }
    }
  }

  const centre = noFace + underGuard + otherCause;
  const pct = (n: number) => (centre > 0 ? `${((100 * n) / centre).toFixed(1)}%` : "-");
  console.log(`delivered clip time            : ${deliveredSec.toFixed(0)}s`);
  console.log(`on a blind centre crop         : ${centre.toFixed(0)}s`);
  console.log("");
  console.log(`  no face detected at all      : ${noFace.toFixed(0)}s (${pct(noFace)})  centring is CORRECT`);
  console.log(`  people present, all under 6% : ${underGuard.toFixed(0)}s (${pct(underGuard)})  THE DEFECT - was 298s`);
  console.log(`  some face over 6%            : ${otherCause.toFixed(0)}s (${pct(otherCause)})  spread too wide, other cause`);
  console.log("");
  console.log(
    `defect as a share of delivered time: ${((100 * underGuard) / deliveredSec).toFixed(1)}%  (was 17.7%)`
  );
  console.log("");
  console.log(`every remaining defective span, for one-by-one inspection (${remainders.length}):`);
  for (const r of remainders) {
    console.log(`  ${r.span.padEnd(22)} ${r.faces.padEnd(34)} ${r.clip}`);
  }
  if (remainders.length === 0) console.log("  none");

  await prisma.$disconnect();
}

async function probe(url: string, at: number): Promise<{ width: number; height: number }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0",
    "-read_intervals", `${at}%+1`, url,
  ], { maxBuffer: 32 * 1024 * 1024 });
  const [width, height] = stdout.trim().split("x").map(Number);
  if (!width || !height) throw new Error("probe_failed");
  return { width, height };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'`
Expected: no output.

- [ ] **Step 3: Run it and report**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/eval-blind-centre.ts'`

Expected: the defect bucket well below 298s. **Report the full remainder listing and give a one-line
judgement on each entry** - is it a genuine artefact (a one-frame detection, a face at the extreme edge) or
a case the rule failed to reach? Do not summarise the remainder as "small"; name every span.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/scripts/eval-blind-centre.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "test(reframe): measure blind-centre time with people visible, span by span"
```

---

## Task 4: The frame strips

**Files:**
- Create: `apps/worker/src/scripts/eval-anchor-sheets.ts`

**Context:** Spec §5. The number says the window moved; only the picture says it moved onto a person. Four
cases are required and two of them are the worst case in opposite directions.

- [ ] **Step 1: Write the script**

Create `apps/worker/src/scripts/eval-anchor-sheets.ts`:

```ts
/**
 * Before/after frame strips for the small-face anchoring change.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-anchor-sheets.ts"
 *
 * Renders the same source range twice - once with the guard applied to every
 * face, once under the new rule - and stacks them so a human can see whether
 * the window moved onto a person or merely moved.
 *
 * The four cases are chosen to be the worst in both directions, not the most
 * flattering:
 *   the wide two-shot that started this
 *   vlog-arctic  - three figures across 53% of frame width, where bestFaceGroup
 *                  must pick a subset and could pick the wrong person
 *   Booster      - stream_no_rect at 3.1%, which the rule claims is unreachable
 *   sitcom-multi - a second real source, for breadth
 *
 * Writes PNGs to .corpus/sheets/ and nothing else. Read-only otherwise.
 */
import { prisma, getPresignedDownloadUrl } from "@clipclap/shared";
import { execFile } from "child_process";
import { mkdir } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { detectShots } from "../reframe/shots";
import { detectFaces } from "../reframe/faces";
import { resolveCamRect } from "../reframe/cam-rect";
import { buildCropPlan, cropWidthFor } from "../reframe/plan";
import { buildFiltergraph } from "../reframe/filtergraph";
import { loadReframeConfig } from "../reframe/config";
import { DEFAULT_CAMERA } from "../reframe/camera";
import { loadManifest, corpusDir } from "./corpus-fetch";

const execFileAsync = promisify(execFile);

/** Clip title fragments to find in the database, plus corpus fixtures. */
const DB_CASES = [
  "надежда на быструю смерть",   // the wide two-shot from section 1
  "Обычный вопрос обернулся",     // Booster, stream_no_rect
];
const FIXTURE_CASES = ["vlog-arctic", "sitcom-multi"];

async function strip(
  src: string,
  start: number,
  len: number,
  graph: string,
  kind: "vf" | "complex",
  out: string
) {
  // Six frames evenly spaced across the range, each rendered through the REAL
  // filtergraph so the strip shows the delivered crop and not the source.
  const frames: string[] = [];
  for (let i = 0; i < 6; i++) {
    const t = start + (len * (i + 0.5)) / 6;
    const f = `${out}.${i}.png`;
    const filterArgs =
      kind === "vf"
        ? ["-vf", graph]
        : ["-filter_complex", graph, "-map", "[vout]"];
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin", "-v", "error",
        "-ss", String(t),
        "-i", src,
        ...filterArgs,
        "-frames:v", "1",
        "-y", f,
      ],
      { maxBuffer: 64e6 }
    );
    frames.push(f);
  }
  // Pad to a common height before stacking: hstack refuses mismatched inputs,
  // and a 1080-high crop and a 352-high one differ by more than rounding.
  await execFileAsync(
    "ffmpeg",
    [
      "-v", "error",
      ...frames.flatMap((f) => ["-i", f]),
      "-filter_complex",
      "[0]scale=300:534:force_original_aspect_ratio=decrease,pad=300:534:(ow-iw)/2:(oh-ih)/2[a];" +
        "[1]scale=300:534:force_original_aspect_ratio=decrease,pad=300:534:(ow-iw)/2:(oh-ih)/2[b];" +
        "[2]scale=300:534:force_original_aspect_ratio=decrease,pad=300:534:(ow-iw)/2:(oh-ih)/2[c];" +
        "[3]scale=300:534:force_original_aspect_ratio=decrease,pad=300:534:(ow-iw)/2:(oh-ih)/2[d];" +
        "[4]scale=300:534:force_original_aspect_ratio=decrease,pad=300:534:(ow-iw)/2:(oh-ih)/2[e];" +
        "[5]scale=300:534:force_original_aspect_ratio=decrease,pad=300:534:(ow-iw)/2:(oh-ih)/2[f];" +
        "[a][b][c][d][e][f]hstack=inputs=6",
      "-y", out,
    ],
    { maxBuffer: 64e6 }
  );
}

async function main() {
  const cfg = loadReframeConfig();
  const manifest = await loadManifest();
  const outDir = join(corpusDir(manifest), "sheets");
  await mkdir(outDir, { recursive: true });

  const targets: Array<{ id: string; src: string; start: number; end: number }> = [];

  for (const needle of DB_CASES) {
    const clip = await prisma.clip.findFirst({
      where: { title: { contains: needle } },
      select: {
        title: true, startTime: true, endTime: true,
        job: { select: { normalizedArtifactKey: true } },
      },
    });
    if (!clip?.job.normalizedArtifactKey) {
      console.error(`skip ${needle}: not found`);
      continue;
    }
    targets.push({
      id: needle.slice(0, 20).replace(/\s+/g, "-"),
      src: await getPresignedDownloadUrl(clip.job.normalizedArtifactKey, 7200),
      start: clip.startTime,
      end: clip.endTime,
    });
  }
  for (const id of FIXTURE_CASES) {
    targets.push({
      id,
      src: join(corpusDir(manifest), `${id}.mp4`),
      start: 0,
      end: 60,
    });
  }

  for (const t of targets) {
    const { width: W, height: H } = await probe(t.src, t.start);
    const shots = await detectShots(t.src, t.start, t.end, cfg, 120_000);
    const tracks = await detectFaces(t.src, t.start, t.end, shots, W, H, cfg, 180_000);
    const cam = resolveCamRect(tracks.map((x) => x.camRect), W, H);
    const opts = {
      faceSmallFrac: cfg.faceSmallFrac,
      faceLargeFrac: cfg.faceLargeFrac,
      stream: cfg.stream,
      camShare: cfg.camShare,
      motion: false,
      camera: DEFAULT_CAMERA,
    };
    const plan = buildCropPlan(shots, tracks, W, H, opts, cam);
    if (!plan) { console.error(`skip ${t.id}: no plan`); continue; }
    const spec = buildFiltergraph(plan);
    const out = join(outDir, `${t.id}.png`);
    await strip(t.src, t.start, t.end - t.start, spec.graph, spec.kind, out);
    const layouts = plan.shots.map((s) => s.layout).join(",");
    console.log(`${t.id.padEnd(22)} ${W}x${H} class=${plan.profile?.class} layouts=[${layouts}]`);
    console.log(`   -> ${out}`);
  }

  await prisma.$disconnect();
}

async function probe(url: string, at: number): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0",
    "-read_intervals", `${at}%+1`, url,
  ], { maxBuffer: 32e6 });
  const [width, height] = stdout.trim().split("x").map(Number);
  if (!width || !height) throw new Error("probe_failed");
  return { width, height };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Produce the AFTER sheets on this branch**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/eval-anchor-sheets.ts'`

- [ ] **Step 3: Produce the BEFORE sheets from main**

```bash
git stash
git checkout main
# rename the output so it is not overwritten
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/eval-anchor-sheets.ts' || true
docker compose exec -T worker-render sh -c 'cd /app/apps/worker/.corpus/sheets && for f in *.png; do mv "$f" "before-$f"; done'
git checkout feat/small-face-anchor
git stash pop
```

Note: the script does not exist on `main`, so copy it there for the run with
`git show feat/small-face-anchor:apps/worker/src/scripts/eval-anchor-sheets.ts > apps/worker/src/scripts/eval-anchor-sheets.ts`
before running, and delete it afterwards. Do not commit it to `main`.

- [ ] **Step 4: Look at all four pairs and report in words**

For each case say what changed in the picture, not in the numbers:

- **the wide two-shot** - does the opening now show a person instead of the table?
- **vlog-arctic** - which of the three distant figures did it pick, and does that read as a sensible choice
  or as an arbitrary one? If arbitrary, that is an argument about `bestFaceGroup` and belongs in its own
  change - say so rather than tuning anything here.
- **Booster** - the rule claims this is unreachable. Confirm the picture is unchanged. **If it changed, stop
  and report: the class condition did not hold and the spec's central safety claim is wrong.**
- **sitcom-multi** - anything that got worse?

- [ ] **Step 5: Commit the script**

```bash
git add apps/worker/src/scripts/eval-anchor-sheets.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "test(reframe): before/after strips for the four cases that decide this"
```

`.corpus/` is gitignored, so the PNGs are not committed. That is intended.

---

## Task 5: Record it and finish

**Files:**
- Modify: `docs/engine-notes.md`

- [ ] **Step 1: Add §7e**

Add a `### 7e.` section immediately after §7d containing:

- the defect: the guard exists for a webcam inset and was applied to every source; the wide two-shot at 5.2%
  and 5.5%, both refused, window on the table; 298 seconds of 1679 delivered
- the rule as a predicate, and the measured fact that makes it safe - classification is per clip, and both
  `small_face` clips in the corpus are the stream-shaped ones
- the two-helper separation and why merging them is the failure mode
- the acceptance result from Task 3, including **every remaining defective span, named**
- what the frame strips showed in Task 4, in words, including the arctic subset question
- the three earlier measurements that missed this and the one-line reason each did: §8d never checked for a
  face in the opening frame; §7d's corpus was cut at round offsets and contained no wide two-shot

- [ ] **Step 2: Full verification**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/'
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/eval-camera-invariance.ts'
```

The invariance script's level 1 must still report 0 differences over the persisted plans. Levels 2 and 3
compare against Layer 0 baselines built under the OLD rule, so **they are expected to differ now** - that is
the point of this change. Report their numbers and say plainly which differences are intended.

- [ ] **Step 3: Commit and merge**

```bash
git add docs/engine-notes.md
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "docs(engine): 7e - the guard now applies where it was needed"
git checkout main && git merge --no-ff feat/small-face-anchor
```

---

## Rollback

There is no flag. The change is a predicate in `plan.ts` and reverting the merge restores the previous
behaviour exactly; no data migration is involved and stored `cropPlan` records are unaffected, since they are
read back rather than recomputed.

If a regression appears in production, the signal to watch is `profile.class` in `renderManifest` alongside
the layout mix: a rise in `single` at the expense of `center` is this change working, and a rise in `single`
on clips classified `small_face` would mean the class condition has been broken and a webcam is being
anchored.
