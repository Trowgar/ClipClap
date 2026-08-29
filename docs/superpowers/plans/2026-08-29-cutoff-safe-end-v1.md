# Cutoff Safe-End V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an output-invariant, shadow-only audit for normal clip endings and rescue candidates, with reviewable telemetry and exact-geometry replay.

**Architecture:** `safe-end-audit.ts` owns pure speech-handoff detection, bounded records and reconciliation. A separate strict-schema LLM audit classifies normal post-extension candidates without modifying `arcFlags` or downstream arrays. Rescue observation mirrors the current rescue geometry but never changes rescue selection. All V1 controls are `off` or `shadow`; there is no enforcement path.

**Tech Stack:** TypeScript, OpenAI JSON-schema client, Vitest, Prisma read-only operator script, FFmpeg trim helper.

---

## File map

- Create: `apps/worker/src/analyze-v2/safe-end-audit.ts` - closed types, zero-tail predicate, detail capping, and reconciliation.
- Create: `apps/worker/src/analyze-v2/safe-end-audit-prompts.ts` - isolated normal-audit prompt with bounded forward context.
- Create: `apps/worker/src/analyze-v2/safe-end-audit-schema.ts` - strict response schema and parser.
- Create: `apps/worker/src/analyze-v2/safe-end-rescue-observation.ts` - pure, non-mutating observation of current rescue geometry.
- Create: `apps/worker/src/scripts/replay-geometry.ts` - operator-only no-write range replay command.
- Modify: `apps/worker/src/analyze-v2/config.ts`, `apps/worker/src/analyze-v2/index.ts`, `apps/worker/src/analyze-v2/arc-audit.ts`, `apps/worker/src/analyze-v2/rescue.ts`, `.env.example`.
- Test: `apps/worker/src/__tests__/safe-end-audit.test.ts`, `apps/worker/src/__tests__/safe-end-audit-wiring.test.ts`, `apps/worker/src/__tests__/short-source-rescue.test.ts`, `apps/worker/src/__tests__/mid-source-rescue.test.ts`, `apps/worker/src/scripts/__tests__/replay-geometry.test.ts`, `apps/worker/src/__tests__/analyze-config.test.ts`.

### Task 1: Shadow-only configuration and pure safe-end primitives

**Files:**

- Create: `apps/worker/src/analyze-v2/safe-end-audit.ts`
- Modify: `apps/worker/src/analyze-v2/config.ts`
- Modify: `apps/worker/src/__tests__/analyze-config.test.ts`
- Create: `apps/worker/src/__tests__/safe-end-audit.test.ts`

- [ ] **Step 1: Write failing config and predicate tests.**

```ts
it("defaults safe-end audit off and accepts shadow only", () => {
  expect(loadAnalyzeConfig({}).safeEndAuditMode).toBe("off");
  expect(loadAnalyzeConfig({ SAFE_END_AUDIT: "shadow" }).safeEndAuditMode).toBe("shadow");
  expect(() => loadAnalyzeConfig({ SAFE_END_AUDIT: "enforce" })).toThrow();
});

it("detects only an immediate word-bearing zero-tail handoff", () => {
  expect(zeroTailHandoff(clip(0, 10, 10), nodes([[8, 10, true], [10, 12, true]]))).toBe(true);
  expect(zeroTailHandoff(clip(0, 10, 10), nodes([[8, 10, true], [10.051, 12, true]]))).toBe(false);
  expect(zeroTailHandoff(clip(0, 10, 10), nodes([[8, 10, false], [10, 12, true]]))).toBe(false);
});
```

- [ ] **Step 2: Run tests and confirm RED.**

Run: `npx --yes --package=node@22.23.1 node node_modules/vitest/vitest.mjs run --root . apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/safe-end-audit.test.ts`

Expected: FAIL because the config field and module do not exist.

- [ ] **Step 3: Implement closed config and types.**

Add `safeEndAuditMode: "off" | "shadow"` to `AnalyzeConfig`. Parse `SAFE_END_AUDIT` strictly: missing or blank is `off`; only exact `shadow` enables it; every other nonblank value throws.

Export these types from `safe-end-audit.ts`:

```ts
export type SafeEndNormalOutcome = "safe" | "needs_afterbeat" | "hard_handoff" | "not_evaluable" | "audit_failed";
export type SafeEndReason = "post_payoff_context" | "next_question" | "topic_switch" | "unfinished_turn" | null;
export type RescueArcEvidence = "matching_standing" | "matching_clear" | "stale_or_absent";
export type RescueProposedAction = "none" | "zero_tail_handoff" | "standing_arc" | "both";
```

`zeroTailHandoff` must use only the final and following finite word-bearing sentence nodes, compare both endpoints with `Math.abs(a - b) <= 0.05`, and return false for missing, opaque, or invalid timings.

- [ ] **Step 4: Add pure record and reconciliation tests.**

Test deterministic normal severity `hard_handoff`, `needs_afterbeat`, `audit_failed`, `not_evaluable`, `safe`; rescue severity `both`, `zero_tail_handoff`, `standing_arc`, `none`; candidate-id tie breaks; 20-record cap with `truncatedCount`; selected rescue retained outside the cap. Test reconciliation returns `shipped`, `removed_before_finalizer`, `removed_by_finalizer`, and `removed_by_soft_cap` from id plus rounded geometry membership without altering a clip.

- [ ] **Step 5: Implement pure capping and reconciliation, then verify GREEN.**

Run:

```bash
npx --yes --package=node@22.23.1 node node_modules/vitest/vitest.mjs run --root . apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/safe-end-audit.test.ts
npm run typecheck -w @clipclap/worker
```

Expected: selected tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit Task 1.**

```bash
git add apps/worker/src/analyze-v2/config.ts apps/worker/src/analyze-v2/safe-end-audit.ts apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/safe-end-audit.test.ts
git commit -m "feat(worker): add safe-end shadow primitives"
```

### Task 2: Isolated normal end-completion shadow audit

**Files:**

- Create: `apps/worker/src/analyze-v2/safe-end-audit-prompts.ts`
- Create: `apps/worker/src/analyze-v2/safe-end-audit-schema.ts`
- Modify: `apps/worker/src/analyze-v2/index.ts`
- Create: `apps/worker/src/__tests__/safe-end-audit-wiring.test.ts`

- [ ] **Step 1: Write failing isolated-audit tests.**

```ts
it("keeps output byte-equivalent while safe-end shadow runs after the hook gate", async () => {
  const control = await analyze(env({ SAFE_END_AUDIT: "off" }));
  const shadow = await analyze(env({ SAFE_END_AUDIT: "shadow" }), safeEndReply("hard_handoff"));
  expect(project(shadow)).toEqual(project(control));
  expect(shadow.telemetry.safeEndAudit.normal.hard_handoff).toBe(1);
});

it("never writes safe-end results into arc flags or finalizer input", async () => {
  const result = await analyze(env({ SAFE_END_AUDIT: "shadow" }), safeEndReply("needs_afterbeat"));
  expect(result.highlights[0]).not.toHaveProperty("_safeEnd");
  expect(result.finalizerRequest).toEqual(expect.not.stringContaining("safe_end"));
});
```

- [ ] **Step 2: Run the wiring test and confirm RED.**

Run: `npx --yes --package=node@22.23.1 node node_modules/vitest/vitest.mjs run --root . apps/worker/src/__tests__/safe-end-audit-wiring.test.ts`

Expected: FAIL because no safe-end schema call or telemetry exists.

- [ ] **Step 3: Implement isolated prompt, schema, and runner.**

The JSON schema accepts rows `{ id, outcome, reason, extendToNode }`. `outcome` is the closed normal enum. `reason` is null for `safe`/`not_evaluable`/`audit_failed`; `extendToNode` is null except `needs_afterbeat`. Reject or map any malformed/unknown row to `audit_failed/malformed_response`; never persist model prose.

Build each prompt from final snapped nodes plus at most 25 seconds of following sentence context. The runner mirrors `runArcAudit` fail-open model handling but uses its own schema name and never returns `ArcFlags`.

- [ ] **Step 4: Wire only at the exact shadow seam.**

In `index.ts`, call the runner only when `cfg.safeEndAuditMode === "shadow"`, after post-boundary hook survivors are produced and before arc downrank. Pass `afterPostBoundaryHookGate`; retain that exact array for all existing downstream stages. Store results only in a local telemetry variable. Do not change selection, flags, long-clip policy, extensions, downrank, standalone filtering, finalizer, highlights, render request, or rescue.

- [ ] **Step 5: Add failure, synthetic semantic, and same-run tests.**

Use an invented de-identified prompt fixture to prove mocked `needs_afterbeat` and `hard_handoff` rows serialize as closed enums. Add refusal, malformed response, timeout, and local serialization failure tests proving unchanged projection. Add same-run projection comparison excluding generated ids, usage, and new telemetry; compare ordered start/end/title/description/lowQuality, noClipsReason, rescue and finalizer input.

- [ ] **Step 6: Verify GREEN and commit.**

```bash
npx --yes --package=node@22.23.1 node node_modules/vitest/vitest.mjs run --root . apps/worker/src/__tests__/safe-end-audit.test.ts apps/worker/src/__tests__/safe-end-audit-wiring.test.ts apps/worker/src/__tests__/arc-downrank-wiring.test.ts
npm run typecheck -w @clipclap/worker
git add apps/worker/src/analyze-v2/safe-end-audit-prompts.ts apps/worker/src/analyze-v2/safe-end-audit-schema.ts apps/worker/src/analyze-v2/index.ts apps/worker/src/__tests__/safe-end-audit-wiring.test.ts
git commit -m "feat(worker): audit normal clip endings in shadow"
```

### Task 3: Rescue observation and post-finalizer reconciliation

**Files:**

- Create: `apps/worker/src/analyze-v2/safe-end-rescue-observation.ts`
- Modify: `apps/worker/src/analyze-v2/arc-audit.ts`
- Modify: `apps/worker/src/analyze-v2/index.ts`
- Modify: `apps/worker/src/__tests__/short-source-rescue.test.ts`
- Modify: `apps/worker/src/__tests__/mid-source-rescue.test.ts`
- Modify: `apps/worker/src/__tests__/safe-end-audit-wiring.test.ts`

- [ ] **Step 1: Write failing rescue and reconciliation tests.**

```ts
it("observes every realizable rescue candidate without changing the chosen rescue", async () => {
  const result = await analyze(shortRescueEnv({ SAFE_END_AUDIT: "shadow" }));
  expect(result.highlights[0].title).toBe("existing rescue winner");
  expect(result.telemetry.safeEndAudit.rescue.records).toEqual(expect.arrayContaining([
    expect.objectContaining({ selectedState: "selected", proposedAction: "zero_tail_handoff" }),
  ]));
});

it("labels stale arc evidence instead of copying it onto a re-snapped rescue geometry", async () => {
  const result = await analyze(shortRescueEnv({ SAFE_END_AUDIT: "shadow" }));
  expect(result.telemetry.safeEndAudit.rescue.records[0].arcEvidence).toBe("stale_or_absent");
  expect(result.highlights[0]).not.toHaveProperty("_arcFlags");
});
```

- [ ] **Step 2: Run the rescue tests and confirm RED.**

Run: `npx --yes --package=node@22.23.1 node node_modules/vitest/vitest.mjs run --root . apps/worker/src/__tests__/short-source-rescue.test.ts apps/worker/src/__tests__/mid-source-rescue.test.ts apps/worker/src/__tests__/safe-end-audit-wiring.test.ts`

Expected: FAIL because no rescue observation/reconciliation exists.

- [ ] **Step 3: Implement a read-only rescue geometry observer.**

Create `observeRescueCandidates(verdicts, nodes, cfg, arcEvidence)` that repeats the current score-desc/id-asc, snap, and over-length compression rules but never regrounds copy, writes flags, or chooses output. It returns only realizable final geometry, rank, zero-tail, matching arc state, and closed proposed-action. Call it only in shadow after every existing rescue guard/exclusion has run; then call unchanged `rescueShortSource` with the unchanged pool.

Extend `runArcAudit` with private geometry evidence `{ id, finalStartNode, finalEndNode, startMs, endMs, flags }`. Match it exactly before calculating standing axes. This evidence is telemetry-only and must never alter `_arcFlags` or rescue ranking.

- [ ] **Step 4: Reconcile normal records after finalizer and soft cap.**

After `finalizeClips` and `slice(0, cfg.softCap)`, call the pure reconciler for retained normal records. Use the actual `afterStandaloneFilter`, `finalized.clips`, and `shipped` arrays to produce all four states. Add only `safeEndAudit` to ANALYZE telemetry; do not change highlight projection or render input.

- [ ] **Step 5: Verify existing rescue contracts and GREEN.**

Add cases for no rescue run, no realizable candidate, post-boundary-hook all-drop suppression, hook-id exclusion, score/id ordering, selected detail surviving cap, matching clear/standing/stale evidence, and every reconciliation state. Run:

```bash
npx --yes --package=node@22.23.1 node node_modules/vitest/vitest.mjs run --root . apps/worker/src/__tests__/short-source-rescue.test.ts apps/worker/src/__tests__/mid-source-rescue.test.ts apps/worker/src/__tests__/rescue.test.ts apps/worker/src/__tests__/safe-end-audit-wiring.test.ts
npm run typecheck -w @clipclap/worker
```

- [ ] **Step 6: Commit Task 3.**

```bash
git add apps/worker/src/analyze-v2/safe-end-rescue-observation.ts apps/worker/src/analyze-v2/arc-audit.ts apps/worker/src/analyze-v2/index.ts apps/worker/src/__tests__/short-source-rescue.test.ts apps/worker/src/__tests__/mid-source-rescue.test.ts apps/worker/src/__tests__/safe-end-audit-wiring.test.ts
git commit -m "feat(worker): observe rescue safe-end risks"
```

### Task 4: Operator exact-geometry replay

**Files:**

- Create: `apps/worker/src/scripts/replay-geometry.ts`
- Create: `apps/worker/src/scripts/__tests__/replay-geometry.test.ts`

- [ ] **Step 1: Write failing command tests.**

```ts
it("cuts the exact requested local range without durable writes", async () => {
  await runReplay(["--job-id", "j1", "--start-ms", "1234", "--end-ms", "5678", "--output", "/tmp/review.mp4"], deps);
  expect(deps.trim).toHaveBeenCalledWith(expect.any(String), 1.234, 5.678);
  expect(deps.rename).toHaveBeenCalledWith(expect.any(String), "/tmp/review.mp4");
  expect(deps.update).not.toHaveBeenCalled();
  expect(deps.queueAdd).not.toHaveBeenCalled();
});

it("rejects malformed, reversed, missing-source and out-of-duration ranges before cutting", async () => {
  await expect(runReplay(["--job-id", "j1", "--start-ms", "4", "--end-ms", "4", "--output", "/tmp/a.mp4"], deps)).rejects.toThrow();
  expect(deps.trim).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the command test and confirm RED.**

Run: `npx --yes --package=node@22.23.1 node node_modules/vitest/vitest.mjs run --root . apps/worker/src/scripts/__tests__/replay-geometry.test.ts`

Expected: FAIL because the script/module does not exist.

- [ ] **Step 3: Implement the read-only command.**

Require exactly `--job-id`, `--start-ms`, `--end-ms`, and absolute `--output`, each once; reject extra flags, unsafe integers, negative/reversed range, or an output outside `/tmp/`. Read only `normalizedArtifactKey ?? sourceArtifactKey` from Prisma. Download with the existing read-only `downloadVideo`, probe actual duration, reject an end past source duration, call `trimClipFile` for the exact seconds range, then atomically rename its temporary result to the explicit output path. Never import/call stage queue, JobStep service, `prisma.job.update`, upload, or delete object operations. Always unlink the temporary downloaded source and disconnect Prisma once; leave only the successful explicit output file for the operator to remove.

- [ ] **Step 4: Add cleanup and no-write tests, then verify GREEN.**

Test source cleanup on success and all failures, no output on failed cut, exact output retention on success, no database/queue/object-store write capability, and one disconnect in every exit. Run:

```bash
npx --yes --package=node@22.23.1 node node_modules/vitest/vitest.mjs run --root . apps/worker/src/scripts/__tests__/replay-geometry.test.ts
npm run typecheck -w @clipclap/worker
```

- [ ] **Step 5: Commit Task 4.**

```bash
git add apps/worker/src/scripts/replay-geometry.ts apps/worker/src/scripts/__tests__/replay-geometry.test.ts
git commit -m "feat(worker): add exact geometry replay"
```

### Task 5: Operator configuration, replay protection, and acceptance suite

**Files:**

- Modify: `.env.example`
- Modify: `apps/worker/src/__tests__/helpers/eval-fingerprint.ts`
- Modify: `apps/worker/src/__tests__/eval-variants.test.ts`
- Modify: `apps/worker/src/__tests__/stage-flow.test.ts`

- [ ] **Step 1: Write failing rollout tests.**

```ts
it("changes evaluation fingerprint when safe-end mode changes", () => {
  expect(fingerprint({ SAFE_END_AUDIT: "off" })).not.toEqual(fingerprint({ SAFE_END_AUDIT: "shadow" }));
});

it("persists safe-end telemetry in direct V2 and shadowV2 without changing delivery", async () => {
  await runAnalyzeStage({ jobId: "j1", userId: "u1" });
  expect(completeOutput()).toEqual(expect.objectContaining({ telemetry: expect.objectContaining({ safeEndAudit: expect.any(Object) }) }));
});
```

- [ ] **Step 2: Run rollout tests and confirm RED.**

Run: `npx --yes --package=node@22.23.1 node node_modules/vitest/vitest.mjs run --root . apps/worker/src/__tests__/eval-variants.test.ts apps/worker/src/__tests__/stage-flow.test.ts`

Expected: FAIL until mode enters fingerprint and safe-end telemetry is explicitly asserted.

- [ ] **Step 3: Document and protect the only allowed V1 mode.**

Add `.env.example` text:

```dotenv
# off | shadow. Shadow is output-invariant; no enforce mode exists in V1.
SAFE_END_AUDIT=off
```

Add `safeEndAuditMode` to eval fingerprint using a JSON-stable value. Extend stage-flow direct and legacy-shadow tests to verify telemetry persistence while legacy highlights/delivery remain unchanged.

- [ ] **Step 4: Run acceptance suite and commit.**

```bash
npx --yes --package=node@22.23.1 node node_modules/vitest/vitest.mjs run --root . apps/worker/src/__tests__/safe-end-audit.test.ts apps/worker/src/__tests__/safe-end-audit-wiring.test.ts apps/worker/src/__tests__/short-source-rescue.test.ts apps/worker/src/__tests__/mid-source-rescue.test.ts apps/worker/src/scripts/__tests__/replay-geometry.test.ts apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/eval-variants.test.ts apps/worker/src/__tests__/stage-flow.test.ts
npm run typecheck -w @clipclap/worker
npm run build -w @clipclap/worker
git add .env.example apps/worker/src/__tests__/helpers/eval-fingerprint.ts apps/worker/src/__tests__/eval-variants.test.ts apps/worker/src/__tests__/stage-flow.test.ts
git commit -m "test(worker): protect safe-end shadow rollout"
```

Expected: all focused tests, typecheck, and build exit 0.

## Plan self-review

- Spec coverage: off/shadow-only authority, normal audit isolation, deterministic rescue observation, exact geometry matching, all reconciliation states, bounded privacy-safe telemetry, replay, persistence, fingerprint, and acceptance checks map to Tasks 1-5.
- Placeholder scan: no deferred implementation marker is present.
- Type consistency: `safeEndAuditMode`, `safeEndAudit`, `zeroTailHandoff`, and the closed enums use one spelling throughout.
