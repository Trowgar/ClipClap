# Reframe Active Safe-Fit Slice 1B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace only face-unsafe plan shots with a deterministic full-frame `safe-fit` composition while preserving safe and faceless shots exactly.

**Architecture:** Extend the versioned plan with one fallback layout, derive per-shot verdicts from the existing renderer-aligned coverage evaluator, and apply a pure post-plan safety transformation only when both active flags are exactly `on`. Render `safe-fit` as a contained foreground over a blurred full-frame background; music jobs remain excluded until safety evaluation receives their effective letterbox geometry.

**Tech Stack:** TypeScript, Vitest, ffmpeg filtergraphs, Docker Compose.

---

## Scope and locked decisions

- Work on `feature/reframe-safety-planner`; do not create a worktree (owner decision).
- Slice 1B works at whole-shot granularity. It never splits on individual detector samples, avoiding layout flicker and graph growth.
- A shot with no surviving face is unchanged (`no_mandatory_regions`). A shot with a surviving face but no valid in-shot path is `invalid_evidence` and becomes `safe-fit`.
- Invalid original `shotIndex` alignment makes every planned shot `safe-fit`; recovered/renumbered tracks cannot repair untrusted evidence.
- Active behavior requires `REFRAME_SAFETY_PLANNER=on` **and** `REFRAME_SAFE_FIT=on`. Missing, `true`, `1`, or any other value is off.
- `musicMode === true` disables both active and shadow safety because music letterbox remapping changes effective render geometry.
- Blur geometry is fixed in code; there is no tuning flag.
- Persist only aggregate counts and a non-sensitive per-safe-fit reason. Never persist boxes, paths, frames, IDs, or media paths.
- Post-render artifact validation and retry are Slice 1C. Existing single encode-failure fallback remains unchanged.
- Private case-04 has no retained source and blocks production rollout, but not flag-off branch development.

## File map

- Modify `apps/worker/src/reframe/types.ts`: plan v4 and `safe-fit` layout contract.
- Modify `apps/worker/src/reframe/config.ts`: exact active flags.
- Modify `apps/worker/src/reframe/safety.ts`: renderer-aligned per-shot verdict API.
- Modify `apps/worker/src/reframe/regions.ts`: explicit valid/invalid mandatory evidence per shot.
- Create `apps/worker/src/reframe/safety-planner.ts`: pure shot replacement policy.
- Modify `apps/worker/src/reframe/plan.ts`: v4 trimming/validation compatibility.
- Modify `apps/worker/src/reframe/filtergraph.ts`: mixed-layout safe-fit composition.
- Modify `apps/worker/src/reframe/index.ts`: active integration after the stream gate.
- Modify `apps/worker/src/reframe/telemetry.ts` and `apps/worker/src/stages/render.ts`: aggregate active telemetry.
- Create/extend the matching `apps/worker/src/__tests__/reframe-*.test.ts` suites.
- Create `apps/worker/src/scripts/eval-reframe-safety-planner.ts`: immutable private replay.

### Task 1: Versioned layout and exact flags

**Files:**
- Modify: `apps/worker/src/reframe/types.ts`
- Modify: `apps/worker/src/reframe/config.ts`
- Modify: `apps/worker/src/reframe/plan.ts`
- Test: `apps/worker/src/__tests__/reframe-config.test.ts`
- Test: `apps/worker/src/__tests__/reframe-plan.test.ts`

- [ ] **Step 1: Write failing config and v4 compatibility tests**

Add table cases proving only literal `on` enables each flag, plus a v4 slice case:

```ts
it.each([undefined, "", "true", "1", "ON", "off"])(
  "keeps active safety off for %j",
  (value) => {
    const cfg = loadReframeConfig({
      REFRAME_SAFETY_PLANNER: value,
      REFRAME_SAFE_FIT: value,
    });
    expect(cfg.safetyPlanner).toBe(false);
    expect(cfg.safeFit).toBe(false);
  }
);

it("accepts and trims a v4 safe-fit plan", () => {
  const plan: CropPlan = {
    version: 4,
    engine: "faces",
    source: { width: 1920, height: 1080 },
    shots: [{ start: 0, end: 10, layout: "safe-fit", reason: "coverage" }],
  };
  expect(sliceCropPlan(plan, 2, 8)?.shots).toEqual([
    { start: 0, end: 6, layout: "safe-fit", reason: "coverage" },
  ]);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
docker compose exec -T worker-render /app/node_modules/.bin/vitest run --root /app \
  apps/worker/src/__tests__/reframe-config.test.ts \
  apps/worker/src/__tests__/reframe-plan.test.ts
```

Expected: compile/test failure because v4, `safe-fit`, `safetyPlanner`, and `safeFit` do not exist.

- [ ] **Step 3: Add the exact contracts**

Add these members without changing existing variants:

```ts
export type SafeFitReason = "coverage" | "invalid_evidence";

// In ShotLayout:
| {
    start: number;
    end: number;
    layout: "safe-fit";
    reason: SafeFitReason;
  };

export interface CropPlan {
  version: 1 | 2 | 3 | 4;
  // existing fields unchanged
}

export interface ReframeConfig {
  // existing fields unchanged
  safetyPlanner: boolean;
  safeFit: boolean;
}
```

Load both flags with exact comparisons:

```ts
safetyPlanner: env.REFRAME_SAFETY_PLANNER === "on",
safeFit: env.REFRAME_SAFE_FIT === "on",
```

Allow version 4 in `sliceCropPlan`; preserve `layout` and `reason` through the existing start/end rebasing. Unknown versions still return `null`.

Extend `planLayoutCounts` at the same time so the new exhaustive union is valid:

```ts
export type PlanLayoutCounts =
  Record<"single" | "split" | "center" | "stream", number> &
  { "safe-fit"?: number };

export function planLayoutCounts(
  plan: CropPlan
): PlanLayoutCounts {
  const counts: PlanLayoutCounts = { single: 0, split: 0, center: 0, stream: 0 };
  for (const shot of plan.shots) {
    if (shot.layout === "safe-fit") {
      counts["safe-fit"] = (counts["safe-fit"] ?? 0) + 1;
    } else {
      counts[shot.layout] += 1;
    }
  }
  return counts;
}
```

The optional key is required for rollback compatibility: a legacy plan must not gain `"safe-fit": 0` in persisted telemetry.

- [ ] **Step 4: Run GREEN and compatibility suites**

Run the Step 2 command. Expected: all tests pass and existing v1/v2/v3 fixtures remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/reframe/types.ts apps/worker/src/reframe/config.ts \
  apps/worker/src/reframe/plan.ts \
  apps/worker/src/__tests__/reframe-config.test.ts \
  apps/worker/src/__tests__/reframe-plan.test.ts
git commit -m "feat(reframe): define versioned safe-fit layout"
```

### Task 2: Renderer-aligned per-shot verdicts

**Files:**
- Modify: `apps/worker/src/reframe/regions.ts`
- Modify: `apps/worker/src/reframe/safety.ts`
- Test: `apps/worker/src/__tests__/reframe-safety.test.ts`

- [ ] **Step 1: Write failing verdict tests**

Pin threshold, unmapped evidence, and safe-fit full-frame behavior:

```ts
expect(evaluatePlanCoverageDetailed(plan, regions, 0.9).shots).toEqual([
  {
    shotIndex: 0,
    status: "fail",
    minimumCoverage: 0.899,
    evaluatedSamples: 1,
    rejectedSamples: 1,
    unmappedSamples: 0,
  },
]);

expect(evaluatePlanCoverageDetailed(safeFitPlan, regions, 0.9).shots[0])
  .toMatchObject({ status: "pass", minimumCoverage: 1 });
```

Also assert: `0.90` passes; a sample at a rounded shot boundary maps with the same half-open rule as the renderer; invalid layout geometry is `not_evaluable`; `split`/`stream` use maximum single-window coverage, never union.

Add region-evidence tests proving that every surviving face is mandatory: no surviving faces is valid empty evidence, while any surviving track with an absent, unsorted, non-finite, non-positive, out-of-shot, or empty path makes that shot invalid.

- [ ] **Step 2: Run the safety suite and verify RED**

```bash
docker compose exec -T worker-render /app/node_modules/.bin/vitest run --root /app \
  apps/worker/src/__tests__/reframe-safety.test.ts
```

Expected: failure because `evaluatePlanCoverageDetailed` is not exported and safe-fit is not handled.

- [ ] **Step 3: Implement one detailed source of truth**

Add:

```ts
export interface ShotSafetyVerdict {
  shotIndex: number;
  status: "not_evaluable" | "pass" | "fail";
  minimumCoverage: number | null;
  evaluatedSamples: number;
  rejectedSamples: number;
  unmappedSamples: number;
}

export interface DetailedSafetyEvaluation {
  aggregate: SafetyShadowTelemetry;
  shots: ShotSafetyVerdict[];
}

export function evaluatePlanCoverageDetailed(
  plan: CropPlan,
  regions: FocalRegionTrack[],
  threshold = DEFAULT_THRESHOLD
): DetailedSafetyEvaluation;
```

Add the evidence adapter beside the existing compatibility wrapper:

```ts
export interface ShotRegionEvidence {
  regions: FocalRegionTrack[];
  hasMandatoryRegions: boolean;
  invalid: boolean;
}

export function faceTracksToRegionEvidence(
  surviving: FaceTrack[],
  span: Shot,
  idPrefix: string
): ShotRegionEvidence;
```

`faceTracksToRegions(...)` must remain available and return the valid adapter's `regions`. A path is valid only when it is a non-empty, time-sorted array and every sample has finite `t/x/y/w/h`, positive `w/h`, and `t` inside the owning shot. Empty surviving input returns `{ regions: [], hasMandatoryRegions: false, invalid: false }`; one invalid surviving track makes `invalid: true` even if another track is valid.

Move the existing evaluation loop into this function. Assign each mandatory sample to its rendered shot index, accumulate the same coverage into per-shot counters, and reduce those counters into the existing aggregate. Make `evaluatePlanCoverage(...)` return `evaluatePlanCoverageDetailed(...).aggregate`, so geometry and timing cannot drift. Update every exhaustive helper (`finiteShot`, base-x/keyframe selection, and layout windows) for `safe-fit`: it contributes the centered hidden-base x to renderer trajectories and one visible source window `{ x: 0, y: 0, w: source.width, h: source.height }` to coverage.

- [ ] **Step 4: Run GREEN and existing filtergraph timing controls**

```bash
docker compose exec -T worker-render /app/node_modules/.bin/vitest run --root /app \
  apps/worker/src/__tests__/reframe-safety.test.ts \
  apps/worker/src/__tests__/reframe-filtergraph.test.ts
```

Expected: all tests pass; aggregate fixtures remain byte-for-byte equal.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/reframe/regions.ts apps/worker/src/reframe/safety.ts \
  apps/worker/src/__tests__/reframe-safety.test.ts
git commit -m "feat(reframe): expose per-shot safety verdicts"
```

### Task 3: Pure active safety transformation

**Files:**
- Create: `apps/worker/src/reframe/safety-planner.ts`
- Test: `apps/worker/src/__tests__/reframe-safety-planner.test.ts`

- [ ] **Step 1: Write failing policy tests**

Use explicit verdict/evidence fixtures to assert:

```ts
expect(applySafetyPlanner(plan, {
  verdicts: [
    { shotIndex: 0, status: "pass", minimumCoverage: 1, evaluatedSamples: 1, rejectedSamples: 0, unmappedSamples: 0 },
    { shotIndex: 1, status: "fail", minimumCoverage: 0.5, evaluatedSamples: 1, rejectedSamples: 1, unmappedSamples: 0 },
  ],
  mandatoryEvidenceShots: new Set<number>([0, 1]),
  invalidEvidenceShots: new Set<number>(),
  invalidAlignment: false,
}).plan).toEqual({
  ...plan,
  version: 4,
  shots: [
    plan.shots[0],
    { start: plan.shots[1].start, end: plan.shots[1].end, layout: "safe-fit", reason: "coverage" },
  ],
});
```

Add cases for: no mandatory regions unchanged; invalid-path shot becomes `invalid_evidence`; invalid alignment converts all shots; adjacent replacements merge only when their `reason` matches; input and nested objects are not mutated; no replacement preserves the original object and version.

- [ ] **Step 2: Run the new suite and verify RED**

```bash
docker compose exec -T worker-render /app/node_modules/.bin/vitest run --root /app \
  apps/worker/src/__tests__/reframe-safety-planner.test.ts
```

Expected: missing-module failure.

- [ ] **Step 3: Implement the pure policy**

Create these exact public types:

```ts
export interface SafetyPlannerInput {
  verdicts: ShotSafetyVerdict[];
  mandatoryEvidenceShots: ReadonlySet<number>;
  invalidEvidenceShots: ReadonlySet<number>;
  invalidAlignment: boolean;
}

export interface SafetyPlannerTelemetry {
  mode: "active";
  evaluatedShots: number;
  safeFitShots: number;
  coverageFallbacks: number;
  invalidEvidenceFallbacks: number;
  minimumCoverage: number | null;
}

export function applySafetyPlanner(
  plan: CropPlan,
  input: SafetyPlannerInput
): { plan: CropPlan; telemetry: SafetyPlannerTelemetry };
```

Choose `invalid_evidence` before `coverage`. Replace a shot only when alignment is invalid, its index is in `invalidEvidenceShots`, or its index is in `mandatoryEvidenceShots` and its verdict is `fail`/`not_evaluable`. A faceless shot is absent from both evidence sets and remains unchanged even though a full-plan evaluator would otherwise call its empty result `not_evaluable`. Merge adjacent safe-fit shots only when `end === start` and `reason` matches. Return the original plan reference when no shot changed; otherwise return a new v4 plan and cloned shots array.

- [ ] **Step 4: Run GREEN**

Run the Step 2 command. Expected: all policy and no-mutation tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/reframe/safety-planner.ts \
  apps/worker/src/__tests__/reframe-safety-planner.test.ts
git commit -m "feat(reframe): apply fail-closed safe-fit policy"
```

### Task 4: Mixed safe-fit filtergraph

**Files:**
- Modify: `apps/worker/src/reframe/filtergraph.ts`
- Test: `apps/worker/src/__tests__/reframe-filtergraph.test.ts`

- [ ] **Step 1: Write failing exact graph tests**

Add fixtures for all-safe-fit and mixed `single + safe-fit`, then structural assertions for mixed split/stream:

```ts
const spec = buildFiltergraph({
  version: 4,
  engine: "faces",
  source: { width: 1920, height: 1080 },
  shots: [
    { start: 0, end: 5, layout: "single", x: 400 },
    { start: 5, end: 10, layout: "safe-fit", reason: "coverage" },
  ],
});
expect(spec.kind).toBe("complex");
expect(spec.graph).toContain("force_original_aspect_ratio=increase");
expect(spec.graph).toContain("force_original_aspect_ratio=decrease");
expect(spec.graph).toContain("boxblur=");
expect(spec.graph).toContain("enable='gte(t,5.00)*lt(t,10.00)'");
expect(spec.graph).toContain("setsar=1");
```

Assert subtitles occur exactly once and after the final safe-fit overlay, output is labelled `[vout]`, and a v1-v3 plan without safe-fit produces the exact legacy graph string.

- [ ] **Step 2: Run the filtergraph suite and verify RED**

```bash
docker compose exec -T worker-render /app/node_modules/.bin/vitest run --root /app \
  apps/worker/src/__tests__/reframe-filtergraph.test.ts
```

Expected: safe-fit plans fail or compile without the required composition.

- [ ] **Step 3: Implement the fixed composition**

Treat safe-fit like split/stream when selecting the hidden base crop x. For every safe-fit interval build one shared contained composition from the source:

```text
[sf0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,
     boxblur=luma_radius=20:luma_power=2,setsar=1[sfbg]
[sf1]scale=1080:1920:force_original_aspect_ratio=decrease,setsar=1[sffg]
[sfbg][sffg]overlay=(W-w)/2:(H-h)/2[safe]
```

Split the input enough times for the existing base/tile branches plus `[sf0]` and `[sf1]`. Overlay `[safe]` over the completed legacy layout with the union of half-open enables, using `formatLayoutTime`. Apply `assSnippet` once after this overlay. If no safe-fit shot exists, take the untouched legacy code path and return its exact previous string.

- [ ] **Step 4: Run GREEN and ffmpeg smoke test**

Run the Step 2 command, then compile one private 1-second source with the produced graph inside `worker-render`. Expected: exit 0, 1080x1920, square pixels. Do not commit the output media.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/reframe/filtergraph.ts \
  apps/worker/src/__tests__/reframe-filtergraph.test.ts
git commit -m "feat(reframe): render mixed safe-fit shots"
```

### Task 5: Active integration and aggregate telemetry

**Files:**
- Modify: `apps/worker/src/reframe/index.ts`
- Modify: `apps/worker/src/reframe/telemetry.ts`
- Modify: `apps/worker/src/stages/render.ts`
- Test: `apps/worker/src/__tests__/reframe-compute.test.ts`
- Test: `apps/worker/src/__tests__/reframe-telemetry.test.ts`
- Test: `apps/worker/src/__tests__/render-reframe.test.ts`

- [ ] **Step 1: Write failing integration tests**

Assert this matrix:

```ts
it.each([
  { planner: false, safeFit: false, changes: false },
  { planner: true,  safeFit: false, changes: false },
  { planner: false, safeFit: true,  changes: false },
  { planner: true,  safeFit: true,  changes: true  },
])("gates active safety with both flags: %o", ({ planner, safeFit, changes }) => {
  const result = planDetected(unsafeDetection, {
    ...cfg,
    safetyPlanner: planner,
    safeFit,
    safetyShadow: false,
  });
  expect(result.plan?.shots.some((shot) => shot.layout === "safe-fit")).toBe(changes);
});
```

Add: music mode never changes plan and emits neither active nor shadow telemetry; faceless shot stays center; surviving face without valid path becomes safe-fit; malformed original alignment converts all shots; stream gate runs before active safety; telemetry contains counts/reasons only; encode failure still attempts exactly one legacy fallback.

- [ ] **Step 2: Run integration suites and verify RED**

```bash
docker compose exec -T worker-render /app/node_modules/.bin/vitest run --root /app \
  apps/worker/src/__tests__/reframe-compute.test.ts \
  apps/worker/src/__tests__/reframe-telemetry.test.ts \
  apps/worker/src/__tests__/render-reframe.test.ts
```

Expected: active fields/policy are not integrated.

- [ ] **Step 3: Integrate in the fixed order**

In `planDetected`, preserve this order:

```text
buildCropPlan -> stream coverage gate -> region/evidence build
-> one detailed evaluation of the original final candidate plan
-> active safety (both flags && !musicMode), consuming that evaluation
-> expose original-candidate shadow aggregate (shadow flag && !musicMode)
```

Define `activeRequested = cfg.safetyPlanner && cfg.safeFit && !cfg.musicMode` and `safetyRequested = (cfg.safetyShadow && !cfg.musicMode) || activeRequested`; compute original alignment under `safetyRequested`, not under the old `cfg.safetyShadow`-only guard. Build evidence from `faceTracksToRegionEvidence(survivingTracks(trackSet.tracks), ...)` on the recovered detector-shot spans. Plan shots may be merged and their array indexes do **not** equal detector `shotIndex`: derive `mandatoryEvidenceShots` from detailed verdicts with `evaluatedSamples > 0`, and map every invalid detector span to every plan shot whose `[start,end)` interval overlaps it to form `invalidEvidenceShots`. Never pass detector indexes directly to `applySafetyPlanner`. Pass both plan-index sets and the pre-recovery `invalidOriginalAlignment` into the active policy. Return optional `safetyPlanner` telemetry beside `plan`; extend `ReframeCheck` only with aggregate mode/count/reason fields, and persist it through the existing render telemetry path. `safetyShadow`, when requested alongside active mode, describes the original candidate plan rather than the safe-fit result; active telemetry separately describes replacements. Never add coordinates or track IDs.

- [ ] **Step 4: Run GREEN and flag-off invariance**

Run the Step 2 command plus `reframe-plan`, `reframe-config`, `reframe-safety`, and `reframe-filtergraph`. Expected: all tests pass; a fixture with both active flags off serializes to the exact pre-Task-5 plan and filtergraph.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/reframe/index.ts apps/worker/src/reframe/telemetry.ts \
  apps/worker/src/stages/render.ts \
  apps/worker/src/__tests__/reframe-compute.test.ts \
  apps/worker/src/__tests__/reframe-telemetry.test.ts \
  apps/worker/src/__tests__/render-reframe.test.ts
git commit -m "feat(reframe): gate unsafe shots behind active safe-fit"
```

### Task 6: Immutable active replay and acceptance evidence

**Files:**
- Create: `apps/worker/src/scripts/eval-reframe-safety-planner.ts`
- Modify: `apps/worker/src/__tests__/reframe-safety-replay.test.ts`

- [ ] **Step 1: Write failing replay tests**

Use the existing bounded capture reader. The capture has an immutable already-built `plan`, detector shots, and tracks, but intentionally has neither cut `candidates` nor the effective runtime config; therefore active replay must transform the captured plan and must not call `planDetected`. Assert the active evaluator emits only:

```ts
{
  before: SafetyShadowTelemetry,
  after: SafetyShadowTelemetry,
  active: SafetyPlannerTelemetry,
  unchangedSafeShots: number,
}
```

Pin: unsafe synthetic shots become safe-fit and `after.status === "pass"`; safe controls remain structurally equal; malformed/unreadable captures use the existing fixed error strings and exit 1; measured `fail` remains a valid exit 0.

- [ ] **Step 2: Run replay tests and verify RED**

```bash
docker compose exec -T worker-render /app/node_modules/.bin/vitest run --root /app \
  apps/worker/src/__tests__/reframe-safety-replay.test.ts
```

Expected: missing active replay module.

- [ ] **Step 3: Implement the bounded active CLI**

Refactor/export the hardened capture validator as `parseSafetyCapture(value: unknown): SafetyCapture | null` rather than duplicating file limits. Export/reuse the existing alignment predicate and set `invalidAlignment = !alignedTracks(capture)`; duplicate, missing, or out-of-range `shotIndex` must therefore send every captured plan shot to `safe-fit`, exactly like production. From validly indexed captured tracks, build region/evidence sets aligned to the captured plan; compute the before verdict on `capture.plan`, apply active safe-fit directly to that plan with the explicit `invalidAlignment`, compute the after verdict, and write one JSON line containing only the schema above. Do not invoke detectors or `planDetected`, and do not write captures, DB rows, storage objects, frames, or identifiers.

- [ ] **Step 4: Run full verification and private replay**

```bash
docker compose exec -T worker-render /app/node_modules/.bin/vitest run --root /app \
  apps/worker/src/__tests__/reframe-plan.test.ts \
  apps/worker/src/__tests__/reframe-safety.test.ts \
  apps/worker/src/__tests__/reframe-safety-planner.test.ts \
  apps/worker/src/__tests__/reframe-safety-replay.test.ts \
  apps/worker/src/__tests__/reframe-filtergraph.test.ts \
  apps/worker/src/__tests__/reframe-config.test.ts \
  apps/worker/src/__tests__/reframe-compute.test.ts \
  apps/worker/src/__tests__/reframe-telemetry.test.ts \
  apps/worker/src/__tests__/render-reframe.test.ts \
  apps/worker/src/__tests__/reframe-faces-detect.test.ts \
  apps/worker/src/__tests__/reframe-shots-detect.test.ts

docker compose exec -T worker-render npm run typecheck -w @clipclap/worker
git diff --check
```

Expected: all reframe/render tests pass. If typecheck still reports only the pre-existing `feedback-learning/lock.ts` `fs-ext` errors, record them as baseline rather than modifying unrelated code.

Replay private case-03/05/11 captures. Expected: `before.status === "fail"`, `after.status === "pass"`, safe neighboring shots unchanged. Generate ignored `source | current | new` contact sheets at identical timestamps and manually inspect composition/stability. Case-04 remains unavailable and therefore keeps rollout blocked.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/scripts/eval-reframe-safety-planner.ts \
  apps/worker/src/__tests__/reframe-safety-replay.test.ts
git commit -m "test(reframe): replay active safe-fit decisions"
```

## Release gate

Do not enable production flags from this plan. Slice 1B is eligible for a separate rollout decision only after all available private contact sheets pass manual review, controls show no plan/filtergraph drift, and replacement rates are acceptable. Missing case-04 evidence remains an explicit rollout exception requiring owner approval or a replacement fixture.
