# Core V4 Outcome Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private, immutable evaluation lane for zero-output jobs and prevent V4 from reaching production unless it recovers reviewed moments without manufacturing clips for valid-empty sources.

**Architecture:** A separate append-only outcome ledger represents jobs that have no ClipFeedback row. Materialized private cases bind transcript/source/recordings to hashes, observation runners compare baseline and candidate, and a composite release gate requires both the existing clip-feedback decision and a passing outcome decision.

**Tech Stack:** TypeScript, Node 20, Prisma read-only access, private filesystem corpus, R2 GET, Vitest, existing feedback-quality hashing/locking/release infrastructure.

---

### Task 1: Define a closed zero-outcome case and label contract

**Files:**
- Create: `apps/worker/src/feedback-quality/outcome-types.ts`
- Create: `apps/worker/src/__tests__/outcome-types.test.ts`

- [ ] **Step 1: Write failing schema tests**

```ts
expect(parseOutcomeLabel({
  schemaVersion: 1,
  action: "label",
  eventId: "event-1",
  occurredAt: "2026-09-02T20:00:00.000Z",
  caseVersion: SHA,
  set: "eval",
  disposition: "recoverable_false_negative",
  confidence: "high",
  expected: { approvedWindows: [{ start: 120, end: 160 }], forbiddenWindows: [] },
})).toMatchObject({ disposition: "recoverable_false_negative" });
```

Reject unknown keys, invalid UTC, invalid hashes, overlapping/negative windows, empty
approved windows for recoverable cases, approved windows on `valid_empty`, mutable ids,
and `exclude` cases assigned to eval/holdout.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/outcome-types.test.ts
```

- [ ] **Step 3: Implement exact schemas**

Export closed types and parsers:

```ts
export type OutcomeDisposition =
  | "recoverable_false_negative"
  | "valid_empty"
  | "exclude";
export type OutcomeSet = "eval" | "holdout";

export interface OutcomeExpected {
  approvedWindows: Array<{ start: number; end: number }>;
  forbiddenWindows: Array<{ start: number; end: number }>;
}
```

Use own-property validation, bounded arrays, finite seconds, canonical UTC, and the
existing SHA-256 branded type. No free-form note enters the case or report schema.

- [ ] **Step 4: Run GREEN and commit**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/outcome-types.test.ts
git add apps/worker/src/feedback-quality/outcome-types.ts \
  apps/worker/src/__tests__/outcome-types.test.ts
git commit -m "feat(eval): define immutable zero-outcome labels"
```

### Task 2: Build a private append-only outcome store

**Files:**
- Create: `apps/worker/src/feedback-quality/outcome-store.ts`
- Create: `apps/worker/src/__tests__/outcome-store.test.ts`
- Reuse: `apps/worker/src/feedback-learning/persistence.ts`
- Reuse: `apps/worker/src/feedback-quality/repository.ts`

- [ ] **Step 1: Write failing security/durability tests**

Test `0700` directories, `0600` files, symlink/special-file refusal, `flock`, canonical
JSONL, duplicate event rejection, correction-by-retirement, fsync/rename/fsync, crash
before rename, stale temp cleanup, and concurrent writers.

```ts
await appendOutcomeEvent(root, label, deps);
expect((await stat(root)).mode & 0o777).toBe(0o700);
expect((await stat(join(root, "ledger", "outcomes.jsonl"))).mode & 0o777).toBe(0o600);
await expect(appendOutcomeEvent(root, label, deps)).rejects.toThrow("duplicate_event");
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/outcome-store.test.ts
```

- [ ] **Step 3: Implement by composing existing primitives**

Own only:

```text
.corpus/feedback-quality-gate/outcomes/
  ledger/outcomes.jsonl
  ledger/outcomes.lock
  cases/<case-version>/case.json
  cases/<case-version>/transcript.json
  cases/<case-version>/source.mp4
  cases/<case-version>/recorded-responses.jsonl
  observations/<observation-id>/results.jsonl
  decisions/<decision-id>/{decision.json,report.md}
```

Reuse validated open/no-follow, atomic publication, hashing, and locking helpers. Never
duplicate weaker filesystem code. Expose active-label reads and append operations; no
update/delete API.

- [ ] **Step 4: Run GREEN and commit**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/outcome-store.test.ts
git add apps/worker/src/feedback-quality/outcome-store.ts \
  apps/worker/src/__tests__/outcome-store.test.ts
git commit -m "feat(eval): persist private zero-outcome cases"
```

### Task 3: Materialize a reviewed job before retention removes its source

**Files:**
- Create: `apps/worker/src/feedback-quality/outcome-promote.ts`
- Create: `apps/worker/src/scripts/outcome-promote.ts`
- Create: `apps/worker/src/scripts/outcome-validate.ts`
- Create: `apps/worker/src/__tests__/outcome-promote.test.ts`
- Modify: `apps/worker/package.json`

- [ ] **Step 1: Write failing dependency and freshness tests**

Mock Prisma and R2. Require a `DONE` zero-clip job, exact ANALYZE-step digest,
`analysisVersion`, transcript, duration, source artifact, recorded responses, reviewer
disposition, expected windows, and destination. Reject non-zero clips, technical failure,
partial transcript, `NO_USABLE_SPEECH`, missing/stale inputs, source-limited cases,
cross-user duplication limits, and any attempted DB/R2 write.

```ts
expect(deps.prisma.job.update).toBeUndefined();
expect(deps.r2.put).toBeUndefined();
expect(result).toMatchObject({ status: "promoted", set: "eval" });
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/outcome-promote.test.ts
```

- [ ] **Step 3: Implement read-only promotion**

Use a repeatable-read Prisma transaction for metadata and read-only R2 GET for source.
Hash every input before publication. The case body contains pseudonymous content hashes,
duration, engine/config fingerprint, recorded responses, and expected windows; it never
contains user id, email, Telegram id, URL, object key, transcript text in logs, or source
path in reports.

CLI shape:

```bash
npm run outcome-promote -w @clipclap/worker -- \
  --decision-file /private/review.json \
  --root /private/feedback-quality-gate
```

The decision file is `0600`; arguments never carry private ids or notes.
`outcome-validate.ts` opens the same store read-only, verifies ledger/case hashes,
freshness, modes, symlinks, eval/holdout counts, and prints aggregate reason codes only.

- [ ] **Step 4: Run GREEN and commit**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/outcome-promote.test.ts
git add apps/worker/src/feedback-quality/outcome-promote.ts \
  apps/worker/src/scripts/outcome-promote.ts apps/worker/src/scripts/outcome-validate.ts \
  apps/worker/src/__tests__/outcome-promote.test.ts apps/worker/package.json
git commit -m "feat(eval): promote reviewed empty outcomes"
```

### Task 4: Run immutable baseline/candidate outcome observations

**Files:**
- Create: `apps/worker/src/feedback-quality/outcome-observe.ts`
- Create: `apps/worker/src/scripts/outcome-observe.ts`
- Create: `apps/worker/src/__tests__/outcome-observe.test.ts`
- Modify: `apps/worker/package.json`

- [ ] **Step 1: Write failing observation tests**

Assert binding to commit SHA, engine fingerprint, corpus digest, runner version, mode,
and recorded response digest. Missing requests, request-fingerprint drift, unknown
telemetry, output outside source duration, or private data in report must fail closed.

```ts
expect(observation).toMatchObject({
  schemaVersion: 1,
  mode: "candidate",
  commitSha: SHA,
  corpusDigest: SHA,
  results: [expect.objectContaining({ caseVersion: SHA, keepFalseShipped: 0 })],
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/outcome-observe.test.ts
```

- [ ] **Step 3: Implement the deterministic runner**

Replay the full analyzer with exact recorded responses. Per case record only:

```ts
{
  caseVersion,
  disposition,
  shippedWindows,
  approvedHits,
  forbiddenHits,
  keepFalseShipped,
  explicitGateResurrections,
  candidateCap,
  criticBatches,
  noClipsReason,
}
```

The baseline uses recovery `off`; candidate uses the supplied V4 mode/config. Prompt,
model, or request-shape changes require a separately named three-attempt live lane and
cannot reuse deterministic recordings silently.

- [ ] **Step 4: Run GREEN and commit**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/outcome-observe.test.ts
git add apps/worker/src/feedback-quality/outcome-observe.ts \
  apps/worker/src/scripts/outcome-observe.ts \
  apps/worker/src/__tests__/outcome-observe.test.ts apps/worker/package.json
git commit -m "feat(eval): observe V4 zero-outcome recovery"
```

### Task 5: Enforce the outcome policy and compose it with the clip gate

**Files:**
- Create: `apps/worker/src/feedback-quality/outcome-policy.ts`
- Create: `apps/worker/src/feedback-quality/outcome-gate.ts`
- Create: `apps/worker/src/scripts/outcome-recovery-gate.ts`
- Create: `apps/worker/src/__tests__/outcome-policy.test.ts`
- Create: `apps/worker/src/__tests__/outcome-gate.test.ts`
- Modify: `apps/worker/src/feedback-quality/release.ts`
- Modify: `apps/worker/package.json`

- [ ] **Step 1: Write failing policy tests**

Create one test per reason code. The pass fixture must satisfy:

```ts
expect(decideOutcomeGate(input)).toMatchObject({
  verdict: "pass",
  metrics: {
    recoverableCases: 4,
    validEmptyCases: 4,
    recoveredCases: 2,
    keepFalseShipped: 0,
    explicitGateResurrections: 0,
    validEmptyFalsePositives: 0,
  },
});
```

Fail on fewer than 4+4 cases, missing one-per-class holdout, fewer than two real
recoveries or below 30%, any valid-empty output, any positive loss, confirmed-negative
worsening, keep-false/gate resurrection, more than six candidates, more than one critic
batch, off/shadow mismatch, stale/missing input, or fingerprint mismatch.

The composite decision also requires the existing clip gate's minimum five positives
and eight confirmed negatives, with at least three confirmed negatives labelled for
selection/rescue policy. A render-only negative population cannot authorize V4.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root ../.. \
  apps/worker/src/__tests__/outcome-policy.test.ts \
  apps/worker/src/__tests__/outcome-gate.test.ts
```

- [ ] **Step 3: Implement content-addressed decisions**

`decision.json` hashes commit, config, corpus, runner, policy, baseline/candidate
observations, counts, metrics, verdict, reasons, creation, and 24-hour expiry. Reports
contain aggregate counts only. Modify release verification to require both a fresh
existing clip-feedback pass and a fresh outcome pass for the same commit/config before
`ANALYZE_OUTCOME_RECOVERY_V1=on`; `off`/`shadow` deployments do not claim quality pass.

- [ ] **Step 4: Run GREEN and commit**

```bash
npx vitest run --root ../.. \
  apps/worker/src/__tests__/outcome-policy.test.ts \
  apps/worker/src/__tests__/outcome-gate.test.ts \
  apps/worker/src/__tests__/feedback-quality-deploy.test.ts
git add apps/worker/src/feedback-quality/outcome-policy.ts \
  apps/worker/src/feedback-quality/outcome-gate.ts \
  apps/worker/src/feedback-quality/release.ts \
  apps/worker/src/scripts/outcome-recovery-gate.ts \
  apps/worker/src/__tests__/outcome-policy.test.ts \
  apps/worker/src/__tests__/outcome-gate.test.ts apps/worker/package.json
git commit -m "feat(eval): gate V4 on safe real recovery"
```

### Task 6: Build the real corpus and verify holdout discipline

**Files:**
- Private only: `.corpus/feedback-quality-gate/outcomes/**`
- Modify: `docs/runbooks/feedback-learning.md`

- [ ] **Step 1: Materialize eligible cases immediately**

Review available `NO_VIABLE_MOMENTS` jobs with retained sources plus owned/licensed
controls. Build at least four `recoverable_false_negative` and four `valid_empty` jobs.
Lock at least one of each in holdout before tuning. Exclude partial, technical,
degenerate, song-gate, source-limited, and subjective cases.

Independently use the existing `feedback-quality-promote` workflow to bring the clip
gate to at least five positives and eight confirmed negatives. At least three confirmed
negatives must be selection/rescue cases; render-only negatives do not satisfy that
subsystem requirement. Current labels must be counted before promotion and the final
aggregate counts recorded without case ids.

- [ ] **Step 2: Validate privacy and corpus counts**

```bash
npm run outcome-validate -w @clipclap/worker -- --root /private/feedback-quality-gate
```

Expected: modes `0700/0600`, no symlinks/special files, all hashes/freshness valid,
minimum eval/holdout counts met, no private identifiers in reports.

- [ ] **Step 3: Run baseline and candidate observations**

```bash
npm run outcome-observe -w @clipclap/worker -- --mode baseline --root /private/feedback-quality-gate
npm run outcome-observe -w @clipclap/worker -- --mode candidate --root /private/feedback-quality-gate
npm run outcome-recovery-gate -w @clipclap/worker -- --root /private/feedback-quality-gate
```

Expected: valid-empty precision 100%, zero resurrection, at least two approved-window
recoveries and at least 30% recoverable recall. Holdout details remain undisclosed.

- [ ] **Step 4: Update the runbook and commit only public instructions**

```bash
git add docs/runbooks/feedback-learning.md
git commit -m "docs: add V4 outcome gate operations"
```

Never add `.corpus`, ids, transcript, media, paths, or case-level reports.

### Task 7: Full verification and guarded production rollout

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-core-v4-first-result-recovery-design.md` with aggregate evidence only

- [ ] **Step 1: Run full fresh verification in Node 20**

```bash
set -eu
CORE_V4_COMMIT=$(git rev-parse HEAD)
printf '%s\n' "$CORE_V4_COMMIT" | grep -Eq '^[0-9a-f]{40}$'
docker build --build-arg VCS_REF="$CORE_V4_COMMIT" -f apps/worker/Dockerfile -t clipclap-worker-core-v4:verify .
docker build --target build -f apps/worker/Dockerfile -t clipclap-worker-core-v4:test .
docker run --rm --entrypoint sh -w /app \
  -v /var/run/docker.sock:/var/run/docker.sock -v /tmp:/tmp \
  clipclap-worker-core-v4:test \
  -lc 'set -eu; apk add --no-cache docker-cli >/dev/null; npx vitest run --root /app apps/worker/src packages/shared/src; npm run build --workspace @clipclap/worker; npm run typecheck --workspace @clipclap/worker'
```

- [ ] **Step 2: Obtain two independent reviews**

Run spec-compliance review, fix/re-review, then code-quality/security review and whole-
branch diff review. Re-run the complete verification after the last code change.

- [ ] **Step 3: Deploy `shadow`**

With a fresh matching gate input, drain `video-analyze`, set
`ANALYZE_OUTCOME_RECOVERY_V1=shadow`, recreate only `worker-analyze`, verify image
revision/env/startup/queue, and observe at least five terminal eligible decisions or
seven days, whichever is later. Customer outputs must remain baseline-identical.

- [ ] **Step 4: Promote to `on` only through the composite release gate**

Require fresh passing clip and outcome decisions, drained queue, immutable image,
migration applied, and canary. Enable all users because traffic is low. Record counts
and denominators, never identities.

- [ ] **Step 5: Enforce rollback rules**

Immediately return to `off` for any rejected/gate-dropped resurrection, valid-empty
false positive, positive-corpus loss, malformed/black/frozen render, technical failure
masked as content, billing/refund regression, or attribution mismatch. Pause and human-
review any V4 `CUTOFF`, `QUALITY`, or `BORING` feedback before continuing rollout.

- [ ] **Step 6: Evaluate product signals**

After at least 20 eligible first jobs and 10 V4-attributed ratings, or 14 days
(whichever is later), report `AS_IS`, only-`NO`, seven-day return, plan-open, and paid
conversion as counts plus percentages. These metrics judge product value; they never
override a failed safety gate.
