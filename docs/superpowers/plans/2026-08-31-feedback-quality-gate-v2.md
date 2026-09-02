# Feedback Quality Gate V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private, fail-closed pre-deploy gate that promotes reviewed feedback, runs immutable observations, compares baseline with candidate, and permits worker deployment only for a matching passing decision.

**Architecture:** Add an isolated `feedback-quality` domain beside V1 feedback learning. Pure policy code evaluates closed observation contracts; private stores publish content-addressed cases, observations, and decisions atomically; thin CLI adapters supply DB/R2/analyze/render/deploy dependencies. Runtime customer jobs remain untouched.

**Tech Stack:** TypeScript, Vitest, Prisma read-only transactions, Cloudflare R2 read-only GET, FFmpeg stage adapters, BullMQ/Redis preflight, Docker Compose deployment.

---

### Task 1: Closed contracts and comparison policy

**Files:**
- Create: `apps/worker/src/feedback-quality/types.ts`
- Create: `apps/worker/src/feedback-quality/policy.ts`
- Test: `apps/worker/src/__tests__/feedback-quality-policy.test.ts`

- [ ] **Step 1: Write failing policy tests**

Cover minimum corpus, same-commit equality, a positive disappearing, a confirmed
negative worsening, a hard render invariant, holdout separation, and
`non_regression_only`. Build cases through a typed helper:

```ts
const observation = (overrides: Partial<QualityObservation> = {}): QualityObservation => ({
  schemaVersion: 1,
  observationId: "sha256:" + "1".repeat(64),
  mode: "baseline",
  set: "eval",
  commitSha: "a".repeat(40),
  configSha256: "sha256:" + "2".repeat(64),
  corpusSha256: "sha256:" + "3".repeat(64),
  runnerVersion: 1,
  createdAt: "2026-08-31T00:00:00.000Z",
  cases: [],
  ...overrides,
});

expect(compareObservations(baseline, candidate, policy)).toMatchObject({
  verdict: "fail",
  reasons: ["positive_regression"],
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-quality-policy.test.ts
```

Expected: FAIL because `feedback-quality/policy` does not exist.

- [ ] **Step 3: Implement closed types and pure policy**

Define literal unions for `TargetSet`, `Disposition`, `Subsystem`,
`CaseStatus`, `MachineReason`, `GateVerdict`, `QualityCaseResult`,
`QualityObservation`, `GatePolicy`, and `GateDecisionInput`. Export:

```ts
export function compareObservations(
  baseline: QualityObservation,
  candidate: QualityObservation,
  policy: GatePolicy,
): GateComparison;
```

Validate own enumerable keys, finite nonnegative metrics, unique case versions,
matching set/corpus/config/runner, minimum `evalPositive=4`, `evalNegative=6`,
`holdoutPositive=1`, `holdoutNegative=2`, and deterministic reason ordering.
Any missing/stale/error case fails before metric comparison. A positive must
retain its approved moment and every hard invariant. A negative's labelled
subsystem defect severity may decrease but not increase.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the focused command from Step 2. Expected: all policy tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/feedback-quality/types.ts apps/worker/src/feedback-quality/policy.ts apps/worker/src/__tests__/feedback-quality-policy.test.ts
git commit -m "feat(eval): define feedback quality policy"
```

### Task 2: Canonical IDs and private atomic store

**Files:**
- Create: `apps/worker/src/feedback-quality/store.ts`
- Test: `apps/worker/src/__tests__/feedback-quality-store.test.ts`

- [ ] **Step 1: Write failing store tests**

Use a temporary `0700` root. Assert canonical key-order-independent IDs,
`0700/0600` modes, exact no-op republish, differing-content collision refusal,
symlink/special-file refusal, lock contention, pre/post-rename fault outcomes,
and no private values in error messages.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-quality-store.test.ts
```

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement the store**

Reuse `canonicalJson`, `sha256`, and `withCorpusLock`. Export:

```ts
export const DEFAULT_QUALITY_ROOT: string;
export function contentId(prefix: "case" | "observation" | "decision", value: unknown): string;
export async function ensureQualityTree(root?: string): Promise<QualityPaths>;
export async function appendLabelEvent(event: QualityLabelEvent, root?: string): Promise<CommitResult>;
export async function publishBundle(input: PublishBundleInput, root?: string): Promise<CommitResult>;
export async function readBundle(kind: BundleKind, id: string, root?: string): Promise<ReadonlyMap<string, Uint8Array>>;
```

Anchor directory operations through open file descriptors, use
`O_NOFOLLOW`, `O_EXCL`, `fsync`, atomic rename, parent `fsync`, and verified
uncertain outcomes. Never recursively repair unrelated `.corpus` paths.

- [ ] **Step 4: Verify GREEN and existing persistence tests**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-quality-store.test.ts apps/worker/src/__tests__/feedback-learning-persistence.test.ts apps/worker/src/__tests__/feedback-learning-lock.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/feedback-quality/store.ts apps/worker/src/__tests__/feedback-quality-store.test.ts
git commit -m "feat(eval): add private quality gate store"
```

### Task 3: Reviewed label promotion and case materialization

**Files:**
- Create: `apps/worker/src/feedback-quality/repository.ts`
- Create: `apps/worker/src/feedback-quality/promote.ts`
- Create: `apps/worker/src/scripts/feedback-quality-promote.ts`
- Test: `apps/worker/src/__tests__/feedback-quality-promote.test.ts`
- Test: `apps/worker/src/scripts/__tests__/feedback-quality-cli.test.ts`
- Modify: `apps/worker/package.json`

- [ ] **Step 1: Write failing promotion tests**

Test exact feedback identity, read-only repeatable-read ordering, AS_IS-only
positive labels, confirmed engine-caused EDIT/NO negatives, excluded subjective
or source-caused rows, destination lock, retirement, required transcript/source
inputs by subsystem, read-only evidence download, and stale refusal.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-quality-promote.test.ts apps/worker/src/scripts/__tests__/feedback-quality-cli.test.ts
```

- [ ] **Step 3: Implement repository and promotion**

The repository exposes only:

```ts
export interface QualityPromotionRepository {
  capture(input: PromotionIdentity): Promise<PromotionSnapshot>;
}
```

Its transaction starts with `SET TRANSACTION READ ONLY` and selects feedback,
clip, job transcript/source metadata, and existing V1 approval identity. The
promoter accepts a private `0600` JSON decision file, validates a closed union,
downloads with injected `downloadFile`, computes `caseVersion`, publishes the
case bundle, then appends the label event under one lock. No DB/R2 mutation
method is reachable.

- [ ] **Step 4: Implement strict CLI**

Support only:

```text
feedback-quality-promote promote --decision-file <0600 file>
feedback-quality-promote retire --target-event <id> --reason-file <0600 file>
```

Add `feedback-quality-promote` to `apps/worker/package.json`. Logs allow only
operation, event ID, case version, status, and machine reason.

- [ ] **Step 5: Verify GREEN**

Run the focused tests from Step 2 and worker typecheck.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/feedback-quality apps/worker/src/scripts/feedback-quality-promote.ts apps/worker/src/__tests__/feedback-quality-promote.test.ts apps/worker/src/scripts/__tests__/feedback-quality-cli.test.ts apps/worker/package.json
git commit -m "feat(eval): promote reviewed feedback cases"
```

### Task 4: Immutable observation runner

**Files:**
- Create: `apps/worker/src/feedback-quality/observe.ts`
- Create: `apps/worker/src/feedback-quality/selection-lane.ts`
- Create: `apps/worker/src/feedback-quality/render-lane.ts`
- Create: `apps/worker/src/scripts/feedback-quality-observe.ts`
- Test: `apps/worker/src/__tests__/feedback-quality-observe.test.ts`
- Modify: `apps/worker/package.json`

- [ ] **Step 1: Write failing observation tests**

Test explicit env allowlisting, eval/holdout isolation, deterministic replay
fingerprint mismatch, required live lane on prompt/model fingerprint change,
three live attempts stored independently, stage-equivalent render ordering,
geometry/SAR/duration/black/freeze/subtitle/focal metrics, missing input failure,
and immutable observation publication.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-quality-observe.test.ts
```

- [ ] **Step 3: Implement selection lane**

Export an injected adapter:

```ts
export async function observeSelectionCase(
  qualityCase: MaterializedCase,
  options: SelectionLaneOptions,
): Promise<QualityCaseResult>;
```

Use `analyzeHighlightsV2` with either a strict recorded-response client or
three named live attempts. Compute approved-window overlap, empty result,
hook delay, pre-hook gap, payoff containment, boundary errors, score, low-quality
and rescue/critic telemetry. Never average attempts into a fake single result.

- [ ] **Step 4: Implement render lane**

Use exactly `segmentsToCues`, `createAssFilter`, `computeCropPlan`,
`buildFiltergraph`, and `cutClips`. Probe `1080x1920`, SAR `1:1`, duration drift,
frame count, black/freeze tail, subtitle bounds/overlap markers, and reviewed
focal coverage. Write only the private observation temp directory.

- [ ] **Step 5: Implement observation CLI**

```text
feedback-quality-observe --set eval|holdout --mode baseline|candidate --commit <40hex> --config-file <0600 json> [--live]
```

The CLI derives corpus/config/runner digests, refuses dirty tracked files and
unknown flags, publishes one content-addressed observation, and logs only safe
fields. Add the package script.

- [ ] **Step 6: Verify GREEN and commit**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-quality-observe.test.ts
npm run typecheck -w @clipclap/worker
git add apps/worker/src/feedback-quality apps/worker/src/scripts/feedback-quality-observe.ts apps/worker/src/__tests__/feedback-quality-observe.test.ts apps/worker/package.json
git commit -m "feat(eval): observe private feedback corpus"
```

### Task 5: Gate decisions and strict CLI

**Files:**
- Create: `apps/worker/src/feedback-quality/gate.ts`
- Create: `apps/worker/src/scripts/feedback-quality-gate.ts`
- Test: `apps/worker/src/__tests__/feedback-quality-gate.test.ts`
- Modify: `apps/worker/package.json`

- [ ] **Step 1: Write failing gate tests**

Test matching baseline/candidate pass, every policy failure reason, eval before
holdout, 24-hour expiry, commit/config/corpus/runner binding, canonical decision
ID, safe report redaction, and nonzero CLI exits for all ambiguous states.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-quality-gate.test.ts
```

- [ ] **Step 3: Implement decision generation**

Export:

```ts
export async function decideGate(input: DecideGateInput, dependencies: GateDependencies): Promise<GateDecision>;
```

Read immutable observation bundles, validate them through Task 1, compare eval,
then compare holdout only if eval passes. Create a canonical `decision.json`
and redacted `report.md`; bind expiry to `createdAt + 24h`; publish atomically.

- [ ] **Step 4: Implement CLI and verify GREEN**

```text
feedback-quality-gate --baseline-eval <id> --candidate-eval <id> --baseline-holdout <id> --candidate-holdout <id> --claim improvement|non-regression
```

Add the package script, run the focused test, and typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/feedback-quality/gate.ts apps/worker/src/scripts/feedback-quality-gate.ts apps/worker/src/__tests__/feedback-quality-gate.test.ts apps/worker/package.json
git commit -m "feat(eval): issue strict quality gate decisions"
```

### Task 6: Deployment authorization and queue-safe rollout

**Files:**
- Create: `apps/worker/src/feedback-quality/deploy.ts`
- Create: `apps/worker/src/scripts/feedback-quality-deploy.ts`
- Test: `apps/worker/src/__tests__/feedback-quality-deploy.test.ts`
- Modify: `apps/worker/package.json`

- [ ] **Step 1: Write failing deploy tests**

Test pass requirement, expiry, HEAD/config/corpus equality, dirty tracked refusal,
allowed worker service names, argument-vector execution, zero active/waiting jobs,
ordered recreation, startup/canary verification, stop-on-first-failure, partial
rollout report, and `0600` reasoned override event.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-quality-deploy.test.ts
```

- [ ] **Step 3: Implement authorization and rollout**

Export an injected orchestration boundary:

```ts
export async function deployWithQualityGate(
  request: DeployRequest,
  dependencies: DeployDependencies,
): Promise<DeployResult>;
```

Production dependencies read `git rev-parse HEAD/status`, effective config,
`QUEUE_NAMES` via BullMQ, and spawn only:

```text
docker compose up -d --force-recreate <explicit-worker-service>
```

No shell is used. Queue counts must be zero immediately before each service.
Persist rollout/override events privately before reporting success.

- [ ] **Step 4: Implement CLI, verify GREEN, and commit**

```text
feedback-quality-deploy --decision <id> --service worker-analyze [--service worker-render] [--override-reason-file <0600 file>]
```

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-quality-deploy.test.ts
npm run typecheck -w @clipclap/worker
git add apps/worker/src/feedback-quality/deploy.ts apps/worker/src/scripts/feedback-quality-deploy.ts apps/worker/src/__tests__/feedback-quality-deploy.test.ts apps/worker/package.json
git commit -m "feat(deploy): require feedback quality gate"
```

### Task 7: Dependency boundaries, runbook, and end-to-end proof

**Files:**
- Create: `apps/worker/src/__tests__/feedback-quality-dependencies.test.ts`
- Create: `apps/worker/src/__tests__/feedback-quality-e2e.test.ts`
- Modify: `docs/runbooks/feedback-learning.md`
- Modify: `.env.example`

- [ ] **Step 1: Write failing dependency and E2E tests**

AST-walk reachable sources. Promotion may reach Prisma reads and R2 GET only;
observe may reach analyze/render but no DB/R2 mutation; gate is pure private I/O;
deploy alone may reach BullMQ and process spawn. Assert safe logs. The E2E test
creates 5 positives and 8 negatives split across eval/holdout, publishes
identical baseline/candidate observations and expects pass, then mutates one
positive and expects `positive_regression`.

- [ ] **Step 2: Verify RED, implement missing boundaries, verify GREEN**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-quality-dependencies.test.ts apps/worker/src/__tests__/feedback-quality-e2e.test.ts
```

- [ ] **Step 3: Document operator workflow**

Document private backup, promotion decision files, baseline/candidate observe,
eval then holdout gate, decision expiry, queue preflight, canary evidence,
override audit, rollback, and the requirement to rebuild worker images so
`fs-ext` and current Prisma Client exist before running production commands.
Add only non-secret root settings to `.env.example`:

```env
FEEDBACK_QUALITY_ROOT=/app/apps/worker/.corpus/feedback-quality-gate
FEEDBACK_QUALITY_DECISION_TTL_HOURS=24
```

- [ ] **Step 4: Run full verification**

```bash
npx vitest run --root . apps/worker/src
npm run typecheck -w @clipclap/worker
npm run build -w @clipclap/worker
git diff --check
```

Expected: zero failures, zero type errors, successful build, clean diff check.

- [ ] **Step 5: Prove same-version smoke gate**

Using a temporary private corpus created by the E2E fixture, run the actual
observe and gate CLIs twice for the same commit/config. Verify a passing decision,
then run the synthetic-regression variant and verify exit code `1`. Do not use
production labels for this automated smoke.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/__tests__/feedback-quality-dependencies.test.ts apps/worker/src/__tests__/feedback-quality-e2e.test.ts docs/runbooks/feedback-learning.md .env.example
git commit -m "test(eval): prove feedback quality gate end to end"
```

### Task 8: Review, curate production corpus, and guarded rollout

**Files:**
- Private only: `apps/worker/.corpus/feedback-quality-gate/**`
- No tracked production-code changes expected after review fixes

- [ ] **Step 1: Request independent spec-compliance review**

Reviewer checks every acceptance criterion in the design against code and tests.
Fix all gaps and repeat until approved.

- [ ] **Step 2: Request independent code-quality/security review**

Reviewer focuses on private-path safety, fail-closed behavior, mutation
boundaries, command execution, queue races, redaction, and cryptographic binding.
Fix all important findings and repeat until approved.

- [ ] **Step 3: Curate the minimum real corpus**

Review and promote at least five fresh positives and eight confirmed negatives,
including one holdout positive and two holdout negatives. Do not promote
subjective, source-caused, or missing-evidence cases.

- [ ] **Step 4: Run real baseline/candidate gate**

First run current commit/config against itself and require pass. Then run the
candidate core flags/fixes. Any eval or holdout regression leaves production
unchanged.

- [ ] **Step 5: Deploy only a passing candidate**

Use `feedback-quality-deploy` for explicitly named workers. Verify effective
environment, startup logs, one canary job, delivery, and rollout event. If no
candidate passes, report the blocked reasons and do not override automatically.

- [ ] **Step 6: Final repository verification**

```bash
git status --short
git log --oneline --decorate -12
```

Expected: only intentional commits plus the owner's pre-existing untracked
`apps/worker/src/tmp-audit.ts`; private corpus remains ignored.
