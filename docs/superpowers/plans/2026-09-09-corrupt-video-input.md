# Corrupt Video Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject deterministically unreadable video files once, explain the problem clearly to the user, and reserve retries and operator incidents for technical failures.

**Architecture:** `normalizeSource` remains the authoritative media validation point. A numeric non-zero `ffprobe` exit becomes the existing `UnsupportedInputError`; that permanent domain family inherits BullMQ's `UnrecoverableError`, and the worker event hook recognizes early terminal failures so it releases the queue slot without raising an infrastructure incident.

**Tech Stack:** TypeScript, BullMQ, FFmpeg/ffprobe, Vitest, Prisma job-error prefixes.

---

### Task 1: Classify unreadable media without hiding infrastructure failures

**Files:**
- Modify: `apps/worker/src/__tests__/normalize.test.ts`
- Modify: `apps/worker/src/processors/normalize.ts`

- [ ] **Step 1: Write failing normalize tests**

Extend the child-process mock so it can reject. Add one test where the error has numeric `code: 1`, `killed: false`, and ffprobe's `moov atom not found` stderr; require `normalizeSource` to reject with `UnsupportedInputError` and a message that says the video is damaged or incomplete. Add a second test with `code: "ENOENT"`; require the original error object to escape unchanged.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run apps/worker/src/__tests__/normalize.test.ts
```

Expected: the numeric-exit test receives the raw child-process error instead of `UnsupportedInputError`; the ENOENT test passes.

- [ ] **Step 3: Add the minimal classifier**

In `normalizeSource`, wrap only the first `probeTimeline(localPath)` call. Convert an object with numeric `code` and `killed !== true` to:

```ts
new UnsupportedInputError(
  "The file could not be read as a video; it may be damaged or incomplete"
)
```

Rethrow every other error unchanged. Do not match mutable ffprobe prose.

- [ ] **Step 4: Verify GREEN**

Run the normalize test command again. Expected: all normalize tests pass.

### Task 2: Stop retries and handle an early terminal failure correctly

**Files:**
- Modify: `apps/worker/src/processors/errors.ts`
- Modify: `apps/worker/src/__tests__/worker-role.test.ts`
- Modify: `apps/worker/src/__tests__/queue-release-hooks.test.ts`
- Modify: `apps/worker/src/worker-app.ts`

- [ ] **Step 1: Write failing worker tests**

Add a worker-hook test which passes an `UnrecoverableError` at attempt 1 of 3 and requires `releaseNextQueued("user-1")` to be called while `notifyPipelineIncident` is not called. Add a direct `maybeReleaseAfterStageEvent` test with the same early unrecoverable shape.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run apps/worker/src/__tests__/worker-role.test.ts apps/worker/src/__tests__/queue-release-hooks.test.ts
```

Expected: the new tests fail because attempt 1 is currently treated as retriable.

- [ ] **Step 3: Implement terminal-domain semantics**

Make the four errors documented as permanent in `processors/errors.ts` inherit from BullMQ's `UnrecoverableError`. In `worker-app.ts`, use one `isTerminalFailure(job, error)` predicate for incident and queue-release decisions. It returns true when attempts are exhausted or the error is a BullMQ `UnrecoverableError`. Infrastructure incidents are sent only for exhausted retryable failures; unrecoverable domain verdicts release the slot but do not alert.

- [ ] **Step 4: Verify GREEN**

Run the two worker test files again. Expected: all tests pass.

### Task 3: Make the user message unambiguous in every surface

**Files:**
- Modify: `packages/shared/src/lib/job-error.ts`
- Modify: `apps/web/lib/job-error-text.ts`
- Modify: `apps/bot/src/i18n/en.ts`
- Modify: `apps/bot/src/i18n/ru.ts`
- Modify: `apps/bot/src/i18n/id.ts`
- Modify: `apps/bot/src/i18n/pt.ts`
- Modify: `apps/bot/src/i18n/ar.ts`
- Modify: `apps/bot/src/i18n/uk.ts`
- Modify: `apps/bot/src/i18n/es.ts`
- Test: `apps/web/src/__tests__/job-error-text.test.ts`
- Test: `apps/bot/src/__tests__/i18n.test.ts`

- [ ] **Step 1: Write failing copy assertions**

Require the Russian `UNSUPPORTED_INPUT` message to contain `повреждён`, `не полностью`, `воспроизводится до конца`, and `минуты не списаны`. Require the web English message to contain `damaged`, `incomplete`, `plays to the end`, and `minutes were not used`.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run apps/web/src/__tests__/job-error-text.test.ts apps/bot/src/__tests__/i18n.test.ts
```

Expected: the new assertions fail against the audio-only wording.

- [ ] **Step 3: Update the copy**

Keep the `UNSUPPORTED_INPUT` code and change each locale to say: the file cannot be read as video; it may be damaged, incomplete, or contain no video track; verify the original plays to the end and send a complete video file; minutes were not used. Update the shared code comment to reflect the widened meaning.

- [ ] **Step 4: Verify GREEN**

Run the copy test command again. Expected: all tests pass.

### Task 4: Regression verification

**Files:**
- No production changes.

- [ ] **Step 1: Run focused regression suites**

```bash
npx vitest run apps/worker/src/__tests__/normalize.test.ts apps/worker/src/__tests__/stage-flow.test.ts apps/worker/src/__tests__/job-error-guard.test.ts apps/worker/src/__tests__/worker-role.test.ts apps/worker/src/__tests__/queue-release-hooks.test.ts apps/web/src/__tests__/job-error-text.test.ts apps/bot/src/__tests__/i18n.test.ts
```

Expected: all tests pass with no unexpected warnings.

- [ ] **Step 2: Run type checks**

```bash
npm run typecheck -w @clipclap/worker
npm run typecheck -w @clipclap/bot
npx tsc -p apps/web/tsconfig.json --noEmit
```

Expected: all three commands exit 0.

- [ ] **Step 3: Inspect the final diff**

Run `git diff --check` and review only the files listed above. Do not include the user's unrelated SEO and audit worktree changes.
