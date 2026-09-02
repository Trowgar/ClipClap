# Core V4 Runtime Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unsafe score-only rescue with a bounded second quality lane that can recover only previously unjudged candidates and cannot bypass any existing quality authority.

**Architecture:** The primary analyzer records why candidates leave the pipeline and retains the deterministic tail excluded from critic selection. Only an honest `NO_VIABLE_MOMENTS` result may send up to six tail candidates through the same critic-to-finalizer lane; `off` and `shadow` preserve customer output. Jobs and feedback receive a stable V4 attribution stamp.

**Tech Stack:** TypeScript, Node 20, OpenAI structured outputs, Prisma/PostgreSQL, BullMQ, Vitest, Docker Compose.

---

### Task 1: Make critic rejection terminal and retire legacy rescue delivery

**Files:**
- Modify: `apps/worker/src/__tests__/short-source-rescue.test.ts`
- Modify: `apps/worker/src/__tests__/mid-source-rescue.test.ts`
- Modify: `apps/worker/src/__tests__/safe-end-audit-wiring.test.ts`
- Modify: `apps/worker/src/analyze-v2/index.ts`
- Delete: `apps/worker/src/analyze-v2/rescue.ts`
- Delete: `apps/worker/src/analyze-v2/safe-end-rescue-observation.ts`
- Delete: `apps/worker/src/__tests__/safe-end-rescue-observation.test.ts`

- [ ] **Step 1: Change the existing rescue tests to the approved invariant**

For both short and mid sources, retain the existing fake scanner/critic fixtures but
replace the positive rescue assertion with:

```ts
const result = await analyzeHighlightsV2(transcript(), {
  client: client(scanResponse(), rejectedCriticResponse()),
  cfg: loadAnalyzeConfig({ SHORT_SOURCE_RESCUE: "on", RESCUE_MID_SOURCE: "on" }),
  transcriptPartial: false,
  sourceDurationSec: 795,
});
expect(result.highlights).toEqual([]);
expect(result.noClipsReason).toBe("NO_VIABLE_MOMENTS");
expect(result.telemetry).not.toHaveProperty("rescue");
```

Add a mutation assertion that a `keep:false` verdict never reaches `toHighlight`.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root ../.. \
  apps/worker/src/__tests__/short-source-rescue.test.ts \
  apps/worker/src/__tests__/mid-source-rescue.test.ts
```

Expected: FAIL because current production code ships one low-quality rejected clip.

- [ ] **Step 3: Remove the runtime bypass**

Delete the final-empty block that calls `rescueShortSource`, its import, and rescue-only
telemetry. Remove the `safeEndAudit.rescue` observation branch and update its wiring
test to assert that safe-end telemetry contains only the normal lane. Do not alter the
preceding unjudged technical guard or the final honest-empty return. Remove rescue-only
code only after `rg 'rescueShortSource|RescueTelemetry|observeRescueCandidates'` shows
no runtime references.

- [ ] **Step 4: Run GREEN and commit**

```bash
npx vitest run --root ../.. \
  apps/worker/src/__tests__/short-source-rescue.test.ts \
  apps/worker/src/__tests__/mid-source-rescue.test.ts \
  apps/worker/src/__tests__/safe-end-audit-wiring.test.ts
git add apps/worker/src/analyze-v2 apps/worker/src/__tests__
git commit -m "fix(analyze): make critic rejection terminal"
```

Expected: all focused tests pass; no runtime call can ship `keep:false`.

### Task 2: Add closed V4 configuration and fingerprinting

**Files:**
- Modify: `apps/worker/src/analyze-v2/config.ts`
- Modify: `apps/worker/src/__tests__/analyze-config.test.ts`
- Modify: `apps/worker/src/__tests__/helpers/eval-fingerprint.ts`
- Modify: `apps/worker/src/__tests__/eval-fingerprint.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing config tests**

```ts
expect(loadAnalyzeConfig({}).outcomeRecoveryMode).toBe("off");
expect(loadAnalyzeConfig({ ANALYZE_OUTCOME_RECOVERY_V1: "shadow" }).outcomeRecoveryMode).toBe("shadow");
expect(loadAnalyzeConfig({ ANALYZE_OUTCOME_RECOVERY_V1: "on" }).outcomeRecoveryMode).toBe("on");
expect(loadAnalyzeConfig({ ANALYZE_OUTCOME_RECOVERY_V1: "ON" }).outcomeRecoveryMode).toBe("off");
expect(loadAnalyzeConfig({}).outcomeRecoveryMaxCandidates).toBe(6);
expect(loadAnalyzeConfig({ OUTCOME_RECOVERY_MAX_CANDIDATES: "12" }).outcomeRecoveryMaxCandidates).toBe(12);
expect(loadAnalyzeConfig({ OUTCOME_RECOVERY_MAX_CANDIDATES: "13" }).outcomeRecoveryMaxCandidates).toBe(6);
```

Add fingerprint tests proving that mode, cap, and code-owned version mismatch the
recording rather than silently replaying it.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root ../.. \
  apps/worker/src/__tests__/analyze-config.test.ts \
  apps/worker/src/__tests__/eval-fingerprint.test.ts
```

Expected: type/test failures for missing V4 fields.

- [ ] **Step 3: Implement the closed configuration**

Add to `config.ts`:

```ts
export type OutcomeRecoveryMode = "off" | "shadow" | "on";
export const OUTCOME_RECOVERY_VERSION = "core-v4-recovery-v1" as const;

const outcomeRecoveryMode: OutcomeRecoveryMode =
  env.ANALYZE_OUTCOME_RECOVERY_V1 === "shadow" ||
  env.ANALYZE_OUTCOME_RECOVERY_V1 === "on"
    ? env.ANALYZE_OUTCOME_RECOVERY_V1
    : "off";
```

Use `positiveIntBounded(..., 6, 12)` for the cap. Add all three values to
`EngineFingerprint`; add `ANALYZE_OUTCOME_RECOVERY_V1=off` and
`OUTCOME_RECOVERY_MAX_CANDIDATES=6` to `.env.example`.

- [ ] **Step 4: Run GREEN and commit**

```bash
npx vitest run --root ../.. \
  apps/worker/src/__tests__/analyze-config.test.ts \
  apps/worker/src/__tests__/eval-fingerprint.test.ts
git add .env.example apps/worker/src/analyze-v2/config.ts \
  apps/worker/src/__tests__/analyze-config.test.ts \
  apps/worker/src/__tests__/helpers/eval-fingerprint.ts \
  apps/worker/src/__tests__/eval-fingerprint.test.ts
git commit -m "feat(analyze): configure versioned outcome recovery"
```

### Task 3: Partition critic selection without changing selected output

**Files:**
- Modify: `apps/worker/src/analyze-v2/candidates.ts`
- Create: `apps/worker/src/__tests__/critic-candidate-partition.test.ts`
- Modify: `apps/worker/src/analyze-v2/index.ts`

- [ ] **Step 1: Write failing partition tests**

```ts
const partition = partitionCriticCandidates(merged, nodes, cfg, "standard");
expect(partition.selected).toEqual(selectCriticCandidates(merged, nodes, cfg, "standard"));
expect([...partition.selected, ...partition.unselected].map(c => c.id).sort())
  .toEqual(merged.map(c => c.id).sort());
expect(new Set([...partition.selected, ...partition.unselected].map(c => c.id)).size)
  .toBe(merged.length);
```

Include ties, per-window quota, regional caps, and stream mode. Assert exact selected
ordering against current fixtures.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/critic-candidate-partition.test.ts
```

Expected: FAIL because `partitionCriticCandidates` does not exist.

- [ ] **Step 3: Implement one selection authority**

Refactor the existing function without changing its algorithm:

```ts
export interface CriticCandidatePartition {
  selected: MergedCandidate[];
  unselected: MergedCandidate[];
}

export function partitionCriticCandidates(
  merged: MergedCandidate[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  mode: AnalysisMode = "standard",
): CriticCandidatePartition {
  // Keep the current byWindow/picked/result/take/quota/global-extra loops unchanged.
  const selected = result;
  const ids = new Set(selected.map(candidate => candidate.id));
  return { selected, unselected: merged.filter(candidate => !ids.has(candidate.id)) };
}

export function selectCriticCandidates(
  merged: MergedCandidate[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  mode: AnalysisMode = "standard",
): MergedCandidate[] {
  return partitionCriticCandidates(merged, nodes, cfg, mode).selected;
}
```

Wire `index.ts` to retain the unselected tail in memory while keeping the selected
array and telemetry unchanged.

- [ ] **Step 4: Run GREEN, replay invariance, and commit**

```bash
npx vitest run --root ../.. \
  apps/worker/src/__tests__/critic-candidate-partition.test.ts \
  apps/worker/src/__tests__/analyze-v2.test.ts \
  apps/worker/src/__tests__/eval-snapshot.test.ts
git add apps/worker/src/analyze-v2/candidates.ts apps/worker/src/analyze-v2/index.ts \
  apps/worker/src/__tests__/critic-candidate-partition.test.ts
git commit -m "refactor(analyze): retain the unjudged critic tail"
```

### Task 4: Add immutable candidate accounting and a deterministic recovery pool

**Files:**
- Create: `apps/worker/src/analyze-v2/candidate-trace.ts`
- Create: `apps/worker/src/analyze-v2/outcome-recovery.ts`
- Modify: `apps/worker/src/analyze-v2/types.ts`
- Create: `apps/worker/src/__tests__/candidate-trace.test.ts`
- Create: `apps/worker/src/__tests__/outcome-recovery.test.ts`

- [ ] **Step 1: Write failing trace tests**

Define the closed union from the design and assert lane accounting:

```ts
const trace = createCandidateTrace(["c0", "c1"]);
trace.terminatePrimary("c0", "critic_rejected");
trace.terminatePrimary("c1", "not_selected_for_critic");
expect(trace.summaryPrimary()).toEqual({ critic_rejected: 1, not_selected_for_critic: 1 });
expect(() => trace.terminatePrimary("c0", "shipped")).toThrow("duplicate_disposition");
expect(() => trace.terminatePrimary("foreign", "shipped")).toThrow("unknown_candidate");
```

Assert that recovery adds a separate disposition and never rewrites primary history.

- [ ] **Step 2: Write failing pool tests**

```ts
const result = buildOutcomeRecoveryPool({
  candidates: tail,
  nodes,
  missingRanges: [],
  maxCandidates: 6,
});
expect(result.candidates).toHaveLength(6);
expect(result.candidates.map(c => c.id)).toEqual(["r0", "r3", "r6", "r1", "r4", "r7"]);
```

Cover region diversity, interest/id tie-break, missing-range exclusion, maximum 12,
empty tail, and no mutation of inputs.

- [ ] **Step 3: Implement pure modules**

`candidate-trace.ts` owns closed validation and count-only serialization.
`outcome-recovery.ts` exports:

```ts
export interface RecoveryPoolResult {
  candidates: MergedCandidate[];
  excludedMissingRange: number;
}

export function buildOutcomeRecoveryPool(input: {
  candidates: readonly MergedCandidate[];
  nodes: readonly SentenceNode[];
  missingRanges: readonly { start: number; end: number }[];
  maxCandidates: number;
}): RecoveryPoolResult;

export type RecoveryEligibility =
  | { eligible: true; reason: "unjudged_tail" }
  | { eligible: false; reason: "mode_off" | "non_empty" | "wrong_content_reason" |
      "partial_transcript" | "missing_range" | "degenerate" | "song_gate" |
      "no_unjudged_tail" };

export function isOutcomeRecoveryEligible(input: {
  mode: OutcomeRecoveryMode;
  primaryHighlights: readonly V2Highlight[];
  noClipsReason: NoClipsReasonValue | undefined;
  transcriptPartial: boolean;
  missingRangeDrops: number;
  path: string;
  unselectedCount: number;
}): RecoveryEligibility;
```

Round-robin by ten-minute payoff region, then order within a region by descending
interest and stable id. Serialize only ids/types/ranges/counts, never transcript text.

- [ ] **Step 4: Run GREEN and commit**

```bash
npx vitest run --root ../.. \
  apps/worker/src/__tests__/candidate-trace.test.ts \
  apps/worker/src/__tests__/outcome-recovery.test.ts
git add apps/worker/src/analyze-v2/candidate-trace.ts \
  apps/worker/src/analyze-v2/outcome-recovery.ts \
  apps/worker/src/analyze-v2/types.ts \
  apps/worker/src/__tests__/candidate-trace.test.ts \
  apps/worker/src/__tests__/outcome-recovery.test.ts
git commit -m "feat(analyze): build an auditable recovery candidate pool"
```

### Task 5: Extract one shared critic-to-finalizer quality lane

**Files:**
- Create: `apps/worker/src/analyze-v2/quality-lane.ts`
- Create: `apps/worker/src/__tests__/quality-lane.test.ts`
- Modify: `apps/worker/src/analyze-v2/index.ts`

- [ ] **Step 1: Add characterization tests before extraction**

Freeze, for representative keep/reject/snap/arc/finalizer fixtures, the complete
`highlights`, `noClipsReason`, usage, and existing telemetry. Add explicit spies proving
the current path invokes critic, evidence, snap, standalone filter, and finalizer.

- [ ] **Step 2: Run characterization GREEN**

```bash
npx vitest run --root ../.. \
  apps/worker/src/__tests__/analyze-v2.test.ts \
  apps/worker/src/__tests__/quality-lane.test.ts \
  apps/worker/src/__tests__/finalize.test.ts
```

Expected: characterization tests pass before the refactor.

- [ ] **Step 3: Extract without policy changes**

Move the existing block from `runCritic` through `finalizeClips` behind one internal API:

```ts
export interface QualityLaneInput {
  lane: "primary" | "recovery";
  candidates: MergedCandidate[];
  nodes: SentenceNode[];
  languageIso: string;
  cfg: AnalyzeConfig;
  usage: LlmUsage;
  client: OpenAI;
  retryDelayMs: number | undefined;
  analysisMode: AnalysisMode;
  missingRanges: Array<{ start: number; end: number }>;
  transcription: TranscriptionResult;
  sourceDurationSec: number | undefined;
  safeEndAuditTelemetryTestHook: ((telemetry: unknown) => unknown) | undefined;
}

export interface QualityLaneResult {
  highlights: V2Highlight[];
  telemetry: Record<string, unknown>;
  counters: {
    judged: number;
    selectedForFinalizer: number;
    finalizerSurvivors: number;
  };
  terminal: ReadonlyMap<string, CandidateDisposition>;
}
```

Pass existing helpers and dependencies explicitly. Do not recreate abbreviated recovery
logic. `index.ts` calls the shared lane once for primary candidates. Preserve every
existing ordering and telemetry field.

- [ ] **Step 4: Prove extraction invariance and mutation resistance**

```bash
npx vitest run --root ../.. \
  apps/worker/src/__tests__/quality-lane.test.ts \
  apps/worker/src/__tests__/analyze-v2.test.ts \
  apps/worker/src/__tests__/arc-downrank-wiring.test.ts \
  apps/worker/src/__tests__/safe-end-audit-wiring.test.ts \
  apps/worker/src/__tests__/eval-snapshot.test.ts
```

Temporarily bypass each authority in turn and verify a focused test fails; restore each
mutation before continuing.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/analyze-v2/index.ts apps/worker/src/analyze-v2/quality-lane.ts \
  apps/worker/src/__tests__/quality-lane.test.ts
git commit -m "refactor(analyze): share the complete quality lane"
```

### Task 6: Wire bounded `off`, `shadow`, and `on` recovery

**Files:**
- Modify: `apps/worker/src/analyze-v2/index.ts`
- Modify: `apps/worker/src/analyze-v2/llm.ts`
- Create: `apps/worker/src/__tests__/outcome-recovery-wiring.test.ts`

- [ ] **Step 1: Write failing mode and safety tests**

Use a fixture whose primary selected candidate is rejected and whose unselected tail
contains one critic-approved complete moment. Assert:

```ts
expect(off.highlights).toEqual([]);
expect(off.telemetry).not.toHaveProperty("outcomeRecovery");
expect(shadow.highlights).toEqual(off.highlights);
expect(shadow.telemetry.outcomeRecovery).toMatchObject({ mode: "shadow", outcome: "shadow_hit" });
expect(on.highlights).toHaveLength(1);
expect(on.telemetry.outcomeRecovery).toMatchObject({ mode: "on", outcome: "shipped" });
```

Add cases for partial transcript, song/degenerate path, missing ranges, empty tail,
`keep:false`, evidence/snap/arc/post-boundary/standalone/finalizer drops, and recovery
model failure. Assert at most one additional critic batch and no recursive attempt.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/outcome-recovery-wiring.test.ts
```

- [ ] **Step 3: Implement the orchestrator**

At the final honest-empty point, call `isOutcomeRecoveryEligible`. In `shadow`/`on`,
build the pool and invoke the shared quality lane exactly once. Merge usage with a new
tested helper:

```ts
export function mergeUsage(target: LlmUsage, added: LlmUsage): void {
  target.inputTokens += added.inputTokens;
  target.outputTokens += added.outputTokens;
  target.requests += added.requests;
  for (const [model, bucket] of Object.entries(added.byModel)) {
    const current = target.byModel[model] ??= { inputTokens: 0, outputTokens: 0, requests: 0 };
    current.inputTokens += bucket.inputTokens;
    current.outputTokens += bucket.outputTokens;
    current.requests += bucket.requests;
  }
}
```

Recovery failure is fail-open to the already complete primary empty result. `shadow`
never substitutes highlights. `on` ships only shared-lane survivors and keeps the
normal output cap.

When mode is not `off`, emit only the approved count/range telemetry:

```ts
outcomeRecovery: {
  version: OUTCOME_RECOVERY_VERSION,
  mode: cfg.outcomeRecoveryMode,
  eligible: true,
  reason: "unjudged_tail",
  primaryDispositions: trace.summaryPrimary(),
  poolSize: pool.candidates.length,
  judged: recovery.counters.judged,
  rejectionCounts: recoveryTrace.summaryRecovery(),
  finalizerInput: recovery.counters.selectedForFinalizer,
  finalizerSurvivors: recovery.counters.finalizerSurvivors,
  addedUsage: recoveryUsage,
  elapsedMs,
  outcome: cfg.outcomeRecoveryMode === "shadow" ? "shadow_hit" : "shipped",
}
```

Use closed reason/outcome unions for every ineligible, empty-pool, rejected, failed,
shadow-hit, and shipped branch.

- [ ] **Step 4: Run GREEN and commit**

```bash
npx vitest run --root ../.. \
  apps/worker/src/__tests__/outcome-recovery-wiring.test.ts \
  apps/worker/src/__tests__/stage-flow.test.ts \
  apps/worker/src/__tests__/eval-snapshot.test.ts
git add apps/worker/src/analyze-v2/index.ts apps/worker/src/analyze-v2/llm.ts \
  apps/worker/src/__tests__/outcome-recovery-wiring.test.ts
git commit -m "feat(analyze): recover unjudged candidates through full quality"
```

### Task 7: Stamp jobs and immutable feedback with V4 attribution

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260902203000_job_analysis_version/migration.sql`
- Modify: `apps/worker/src/stages/analyze.ts`
- Modify: `apps/worker/src/__tests__/stage-flow.test.ts`
- Modify: `packages/shared/src/services/clip-feedback.service.ts`
- Modify: `packages/shared/src/services/__tests__/clip-feedback.service.test.ts`
- Modify: `apps/worker/src/scripts/feedback-digest.ts`

- [ ] **Step 1: Write failing persistence/snapshot tests**

```ts
expect(jobUpdate).toHaveBeenCalledWith(expect.objectContaining({
  data: expect.objectContaining({ analysisVersion: "core-v4-recovery-v1" }),
}));
expect(snapshot).toMatchObject({
  analysisVersion: "core-v4-recovery-v1",
  outcomeRecovery: { mode: "on", outcome: "shipped" },
});
```

Also test historical nulls and redaction: the snapshot must not contain candidate ids,
transcript outside the existing slice, source keys, URLs, or user ids.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root ../.. \
  apps/worker/src/__tests__/stage-flow.test.ts \
  packages/shared/src/services/__tests__/clip-feedback.service.test.ts
```

- [ ] **Step 3: Add the nullable migration and wiring**

Migration:

```sql
ALTER TABLE "jobs" ADD COLUMN "analysisVersion" TEXT;
```

Stamp `OUTCOME_RECOVERY_VERSION` in the same Job update that stores highlights. Extend
the feedback Job select with `analysisVersion` and:

```ts
steps: {
  where: { step: "ANALYZE" },
  take: 1,
  select: { outputJson: true },
}
```

Extract the ANALYZE step's count-only `outcomeRecovery` result; freeze only
`{ mode, outcome, version }` into the snapshot.
Update the digest to render these nullable fields.

- [ ] **Step 4: Generate, test, and commit**

```bash
npx prisma generate
npx vitest run --root ../.. \
  apps/worker/src/__tests__/stage-flow.test.ts \
  packages/shared/src/services/__tests__/clip-feedback.service.test.ts
git add prisma apps/worker/src/stages/analyze.ts apps/worker/src/__tests__/stage-flow.test.ts \
  packages/shared/src/services/clip-feedback.service.ts \
  packages/shared/src/services/__tests__/clip-feedback.service.test.ts \
  apps/worker/src/scripts/feedback-digest.ts
git commit -m "feat(analytics): attribute V4 jobs and feedback"
```

### Task 8: Verify runtime V4 and deploy dark

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-core-v4-first-result-recovery-design.md` only with measured aggregate results
- Modify: `docs/known-issues.md` if the unsafe rescue issue is currently listed

- [ ] **Step 1: Build fresh Node 20 test and runtime images**

```bash
set -eu
CORE_V4_COMMIT=$(git rev-parse HEAD)
printf '%s\n' "$CORE_V4_COMMIT" | grep -Eq '^[0-9a-f]{40}$'
docker build --build-arg VCS_REF="$CORE_V4_COMMIT" -f apps/worker/Dockerfile -t clipclap-worker-core-v4:verify .
docker build --target build -f apps/worker/Dockerfile -t clipclap-worker-core-v4:test .
```

- [ ] **Step 2: Run the complete suite and build**

```bash
docker run --rm --entrypoint sh -w /app \
  -v /var/run/docker.sock:/var/run/docker.sock -v /tmp:/tmp \
  clipclap-worker-core-v4:test \
  -lc 'set -eu; apk add --no-cache docker-cli >/dev/null; npx vitest run --root /app apps/worker/src packages/shared/src'
docker run --rm --entrypoint sh -w /app clipclap-worker-core-v4:test \
  -lc 'npm run build --workspace @clipclap/worker && npm run typecheck --workspace @clipclap/worker'
```

Expected: zero failed tests, build/typecheck exit 0.

- [ ] **Step 3: Rehearse the migration and real-data replay**

Clone the production schema into the isolated rehearsal database, run
`npx prisma migrate deploy`, verify old rows read with `analysisVersion=null`, then run
the retained V3 positives and V4 zero-result cases. Do not log identifiers or media
paths. Expected: all V3 windows retained, valid empty controls remain empty, and no
critic/gate rejection ships.

- [ ] **Step 4: Obtain two-stage review**

Run a spec-compliance review, fix and re-review; then a code-quality/security review,
fix and re-review. Finally compare the whole branch with `main`.

- [ ] **Step 5: Deploy `off` only**

Merge only after the separate outcome-quality plan passes. Run the migration, build the
immutable production image, set `ANALYZE_OUTCOME_RECOVERY_V1=off`, drain the analyze
queue, recreate only `worker-analyze`, verify effective env/image revision/startup and
queue connectivity. Rollback is the same flag set to `off`; the nullable column remains.
