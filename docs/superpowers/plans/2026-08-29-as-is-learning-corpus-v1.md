# AS_IS Learning Corpus V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic private `AS_IS` exporter and a locked manual review ledger without adding any production or eval consumer.

**Architecture:** Worker-only modules separate contracts, canonical normalization, ledger folding, deterministic selection, rendering, private persistence, a narrow Prisma snapshot adapter, export orchestration, and review orchestration. All export database reads use one read-only repeatable-read transaction. Ledger mutations use Linux `flock` and an explicit atomic-rename commit point.

**Tech Stack:** TypeScript, Node.js 20, Vitest 3, Prisma 5.20/PostgreSQL, `fs-ext`, Node `fs/promises`.

---

## File map

- `apps/worker/src/feedback-learning/types.ts`: closed V1 contracts.
- `apps/worker/src/feedback-learning/canonical.ts`: canonical JSON, SHA-256, strict UTC and byte serialization.
- `apps/worker/src/feedback-learning/normalize.ts`: feedback/Job normalization and warning order.
- `apps/worker/src/feedback-learning/ledger.ts`: event validation, fold, stale and capacity state.
- `apps/worker/src/feedback-learning/select.ts`: exclusion precedence, strata, caps and round-robin.
- `apps/worker/src/feedback-learning/render.ts`: hashes, manifest, JSONL and Markdown bytes.
- `apps/worker/src/feedback-learning/lock.ts`: bounded Linux advisory lock.
- `apps/worker/src/feedback-learning/persistence.ts`: private paths and verified atomic publication.
- `apps/worker/src/feedback-learning/repository.ts`: narrow Prisma read adapters.
- `apps/worker/src/feedback-learning/export.ts`: export orchestration.
- `apps/worker/src/feedback-learning/review.ts`: approve, reject and correction orchestration.
- `apps/worker/src/feedback-learning/cli.ts`: strict argument parsing and safe result formatting.
- `apps/worker/src/scripts/feedback-learning-export.ts`: thin export CLI.
- `apps/worker/src/scripts/feedback-learning-review.ts`: thin review CLI.
- `apps/worker/src/__tests__/feedback-learning-*.test.ts`: focused unit, filesystem, concurrency and boundary tests.
- `apps/worker/src/scripts/__tests__/feedback-learning-cli.test.ts`: CLI contract tests.
- `apps/worker/package.json`, `package-lock.json`, `apps/worker/Dockerfile`: commands and native lock dependency.
- `packages/shared/package.json`: runtime export for the narrow Prisma module.
- `docs/runbooks/feedback-learning.md`: private operation and recovery.

The existing untracked `apps/worker/src/tmp-audit.ts` is out of scope and must never be staged.

### Task 1: Linux lock and dependency viability

**Files:**
- Create: `apps/worker/src/feedback-learning/lock.ts`
- Create: `apps/worker/src/__tests__/feedback-learning-lock.test.ts`
- Modify: `apps/worker/package.json`
- Modify: `package-lock.json`
- Modify: `apps/worker/Dockerfile`

- [ ] **Step 1: Write the failing lock tests**

Test this exact API with real child processes:

```ts
export interface LockOptions {
  retryMs?: number;
  timeoutMs?: number;
  nowNs?: () => bigint;
  delay?: (ms: number) => Promise<void>;
}

export async function withCorpusLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options?: LockOptions
): Promise<T>;
```

Assert the callback runs while `reviews.lock` is a regular `0600` file. A second process must retry
and return machine code `lock_timeout`; killing the holder must let the next process acquire the
kernel lock. Simulating contention with two callbacks in one process is not sufficient.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-lock.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add dependencies and Docker build support**

```bash
npm install -w @clipclap/worker fs-ext@2.1.1
npm install -D -w @clipclap/worker @types/fs-ext@2.0.3
```

Add `RUN apk add --no-cache build-base` only in the Docker `deps` stage before `npm install`.
Do not add compiler packages to `base` or `production`. After production copies `node_modules`, add
`RUN node -e "require('fs-ext')" && ! apk info -e build-base` so the final stage proves the addon
loads and compiler packages are absent.

- [ ] **Step 4: Implement the minimal lock**

Open with `O_CREAT | O_NOFOLLOW | O_RDWR`, enforce `0600` with `fchmod`, reject non-regular files,
and call `flock(fd, "exnb")`. Retry only `EAGAIN` or `EWOULDBLOCK` every 50 ms until a monotonic
five-second deadline. Hold the same `FileHandle` through the callback; unlock and close in `finally`.
Public failures expose only machine codes, never paths or private IDs.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-lock.test.ts
npm run typecheck -w @clipclap/worker
docker build -f apps/worker/Dockerfile --target production .
git add apps/worker/src/feedback-learning/lock.ts apps/worker/src/__tests__/feedback-learning-lock.test.ts apps/worker/package.json package-lock.json apps/worker/Dockerfile
git commit -m "feat(worker): add private corpus flock"
```

Expected: focused tests pass, typecheck exits 0, production image builds, loads `fs-ext`, and proves
the final stage does not install `build-base`.

### Task 2: Private atomic persistence

**Files:**
- Create: `apps/worker/src/feedback-learning/persistence.ts`
- Create: `apps/worker/src/__tests__/feedback-learning-persistence.test.ts`

- [ ] **Step 1: Write failing filesystem tests**

Test these APIs against real temporary directories and injected fault points:

```ts
export type CommitResult =
  | { status: "committed" }
  | { status: "noop" }
  | { status: "committed_durability_uncertain" }
  | { status: "indeterminate" };

export async function ensurePrivateTree(root: string): Promise<PrivatePaths>;
export async function replaceLedgerAtomically(input: LedgerWrite): Promise<CommitResult>;
export async function publishRunAtomically(input: RunWrite): Promise<CommitResult>;
```

Cover `0700` V1-owned directories, `0600` files under permissive umask, symlink refusal, exact
no-op bytes, integrity failure for different existing bytes, and failures before/after write, file
fsync, close, rename and parent fsync. Post-rename results must come from no-follow reread of expected
`eventId` or `runDigest`.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-persistence.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement private paths and commit protocols**

Create and validate each component with `lstat`, `mkdir(0o700)`, directory `O_NOFOLLOW`, `fchmod`,
and `fsync`. Own only `apps/worker/.corpus/feedback-learning`; do not chmod unrelated `.corpus`
content. Ledger order is temp open `0600`, write, file sync, close, rename, directory sync. Run order
is sibling temp dir `0700`, write/sync/close four `0600` files, temp-dir sync, rename, parent sync.
Rename is the commit point; verify uncertainty after any possible rename.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-persistence.test.ts
npm run typecheck -w @clipclap/worker
git add apps/worker/src/feedback-learning/persistence.ts apps/worker/src/__tests__/feedback-learning-persistence.test.ts
git commit -m "feat(worker): persist private corpus atomically"
```

Expected: tests and typecheck pass.

### Task 3: Closed contracts, canonical bytes and normalization

**Files:**
- Create: `apps/worker/src/feedback-learning/types.ts`
- Create: `apps/worker/src/feedback-learning/canonical.ts`
- Create: `apps/worker/src/feedback-learning/normalize.ts`
- Create: `apps/worker/src/__tests__/feedback-learning-canonical.test.ts`
- Create: `apps/worker/src/__tests__/feedback-learning-normalize.test.ts`

- [ ] **Step 1: Write failing canonical and normalization tests**

```ts
export interface FeedbackProjection {
  id: string;
  clipId: string;
  jobId: string;
  userId: string;
  verdict: string;
  note: string | null;
  snapshot: unknown;
  evidenceKey: string | null;
  updatedAt: Date;
}

export interface JobProjection {
  id: string;
  transcriptJson: unknown;
  transcriptPartial: boolean;
}

export function canonicalJson(value: unknown): string;
export function sha256(value: string | Buffer): `sha256:${string}`;
export function jsonLine(value: unknown): Buffer;
export function parseUtcMillisecond(value: string): Date;
export function normalizeFeedback(row: FeedbackProjection, job: JobProjection | null): NormalizedFeedbackResult;
```

Assert recursive object key sorting, array preservation, null snapshot handling, lowercase hashes,
strict UTC milliseconds, stable candidate identity, exact warning order, and tier classification.
Compare bytes rather than object equivalence.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-canonical.test.ts apps/worker/src/__tests__/feedback-learning-normalize.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement closed types and pure normalization**

Use discriminated unions for target set, warning, stale reason, exclusion, tier, events, normalized
records, candidate and manifest. Canonical JSON sorts keys with `<`/`>`, preserves arrays and rejects
non-JSON values. Normalization produces the exact pre-selection input record from the design and one
deterministic invalid marker when identity cannot be formed. It performs no DB or filesystem access.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-canonical.test.ts apps/worker/src/__tests__/feedback-learning-normalize.test.ts
npm run typecheck -w @clipclap/worker
git add apps/worker/src/feedback-learning/types.ts apps/worker/src/feedback-learning/canonical.ts apps/worker/src/feedback-learning/normalize.ts apps/worker/src/__tests__/feedback-learning-canonical.test.ts apps/worker/src/__tests__/feedback-learning-normalize.test.ts
git commit -m "feat(worker): normalize AS_IS learning candidates"
```

Expected: tests and typecheck pass.

### Task 4: Ledger, stale state and capacity

**Files:**
- Create: `apps/worker/src/feedback-learning/ledger.ts`
- Create: `apps/worker/src/__tests__/feedback-learning-ledger.test.ts`

- [ ] **Step 1: Write failing ledger tests**

```ts
export function parseLedger(bytes: Buffer): readonly ReviewEvent[];
export function foldLedger(events: readonly ReviewEvent[]): EffectiveLedger;
export function canonicalLedgerState(state: EffectiveLedger): string;
export function classifyApprovalFreshness(approval: ApprovalEvent, current: FeedbackProjection | null): Freshness;
export function buildCapacity(state: EffectiveLedger, currentRows: ReadonlyMap<string, FeedbackProjection | null>): CapacityState;
```

Cover strict closed event variants, duplicate IDs, forward correction, correction-of-correction,
inactive targets, active-decision conflicts, permanent first-set lock, retirement, stale precedence,
fresh slots and stale reservations. Equivalent effective state must yield identical canonical bytes.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-ledger.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure fold and capacity state**

Validate exact keys, schema, strings, hashes, UTC times, non-empty reasons and transitions in file
order. Use stale precedence `missing`, `verdict_changed`, `updated_at_changed`, `snapshot_changed`.
Fresh approvals and stale reservations consume per-set frozen job/user slots; rejects and retired
events do not. Retirement never removes the first destination lock.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-ledger.test.ts
npm run typecheck -w @clipclap/worker
git add apps/worker/src/feedback-learning/ledger.ts apps/worker/src/__tests__/feedback-learning-ledger.test.ts
git commit -m "feat(worker): fold feedback learning reviews"
```

Expected: tests and typecheck pass.

### Task 5: Deterministic selection and rendering

**Files:**
- Create: `apps/worker/src/feedback-learning/select.ts`
- Create: `apps/worker/src/feedback-learning/render.ts`
- Create: `apps/worker/src/__tests__/feedback-learning-select.test.ts`
- Create: `apps/worker/src/__tests__/feedback-learning-render.test.ts`

- [ ] **Step 1: Write failing selection and golden-byte tests**

```ts
export function selectCandidates(input: SelectionInput): SelectionResult;
export function buildRunArtifacts(input: RenderInput): RunArtifacts;
```

Test every precedence collision: invalid, stale approval, exact active decision, starting caps,
provisional caps and limit. Assert byte comparator strata, updatedAt-desc/feedbackId-asc rows,
round-robin, job-before-user caps and independent sets. Golden tests assert field order, compact
JSONL, zero-byte empty JSONL, LF rules, Markdown order, count equations, hashes, run digest and ID.
Changing any output-affecting projection must change input hash or output bytes.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-select.test.ts apps/worker/src/__tests__/feedback-learning-render.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement selection and rendering as pure functions**

Implement the documented phases exactly. Render solely from normalized memory records and captured
ledger/capacity state. Include `runDigest`, complete counts and feedback-ID-sorted stale assignments.
Return safe internal status data for the caller; the later CLI allowlist decides which non-private
fields may be printed.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-select.test.ts apps/worker/src/__tests__/feedback-learning-render.test.ts
npm run typecheck -w @clipclap/worker
git add apps/worker/src/feedback-learning/select.ts apps/worker/src/feedback-learning/render.ts apps/worker/src/__tests__/feedback-learning-select.test.ts apps/worker/src/__tests__/feedback-learning-render.test.ts
git commit -m "feat(worker): select and render AS_IS corpus runs"
```

Expected: tests and typecheck pass.

### Task 6: Read-only database snapshot and exporter

**Files:**
- Create: `apps/worker/src/feedback-learning/repository.ts`
- Create: `apps/worker/src/feedback-learning/export.ts`
- Create: `apps/worker/src/__tests__/feedback-learning-repository.test.ts`
- Create: `apps/worker/src/__tests__/feedback-learning-export.test.ts`
- Modify: `packages/shared/package.json`

- [ ] **Step 1: Write failing repository and exporter tests**

```ts
export interface FeedbackLearningRepository {
  captureExportSnapshot(input: SnapshotRequest): Promise<DatabaseSnapshot>;
  captureReviewSnapshot(input: ReviewSnapshotRequest): Promise<ReviewDatabaseSnapshot>;
}

export function createPrismaFeedbackLearningRepository(client: PrismaClient): FeedbackLearningRepository;
export async function exportFeedbackLearning(input: ExportRequest, dependencies: ExportDependencies): Promise<SafeExportResult>;
```

Assert interactive transaction order: first callback statement is fixed `SET TRANSACTION READ ONLY`,
then exact `AS_IS` half-open cohort without `take`, Job projection, and current rows for all active
approvals including outside cohort. Assert `RepeatableRead`, explicit timeout and no later DB read.
Exporter must snapshot ledger under lock, release it, capture DB once, render in memory and publish
exactly four files. Cover committed, noop, uncertain, integrity and indeterminate results.
The review snapshot must also use one read-only `RepeatableRead` transaction for the candidate row
and every active approval row, so capacity never mixes database states.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-repository.test.ts apps/worker/src/__tests__/feedback-learning-export.test.ts
npm run build -w @clipclap/shared
node -e "require('@clipclap/shared/lib/prisma')"
```

Expected: Vitest FAIL because the modules do not exist, and the real Node subpath smoke FAIL before
the package export is added. The shared build removes dependence on any stale local `dist`.

- [ ] **Step 3: Implement narrow repository and exporter**

Use Prisma `RepeatableRead` and fixed `SET TRANSACTION READ ONLY`. Return DTOs before closing the
transaction. Both export and review snapshots perform no later reads. The repository exposes only reads. Export defaults to
`apps/worker/.corpus/feedback-learning`, supports injected roots for tests, and never queries after
the snapshot. Add package exports for root, `./config/*`, and compatible `./lib/*` runtime/type
patterns to `packages/shared/package.json`; this adds Prisma without closing the existing job-error,
ytdlp-proxy, or future lib subpaths. Do not import the eager shared barrel; Prisma is composed from
`@clipclap/shared/lib/prisma`. Runtime smoke tests must cover Prisma plus every currently used shared
subpath.

Use this exact export map:

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "require": "./dist/index.js", "default": "./dist/index.js" },
  "./lib/*": { "types": "./dist/lib/*.d.ts", "require": "./dist/lib/*.js", "default": "./dist/lib/*.js" },
  "./config/*": { "types": "./dist/config/*.d.ts", "require": "./dist/config/*.js", "default": "./dist/config/*.js" }
}
```

- [ ] **Step 4: Verify GREEN and commit**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-repository.test.ts apps/worker/src/__tests__/feedback-learning-export.test.ts
npm run build -w @clipclap/shared
node -e "require('@clipclap/shared/lib/prisma'); require('@clipclap/shared/lib/job-error'); require('@clipclap/shared/lib/ytdlp-proxy'); require('@clipclap/shared/config/plans'); require('@clipclap/shared/config/model-prices')"
npm run typecheck -w @clipclap/worker
git add apps/worker/src/feedback-learning/repository.ts apps/worker/src/feedback-learning/export.ts apps/worker/src/__tests__/feedback-learning-repository.test.ts apps/worker/src/__tests__/feedback-learning-export.test.ts packages/shared/package.json
git commit -m "feat(worker): export AS_IS learning corpus"
```

Expected: tests, a real Node runtime smoke from freshly built shared output, and typecheck pass.

### Task 7: Authoritative review workflow

**Files:**
- Create: `apps/worker/src/feedback-learning/review.ts`
- Create: `apps/worker/src/__tests__/feedback-learning-review.test.ts`

- [ ] **Step 1: Write failing workflow, tamper, race and fault tests**

```ts
export type ReviewRequest =
  | { action: "approve" | "reject"; runId: string; candidateVersion: string; reason?: string }
  | { action: "correct"; targetEventId: string; operation: "retire"; reason: string };

export async function reviewFeedback(request: ReviewRequest, dependencies: ReviewDependencies): Promise<SafeReviewResult>;
```

Approve/reject first validate `runId` against `^(eval|holdout)-[0-9a-f]{16}$` and candidate version
against the full lowercase `sha256:<64 hex>` contract before any path operation. They then resolve
containment under the exports root and load the candidate from the known private run file. Under one lock assert ledger
reread/fold, current row re-read, exact candidate identity/current `AS_IS`, authoritative clip/job/
user equality, set lock and refreshed caps. Reject consumes no cap; correct retires only an active
decision. Alter each identifier and prove refusal. Concurrent approvals must not exceed job 2/user 3.
Faults around rename must follow verified event state. Every refusal appends nothing. Add absolute
path, `../` traversal, malformed ID, resolved-containment, and symlink cases; none may read outside
the exports root.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-review.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement review orchestration**

Validate both identifiers before `join`, then require the resolved candidate path to remain inside
the known exports root and pass no-follow/symlink checks. Mint event ID and time inside the lock.
For approve/reject, use DB clip/job/user values for capacity and event fields. Recompute every active
approval row under the lock immediately before persistence. Append prior ledger bytes unchanged plus
one canonical line through the atomic persistence helper.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-review.test.ts
npm run typecheck -w @clipclap/worker
git add apps/worker/src/feedback-learning/review.ts apps/worker/src/__tests__/feedback-learning-review.test.ts
git commit -m "feat(worker): review AS_IS corpus candidates"
```

Expected: tests and typecheck pass.

### Task 8: CLI, safe logs, runbook and full acceptance

**Files:**
- Create: `apps/worker/src/feedback-learning/cli.ts`
- Create: `apps/worker/src/scripts/feedback-learning-export.ts`
- Create: `apps/worker/src/scripts/feedback-learning-review.ts`
- Create: `apps/worker/src/scripts/__tests__/feedback-learning-cli.test.ts`
- Create: `apps/worker/src/__tests__/feedback-learning-dependencies.test.ts`
- Modify: `apps/worker/package.json`
- Create: `docs/runbooks/feedback-learning.md`

- [ ] **Step 1: Write failing CLI and dependency-boundary tests**

Lock these grammars:

```text
feedback-learning-export --set eval|holdout --updated-from <UTC> --updated-to <UTC> [--limit <positive>]
feedback-learning-review approve --run <run-id> --candidate-version <sha256>
feedback-learning-review reject --run <run-id> --candidate-version <sha256> --reason-file <0600 file>
feedback-learning-review correct --target-event <event-id> --operation retire --reason-file <0600 file>
```

Assert unknown/missing/duplicate flags fail, limit defaults to 50, from precedes to, imports cause no
side effects, Prisma disconnects and exit codes are exact. Reason files must be regular, no-follow,
and exactly `0600`; their content never appears in argv-derived diagnostics, stdout, or stderr. Logs
may contain only operation, run ID, event ID, and machine reason. Dependency tests reject OpenAI,
R2, eval, analyze, download and DB mutation access.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --root . apps/worker/src/scripts/__tests__/feedback-learning-cli.test.ts apps/worker/src/__tests__/feedback-learning-dependencies.test.ts
```

Expected: FAIL because the CLI files do not exist.

- [ ] **Step 3: Implement thin CLI and runbook**

CLI scripts only parse, securely read a private reason file when required, compose, call, allowlist
output, disconnect and exit. Never print arbitrary errors, paths, candidate versions, counts, or
private content. Add package scripts
`feedback-learning-export` and `feedback-learning-review`. The runbook documents exact commands,
single-host operation, private modes, stale retirement, uncertain commit recovery, backup limitation,
and that V1 changes neither eval nor production.

- [ ] **Step 4: Verify focused tests and commit**

```bash
npx vitest run --root . apps/worker/src/scripts/__tests__/feedback-learning-cli.test.ts apps/worker/src/__tests__/feedback-learning-dependencies.test.ts
npm run typecheck -w @clipclap/worker
git add apps/worker/src/feedback-learning/cli.ts apps/worker/src/scripts/feedback-learning-export.ts apps/worker/src/scripts/feedback-learning-review.ts apps/worker/src/scripts/__tests__/feedback-learning-cli.test.ts apps/worker/src/__tests__/feedback-learning-dependencies.test.ts apps/worker/package.json docs/runbooks/feedback-learning.md
git commit -m "feat(worker): add feedback learning commands"
```

Expected: focused tests and typecheck pass; no corpus content is tracked.

- [ ] **Step 5: Run complete acceptance**

```bash
npx vitest run --root . apps/worker/src/__tests__/feedback-learning-*.test.ts apps/worker/src/scripts/__tests__/feedback-learning-cli.test.ts
npm run typecheck -w @clipclap/worker
npm run build -w @clipclap/worker
npm test -w @clipclap/worker
docker build -f apps/worker/Dockerfile --target production .
npm run build -w @clipclap/shared
node -e "require('@clipclap/shared/lib/prisma'); require('@clipclap/shared/lib/job-error'); require('@clipclap/shared/lib/ytdlp-proxy'); require('@clipclap/shared/config/plans'); require('@clipclap/shared/config/model-prices')"
git diff main...HEAD --check
git check-ignore apps/worker/.corpus/feedback-learning/probe
git status --short
```

Expected: all focused and complete worker tests pass, typecheck/build/container build exit 0, corpus
is ignored, only approved V1 files differ, and `apps/worker/src/tmp-audit.ts` remains untracked.

- [ ] **Step 6: Two-stage final review**

Dispatch a spec-compliance reviewer first. After approval, dispatch a separate code-quality/security
reviewer. Every Critical or Important finding requires a focused regression test, a fix, and rerunning
all affected commands. Commit review fixes as `fix(worker): address feedback corpus review`; skip the
commit when no changes are required.
