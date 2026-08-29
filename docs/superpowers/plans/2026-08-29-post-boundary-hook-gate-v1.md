# Post-Boundary Hook Gate V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject selected clips whose post-extension opening delays the hook or contains a long pre-hook transcript gap, with dark rollout modes and privacy-safe telemetry.

**Architecture:** A new pure policy module evaluates `SnappedClip` boundaries and `SentenceNode` timing without I/O. The pipeline invokes it after both extension stages and the long-clip sweep, then sends survivors to existing downranking and finalization. Strict configuration provides `off`, `observe`, `shadow`, and `enforce`; only enforce changes output.

**Tech Stack:** TypeScript, Vitest, existing analyze-v2 pipeline and JobStep telemetry.

---

## File map

- Create: `apps/worker/src/analyze-v2/post-boundary-hook-gate.ts` - pure coverage, decision, diagnostics, and telemetry policy.
- Create: `apps/worker/src/__tests__/post-boundary-hook-gate.test.ts` - direct metric and mode tests.
- Modify: `apps/worker/src/analyze-v2/config.ts` - strict mode and limit parsing.
- Modify: `apps/worker/src/__tests__/analyze-config.test.ts` - config contract tests.
- Modify: `apps/worker/src/analyze-v2/index.ts` - post-extension integration, provenance, telemetry, and terminal rescue protection.
- Modify: `apps/worker/src/__tests__/arc-downrank-wiring.test.ts` - integration, ordering, output, and rescue tests.
- Modify: `apps/worker/src/__tests__/helpers/eval-fingerprint.ts` - fingerprint values that can alter output without altering an LLM request.
- Modify: `apps/worker/src/__tests__/eval-variants.test.ts` - protected variant/fingerprint tests.
- Modify: `.env.example` - documented operator variables and valid combinations.

### Task 1: Strict configuration and pure hook-gate policy

**Files:**

- Create: `apps/worker/src/analyze-v2/post-boundary-hook-gate.ts`
- Create: `apps/worker/src/__tests__/post-boundary-hook-gate.test.ts`
- Modify: `apps/worker/src/analyze-v2/config.ts`
- Modify: `apps/worker/src/__tests__/analyze-config.test.ts`

- [ ] **Step 1: Add failing configuration tests.**

```ts
it("defaults the post-boundary hook gate to off", () => {
  const cfg = loadAnalyzeConfig({});
  expect(cfg.postBoundaryHookGateMode).toBe("off");
  expect(cfg.postBoundaryHookMaxDelaySec).toBeUndefined();
  expect(cfg.postBoundaryHookMaxPreHookGapSec).toBeUndefined();
});

it("requires finite non-negative limits only in shadow and enforce", () => {
  expect(() => loadAnalyzeConfig({ POST_BOUNDARY_HOOK_GATE: "shadow" })).toThrow();
  expect(() => loadAnalyzeConfig({ POST_BOUNDARY_HOOK_GATE: "enforce", POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "NaN", POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "1" })).toThrow();
  expect(() => loadAnalyzeConfig({ POST_BOUNDARY_HOOK_GATE: "observe", POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "1" })).toThrow();
  expect(loadAnalyzeConfig({ POST_BOUNDARY_HOOK_GATE: "shadow", POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "1", POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "0" }).postBoundaryHookGateMode).toBe("shadow");
});
```

- [ ] **Step 2: Run the config test and confirm the new assertions fail because fields/parser are absent.**

Run: `npx vitest run --root . apps/worker/src/__tests__/analyze-config.test.ts`

Expected: FAIL at the new hook-gate assertions, not a Vitest startup error. If local Node cannot load Vite, use the repository's supported Node runtime and record that runtime.

- [ ] **Step 3: Add failing pure-policy tests.**

```ts
it("drops in enforce when hook delay exceeds the strict limit", () => {
  const result = applyPostBoundaryHookGate([clip({ startSec: 10, hookStartSec: 12.01 })], nodes([[10, 12.01]]), enforce(2, 9));
  expect(result.clips).toEqual([]);
  expect(result.drops[0].reasons).toEqual(["hook_delay"]);
});

it("merges adjacent sentence coverage and measures the largest half-open gap", () => {
  expect(largestPreHookGap(nodes([[0, 1], [1, 2], [4, 5]]), 0, 6)).toBe(1);
});

it("observes raw metrics without pass or drop decisions", () => {
  const result = applyPostBoundaryHookGate([clip()], nodes([[0, 1]]), observe());
  expect(result.clips).toHaveLength(1);
  expect(result.telemetry).not.toHaveProperty("passed");
  expect(result.telemetry).not.toHaveProperty("dropped");
});
```

- [ ] **Step 4: Run the pure-policy test and confirm it fails because the module does not exist.**

Run: `npx vitest run --root . apps/worker/src/__tests__/post-boundary-hook-gate.test.ts`

Expected: FAIL with module-not-found or missing exports.

- [ ] **Step 5: Implement the minimal config contract.**

Add `PostBoundaryHookGateMode = "off" | "observe" | "shadow" | "enforce"` and these `AnalyzeConfig` fields:

```ts
postBoundaryHookGateMode: PostBoundaryHookGateMode;
postBoundaryHookMaxDelaySec?: number;
postBoundaryHookMaxPreHookGapSec?: number;
```

Parse `POST_BOUNDARY_HOOK_GATE`, `POST_BOUNDARY_HOOK_MAX_DELAY_SEC`, and `POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC` with a dedicated strict parser, not `num()`. Missing mode means `off`; unknown mode, non-finite/negative values, missing limits in `shadow`/`enforce`, and any limit supplied in `off`/`observe` throw a configuration error.

- [ ] **Step 6: Implement the pure policy.**

Export one function with this boundary:

```ts
export function applyPostBoundaryHookGate(
  clips: SnappedClip[],
  nodes: SentenceNode[] | undefined,
  options: PostBoundaryHookGateOptions,
): PostBoundaryHookGateResult;
```

For every clip in `observe`, `shadow`, or `enforce`, calculate `hookDelaySec = hookStartSec - startSec` and merge finite sentence ranges intersecting `[startSec, hookStartSec)`. Count leading, interior, and trailing gaps; adjacent ranges have no gap. Invalid clip timing or unavailable node arrays are `notEvaluable`; invalid individual node ranges are ignored. In `shadow`, retain all clips and record `wouldDrop`; in `enforce`, stable-filter failures and retain each dropped id with a possibly dual `reasons` array. Use strict `>` comparisons. `off` returns the original array with no telemetry object.

- [ ] **Step 7: Complete edge-case tests and make Task 1 green.**

Add assertions for equality limits, no coverage, empty interval, leading/trailing/interior gaps, invalid nodes, dual reasons, stable survivor order, and per-mode telemetry schema. Pin report bands to `scoreThreshold` and `targetMinSec`/`maxSec` as specified. Run:

```bash
npx vitest run --root . apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/post-boundary-hook-gate.test.ts
npm run typecheck -w @clipclap/worker
```

Expected: all selected tests pass and TypeScript has no error.

- [ ] **Step 8: Commit Task 1.**

```bash
git add apps/worker/src/analyze-v2/config.ts apps/worker/src/analyze-v2/post-boundary-hook-gate.ts apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/post-boundary-hook-gate.test.ts
git commit -m "feat(worker): add post-boundary hook gate policy"
```

### Task 2: Wire pipeline, telemetry, and terminal no-rescue behavior

**Files:**

- Modify: `apps/worker/src/analyze-v2/index.ts`
- Modify: `apps/worker/src/__tests__/arc-downrank-wiring.test.ts`

- [ ] **Step 1: Add failing pipeline tests.**

```ts
it("drops an enforce failure after extensions and before finalizer input", async () => {
  const result = await analyzeV2({ env: enforceEnv(), endExtensionResult: delayedHookClip });
  expect(result.telemetry.postBoundaryHookGate.dropped).toBe(1);
  expect(result.telemetry.selectedForFinalizer).toBe(0);
  expect(result.finalizerRequest).not.toContain(delayedHookClip.verdict.id);
});

it("does not let short or mid rescue restore an enforce-dropped verdict", async () => {
  const result = await analyzeV2({ env: enforceEnv({ SHORT_SOURCE_RESCUE: "on" }), sourceDurationSec: 120 });
  expect(result.highlights).toEqual([]);
  expect(result.telemetry.rescue).toBeUndefined();
});
```

Add parallel coverage for `shadow` retaining the exact selection, `off` omitting `postBoundaryHookGate`, dual-reason diagnostics, and explicit `startRepairApplied` / before-after end-extension provenance.

- [ ] **Step 2: Run the wiring test and confirm the new assertions fail.**

Run: `npx vitest run --root . apps/worker/src/__tests__/arc-downrank-wiring.test.ts`

Expected: FAIL because no gate telemetry/filtering is wired.

- [ ] **Step 3: Wire the gate at the exact pipeline seam.**

After `extendClipEnds` and after the long-clip sweep builds `beforeFinalize`, call the pure policy with `nodes`, config mode/limits, `arcFlags.get(id)?.entry.repaired === true`, and an end-node snapshot captured immediately before `extendClipEnds`. Use its survivors as the input to arc downrank, standalone filter, and finalizer. For every enforce drop, append a `droppedVerdicts` row with `stage: "post_boundary_hook_gate"` and a deterministic joined reason.

- [ ] **Step 4: Persist telemetry and guarantee no replacement.**

Include `postBoundaryHookGate` in the returned telemetry only outside `off`. Persist aggregate counters, per-job maxima/distributions/bands, and bounded privacy-safe diagnostics. Do not add transcript text, source URL, user id, or video key. Preserve the existing `stages/analyze.ts` nesting so direct V2 writes `telemetry.postBoundaryHookGate` and legacy shadow writes `shadowV2.telemetry.postBoundaryHookGate`.

Pass `critic.verdicts` excluding every enforce-dropped id to `rescueShortSource`; if the gate removed every candidate, bypass short and mid rescue entirely. This prevents a later zero-result rescue from re-snapping and restoring a rejected clip.

- [ ] **Step 5: Make pipeline tests green.**

Run:

```bash
npx vitest run --root . apps/worker/src/__tests__/arc-downrank-wiring.test.ts apps/worker/src/__tests__/short-source-rescue.test.ts apps/worker/src/__tests__/mid-source-rescue.test.ts apps/worker/src/__tests__/end-extension-wiring.test.ts
npm run typecheck -w @clipclap/worker
```

Expected: selected tests pass, short/mid rescue still passes for ordinary critic rejection, and no gate-dropped verdict can reappear.

- [ ] **Step 6: Commit Task 2.**

```bash
git add apps/worker/src/analyze-v2/index.ts apps/worker/src/__tests__/arc-downrank-wiring.test.ts
git commit -m "feat(worker): enforce post-boundary hook gate"
```

### Task 3: Replay safety, environment documentation, and regression suite

**Files:**

- Modify: `apps/worker/src/__tests__/helpers/eval-fingerprint.ts`
- Modify: `apps/worker/src/__tests__/eval-variants.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add failing replay-fingerprint tests.**

```ts
it("changes the evaluation fingerprint when hook-gate mode or limits change", () => {
  expect(fingerprint({ POST_BOUNDARY_HOOK_GATE: "shadow", POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "2", POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "1" }))
    .not.toEqual(fingerprint({ POST_BOUNDARY_HOOK_GATE: "enforce", POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "2", POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "1" }));
});
```

- [ ] **Step 2: Run the fingerprint test and confirm it fails because gate settings are omitted.**

Run: `npx vitest run --root . apps/worker/src/__tests__/eval-variants.test.ts`

Expected: FAIL at the new fingerprint assertion.

- [ ] **Step 3: Implement replay protection and operator documentation.**

Include the gate mode and both limits in the eval fingerprint with existing non-LLM output-affecting settings. Document only valid `.env.example` combinations:

```dotenv
# off | observe | shadow | enforce. Limits are required only for shadow/enforce.
POST_BOUNDARY_HOOK_GATE=off
# POST_BOUNDARY_HOOK_MAX_DELAY_SEC=3
# POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC=1.5
```

Do not publish a production numeric recommendation: limits await observe and shadow reports.

- [ ] **Step 4: Run the focused regression suite and full worker checks.**

Run:

```bash
npx vitest run --root . apps/worker/src/__tests__/post-boundary-hook-gate.test.ts apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/arc-downrank-wiring.test.ts apps/worker/src/__tests__/short-source-rescue.test.ts apps/worker/src/__tests__/mid-source-rescue.test.ts apps/worker/src/__tests__/eval-variants.test.ts
npm run typecheck -w @clipclap/worker
npm run build -w @clipclap/worker
```

Expected: all commands exit 0. If the host Node version cannot start Vitest, rerun in the project-supported Node version and report the exact compatibility blocker separately.

- [ ] **Step 5: Commit Task 3.**

```bash
git add apps/worker/src/__tests__/helpers/eval-fingerprint.ts apps/worker/src/__tests__/eval-variants.test.ts .env.example
git commit -m "test(worker): fingerprint post-boundary hook gate"
```

## Plan self-review

- Spec coverage: all four modes, strict limits, exact half-open gap semantics, dual reasons, provenance, diagnostics/privacy, downstream ordering, terminal rescue behavior, persistence, bands, and rollout documentation map to Tasks 1-3.
- No placeholder scan: no `TODO`, `TBD`, or deferred implementation markers are present.
- Type consistency: `PostBoundaryHookGateMode`, `applyPostBoundaryHookGate`, `postBoundaryHookGate`, and the three environment keys use one spelling across tasks.
