# Storage Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make R2 storage bounded - enforce the clip retention the plans already sell, and stop keeping three copies of every source video forever.

**Architecture:** One hourly BullMQ repeatable job runs three independent sweep rules with three different clocks: expired clips (soft-delete + drop the object), redundant source copies (24h after the job is terminal), and the remaining source artifact (7 days, the edit window). A DB column is nulled only after its R2 delete is confirmed, because `renderTrim` treats a non-null `sourceArtifactKey` as "the object exists" and fails hard when it does not.

**Tech Stack:** TypeScript, Prisma 5.20 + PostgreSQL, BullMQ + Redis, `@aws-sdk/client-s3` against Cloudflare R2, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-27-storage-retention-design.md`

---

## Conventions for every task

**Test commands** (verified working on this host - the `worker` service does not exist, worker containers are role-split):

- Shared package tests:
  `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/<path>`
- Worker tests:
  `docker compose exec -w /app worker-render npx vitest run apps/worker/src/__tests__/<file>`
- Prisma (migrations, never `db push`):
  `docker compose exec -w /app web npx prisma migrate dev --name <name>`
- After changing anything in `packages/shared`, the worker runs the built `dist`:
  `docker compose exec -w /app web npm run build -w @clipclap/shared`

**Commits:** author is `Trowgar <trowgar@yahoo.com>`, no Claude attribution trailer. Use
`git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit`.

**Prose style:** plain hyphens `-`, never em-dashes or en-dashes, in code comments and commit messages alike.

---

## File Structure

**Created:**

- `packages/shared/src/services/retention.service.ts` - the three sweep rules and the orchestrator. All DB and R2 access for the sweep lives here; the worker only calls it.
- `packages/shared/src/services/__tests__/retention.service.test.ts` - unit tests for the rules, with `prisma` and `r2` mocked.
- `prisma/migrations/<timestamp>_job_source_swept_at/migration.sql` - generated.
- `docs/runbooks/retention-sweep.md` - how to do the first production pass.

**Modified:**

- `prisma/schema.prisma` - `Job.sourceSweptAt`, `@@index([status, createdAt])`.
- `packages/shared/src/lib/retention.ts` - the two new constants next to `computeClipExpiresAt`.
- `packages/shared/src/lib/index.ts` - export them.
- `packages/shared/src/lib/referral-queue.ts` - register the repeatable sweep job.
- `packages/shared/src/services/index.ts` - export `retentionService`.
- `packages/shared/src/services/clip.service.ts` - `ClipExpiredError`, `getDownloadUrl` refuses swept clips.
- `packages/shared/src/services/project.service.ts` - `deleteProject` leak, `expired` in the DTOs.
- `packages/shared/src/services/telegram-delivery.service.ts` - defensive `deletedAt: null` on the clip include.
- `apps/worker/src/stages/download.ts` - deterministic artifact keys.
- `apps/worker/src/referral-scheduler.ts` - dispatch the sweep job.
- `apps/web/app/api/clips/[id]/download/route.ts` - map `ClipExpiredError` to 410.
- `apps/web/components/clip-card.tsx` - render an expired clip instead of fetching a dead URL.
- `packages/shared/src/lib/__tests__/retention.test.ts` - drop a stale assertion (Task 0).
- `.env.example` - `RETENTION_SWEEP_DRY_RUN`.

**Why one service file:** the three rules share the delete-then-null invariant, the page size, and the dry-run switch. Splitting them across files would duplicate that contract three times. It stays under ~250 lines.

---

### Task 0: Fix the pre-existing red test in the file we are about to extend

`packages/shared/src/lib/__tests__/retention.test.ts` currently FAILS on this host. The
assertion `expect(days).toBeGreaterThan(1)` for the NONE plan was written when the free
trial was live; the trial was disabled on 2026-07-25 and `NONE_LIMITS.retentionDays` is
now `0`. We must not start a retention change with a red retention suite - we would not be
able to tell our own breakage from this one.

**Files:**
- Modify: `packages/shared/src/lib/__tests__/retention.test.ts:41-46`

- [ ] **Step 1: Run the suite and see the existing failure**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/lib/__tests__/retention.test.ts`

Expected: FAIL, 1 failed | 6 passed, `AssertionError: expected 0 to be greater than 1` at line 45.

- [ ] **Step 2: Replace the stale test**

Replace lines 38-46 (the comment and the `it(...)` block) with:

```typescript
  // NONE clips are whatever the NONE plan says, no special case. The free trial
  // is disabled (NONE_LIMITS is all zeros as of 2026-07-25), so the honest
  // assertion is "tracks the plan", not a floor from the era when it was live.
  it("uses the NONE plan's retention for free-run clips", () => {
    const expires = computeClipExpiresAt("NONE", null, now);
    const days = (expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(getPlanLimits("NONE").retentionDays);
  });
```

- [ ] **Step 3: Run the suite green**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/lib/__tests__/retention.test.ts`

Expected: PASS, 7 passed.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/lib/__tests__/retention.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "test(retention): drop the free-trial-era floor on NONE retention

NONE_LIMITS was zeroed when the trial was disabled, so the assertion that
free-run clips live longer than a day has been failing since 2026-07-25.
Assert what the function actually promises: it tracks the plan."
```

---

### Task 1: Retention constants

**Files:**
- Modify: `packages/shared/src/lib/retention.ts`
- Modify: `packages/shared/src/lib/index.ts:12`
- Test: `packages/shared/src/lib/__tests__/retention.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/lib/__tests__/retention.test.ts`:

```typescript
import {
  SOURCE_ARTIFACT_RETENTION_DAYS,
  REDUNDANT_SOURCE_GRACE_HOURS,
  sourceArtifactCutoff,
  redundantSourceCutoff,
} from "../retention";

describe("source artifact windows", () => {
  const now = new Date("2026-04-08T00:00:00Z");

  it("keeps the edit window at 7 days for every plan", () => {
    expect(SOURCE_ARTIFACT_RETENTION_DAYS).toBe(7);
    expect(sourceArtifactCutoff(now)).toEqual(new Date("2026-04-01T00:00:00Z"));
  });

  it("gives a terminal job 24 hours before its redundant copies go", () => {
    expect(REDUNDANT_SOURCE_GRACE_HOURS).toBe(24);
    expect(redundantSourceCutoff(now)).toEqual(new Date("2026-04-07T00:00:00Z"));
  });
});
```

Note: the `import` goes at the top of the file with the existing imports, not in the middle.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/lib/__tests__/retention.test.ts`

Expected: FAIL with "No export named SOURCE_ARTIFACT_RETENTION_DAYS" (or `undefined` assertions).

- [ ] **Step 3: Implement**

Append to `packages/shared/src/lib/retention.ts`:

```typescript
/** How long a job's source artifact survives after the job was created.
 *
 *  This is NOT a plan field and is deliberately not sold: nothing in the offer
 *  mentions the source video, only the clips. It is the window in which
 *  editing a clip is high quality - renderTrim cuts from the untouched source
 *  when Job.sourceArtifactKey is present, and falls back to re-trimming the
 *  finished clip file when it is not. The fallback is worse, not free: the clip
 *  already has subtitles burned in, so re-burning stacks text. Seven days is
 *  the compromise between that and the cost, which is not close: a clip is
 *  5-20 MB and a source is up to 2 GB.
 */
export const SOURCE_ARTIFACT_RETENTION_DAYS = 7;

/** How long a TERMINAL job keeps the copies of its source that nothing reads.
 *
 *  Job.sourceKey is read exactly once, by the download stage. The raw
 *  Job.sourceArtifactKey is read by nobody once normalization produced a
 *  separate file. Both are dead the moment the job stops running - the grace
 *  exists only so a manual re-run or a same-day incident investigation still
 *  has the input it needs.
 */
export const REDUNDANT_SOURCE_GRACE_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

/** Jobs created before this instant are past the edit window. */
export function sourceArtifactCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - SOURCE_ARTIFACT_RETENTION_DAYS * MS_PER_DAY);
}

/** Terminal jobs created before this instant may lose their redundant copies. */
export function redundantSourceCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - REDUNDANT_SOURCE_GRACE_HOURS * MS_PER_HOUR);
}
```

Then in `packages/shared/src/lib/index.ts`, replace line 12:

```typescript
export {
  computeClipExpiresAt,
  SOURCE_ARTIFACT_RETENTION_DAYS,
  REDUNDANT_SOURCE_GRACE_HOURS,
  sourceArtifactCutoff,
  redundantSourceCutoff,
} from "./retention";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/lib/__tests__/retention.test.ts`

Expected: PASS, 9 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/lib/retention.ts packages/shared/src/lib/index.ts packages/shared/src/lib/__tests__/retention.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(retention): add the source-artifact windows

Two clocks the sweep needs: 7 days for the artifact that editing cuts from,
24 hours for the copies of the source that nothing reads once the job is
terminal. Neither is a plan field - the offer only ever mentions clips."
```

---

### Task 2: Close the `deleteProject` leak

`deleteProject` collects `sourceKey`, `sourceArtifactKey` and `thumbnailKey` but not
`normalizedArtifactKey`, so manual deletion orphans the largest object in the job.

**Files:**
- Modify: `packages/shared/src/services/project.service.ts:255-295`
- Test: `packages/shared/src/services/__tests__/project.service.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/shared/src/services/__tests__/project.service.test.ts` currently mocks only
`prisma.job.findMany` and `getPresignedDownloadUrl`. Extend its two mock blocks at the top
of the file - add `jobFindFirst: vi.fn(), jobDelete: vi.fn(), deleteFile: vi.fn(),` to the
hoisted `mocks` object, then:

```typescript
vi.mock("../../lib/prisma", () => ({
  prisma: {
    job: {
      findMany: mocks.jobFindMany,
      findFirst: mocks.jobFindFirst,
      delete: mocks.jobDelete,
    },
  },
}));

vi.mock("../../lib/r2", () => ({
  getPresignedDownloadUrl: mocks.getPresignedDownloadUrl,
  deleteFile: mocks.deleteFile,
}));
```

Add `deleteProject` to the existing import from `../project.service`, then append:

```typescript
describe("deleteProject - R2 keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.jobDelete.mockResolvedValue({});
  });

  it("deletes the normalized artifact, which is the largest object in the job", async () => {
    mocks.jobFindFirst.mockResolvedValue({
      id: "job1",
      sourceKey: "uploads/u1/original.mp4",
      sourceArtifactKey: "work/u1/job1/source.mp4",
      normalizedArtifactKey: "work/u1/job1/normalized.mp4",
      thumbnailKey: "thumbs/job1.jpg",
      clips: [{ storageKey: "clips/u1/job1/a.mp4" }],
    });

    await deleteProject("job1", "u1");

    const deleted = mocks.deleteFile.mock.calls.map((c: any[]) => c[0]);
    expect(deleted).toContain("work/u1/job1/normalized.mp4");
    expect(deleted).toHaveLength(5);
  });

  it("does not delete the same key twice when normalization was a no-op", async () => {
    // normalizeSource returning action "none" stores the SAME key in both
    // columns. Deleting it twice logs a spurious failure for a key that is
    // already gone.
    mocks.jobFindFirst.mockResolvedValue({
      id: "job2",
      sourceKey: null,
      sourceArtifactKey: "work/u1/job2/source.mp4",
      normalizedArtifactKey: "work/u1/job2/source.mp4",
      thumbnailKey: null,
      clips: [],
    });

    await deleteProject("job2", "u1");

    const deleted = mocks.deleteFile.mock.calls.map((c: any[]) => c[0]);
    expect(deleted).toEqual(["work/u1/job2/source.mp4"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/project.service.test.ts`

Expected: FAIL - the first test gets 4 keys, not 5, and `normalized.mp4` is absent.

- [ ] **Step 3: Implement**

In `packages/shared/src/services/project.service.ts`, inside `deleteProject`, add
`normalizedArtifactKey: true` to the `select` (after `sourceArtifactKey: true`), and
replace the `r2Keys` construction with:

```typescript
  // A Set, not an array: normalizeSource returning "none" stores the SAME key
  // in sourceArtifactKey and normalizedArtifactKey, and deleting it twice logs
  // a failure for an object that is already gone.
  const r2Keys = [
    ...new Set(
      [
        job.sourceKey,
        job.sourceArtifactKey,
        job.normalizedArtifactKey,
        job.thumbnailKey,
        ...job.clips.map((c) => c.storageKey),
      ].filter((key): key is string => Boolean(key))
    ),
  ];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/project.service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/project.service.ts packages/shared/src/services/__tests__/project.service.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "fix(projects): delete the normalized artifact when a project is deleted

deleteProject collected sourceKey, sourceArtifactKey and thumbnailKey but not
normalizedArtifactKey, so every manual deletion orphaned the biggest object in
the job. Dedupe through a Set as well: normalization returning \"none\" puts the
same key in both columns."
```

---

### Task 3: Deterministic artifact keys

`download.ts` builds `source-${randomUUID()}.mp4` and uploads it on every BullMQ attempt,
overwriting the DB column each time - so every retry orphans a full-size object no row
references. Deterministic keys make a retry overwrite its own object.

**Files:**
- Create: `apps/worker/src/stages/artifact-keys.ts`
- Modify: `apps/worker/src/stages/download.ts:1-66`
- Test: `apps/worker/src/__tests__/artifact-keys.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/artifact-keys.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { sourceArtifactKey, normalizedArtifactKey } from "../stages/artifact-keys";

describe("artifact keys", () => {
  it("is stable across retries of the same job", () => {
    expect(sourceArtifactKey("u1", "job1")).toBe("work/u1/job1/source.mp4");
    expect(sourceArtifactKey("u1", "job1")).toBe(sourceArtifactKey("u1", "job1"));
  });

  it("separates the normalized file from the raw one", () => {
    expect(normalizedArtifactKey("u1", "job1")).toBe("work/u1/job1/normalized.mp4");
    expect(normalizedArtifactKey("u1", "job1")).not.toBe(sourceArtifactKey("u1", "job1"));
  });

  it("keeps both under the job's own prefix", () => {
    for (const key of [sourceArtifactKey("u9", "j9"), normalizedArtifactKey("u9", "j9")]) {
      expect(key.startsWith("work/u9/j9/")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -w /app worker-render npx vitest run apps/worker/src/__tests__/artifact-keys.test.ts`

Expected: FAIL, "Failed to resolve import ../stages/artifact-keys".

- [ ] **Step 3: Implement**

Create `apps/worker/src/stages/artifact-keys.ts`:

```typescript
/** Artifact keys are DERIVED, never random.
 *
 *  The download stage runs again on every BullMQ retry. With a randomUUID in
 *  the key each attempt uploaded a fresh full-size object and overwrote the
 *  column, orphaning the previous one - a 2 GB leak per retry that no row
 *  pointed at, so no sweep could ever find it. Derived keys mean a retry
 *  overwrites its own object, and the whole artifact set for a job lives under
 *  one prefix.
 */
export function sourceArtifactKey(userId: string, jobId: string): string {
  return `work/${userId}/${jobId}/source.mp4`;
}

export function normalizedArtifactKey(userId: string, jobId: string): string {
  return `work/${userId}/${jobId}/normalized.mp4`;
}
```

In `apps/worker/src/stages/download.ts`, remove the now-unused `randomUUID` import
(line 7: `import { randomUUID } from "crypto";`), add:

```typescript
import {
  sourceArtifactKey as buildSourceArtifactKey,
  normalizedArtifactKey as buildNormalizedArtifactKey,
} from "./artifact-keys";
```

then replace line 40 with:

```typescript
    const sourceArtifactKey = buildSourceArtifactKey(payload.userId, payload.jobId);
```

and line 52 with:

```typescript
        normalizedArtifactKey = buildNormalizedArtifactKey(payload.userId, payload.jobId);
```

Leave everything else in the stage alone - the `action === "none"` branch that assigns
`normalizedArtifactKey = sourceArtifactKey` is deliberate and the sweep depends on it.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -w /app worker-render npx vitest run apps/worker/src/__tests__/artifact-keys.test.ts`

Expected: PASS, 3 passed.

- [ ] **Step 5: Update the test that pinned the uuid shape**

`apps/worker/src/__tests__/stage-flow.test.ts` asserts the upload key with
`expect.stringMatching(/^work\/u1\/job1\/source-/)`. That regex pins the leak itself - a
key shape that was different on every attempt. Replace it with an exact assertion on the
derived key, `"work/u1/job1/source.mp4"` (and the normalized equivalent where present).

- [ ] **Step 6: Run the worker suite to check nothing else assumed uuid keys**

Run: `docker compose exec -w /app worker-render npx vitest run apps/worker`

Baseline before this task: 39 files, 475 tests. Expected after: 40 files, 478 tests, zero
failures.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/stages/artifact-keys.ts apps/worker/src/stages/download.ts apps/worker/src/__tests__/artifact-keys.test.ts apps/worker/src/__tests__/stage-flow.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "fix(download): derive artifact keys so retries stop orphaning 2 GB objects

The stage uploads source-<uuid>.mp4 on every BullMQ attempt and overwrites the
column, so each retry left a full-size object nothing referenced and no sweep
could find. Derived keys make a retry overwrite its own object."
```

---

### Task 4: Migration - `Job.sourceSweptAt` and the sweep index

Rule B (redundant copies) needs a termination marker. Without one, a job whose
`sourceArtifactKey` equals its `normalizedArtifactKey` has nothing for Rule B to delete, so
it would match the selector on every run forever and crowd out the page.

**Files:**
- Modify: `prisma/schema.prisma` (the `Job` model)
- Create: `prisma/migrations/<timestamp>_job_source_swept_at/migration.sql` (generated)

- [ ] **Step 1: Edit the schema**

In `prisma/schema.prisma`, in `model Job`, add after `normalizedArtifactKey String?`:

```prisma
  /// Stamped by the retention sweep once a terminal job's redundant source
  /// copies have been dealt with. It is a TERMINATION MARKER, not a log: a job
  /// whose sourceArtifactKey equals its normalizedArtifactKey has nothing for
  /// that rule to delete, and without this column it would match the rule's
  /// selector on every hourly run for ever.
  sourceSweptAt         DateTime?
```

and add to the index block at the bottom of the model, next to the existing `@@index`
lines:

```prisma
  @@index([status, createdAt])
```

- [ ] **Step 2: Generate and apply the migration**

Run: `docker compose exec -w /app web npx prisma migrate dev --name job_source_swept_at`

Expected: "Your database is now in sync with your schema" and a new directory under
`prisma/migrations/`.

- [ ] **Step 3: Regenerate the client in every container that has one**

Run:
```bash
docker compose exec -w /app web npx prisma generate
docker compose exec -w /app worker-render npx prisma generate
docker compose exec -w /app bot npx prisma generate
```

Expected: "Generated Prisma Client" three times.

- [ ] **Step 4: Verify the column exists**

Run:
```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c '\d jobs' | grep -i sourceswept
```

Expected: a row naming `sourceSweptAt | timestamp(3) without time zone |`.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(db): add Job.sourceSweptAt and a (status, createdAt) index

The redundant-copy sweep rule needs a termination marker: a job whose source
and normalized keys are the same string has nothing to delete, and would
otherwise re-enter the rule's page on every hourly run for ever."
```

---

### Task 5: Sweep Rule A - expired clips

**Files:**
- Create: `packages/shared/src/services/retention.service.ts`
- Create: `packages/shared/src/services/__tests__/retention.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/services/__tests__/retention.service.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clipFindMany: vi.fn(),
  clipUpdate: vi.fn(),
  jobFindMany: vi.fn(),
  jobUpdate: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    clip: { findMany: mocks.clipFindMany, update: mocks.clipUpdate },
    job: { findMany: mocks.jobFindMany, update: mocks.jobUpdate },
  },
}));

vi.mock("../../lib/r2", () => ({ deleteFile: mocks.deleteFile }));

import { sweepExpiredClips } from "../retention.service";

const NOW = new Date("2026-07-27T12:00:00Z");

describe("sweepExpiredClips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.jobFindMany.mockResolvedValue([]);
  });

  it("selects only clips that are past expiry and not already swept", async () => {
    mocks.clipFindMany.mockResolvedValue([]);

    await sweepExpiredClips(NOW);

    expect(mocks.clipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { expiresAt: { lte: NOW }, deletedAt: null },
      })
    );
  });

  it("drops the object and soft-deletes the row, keeping storageKey", async () => {
    mocks.clipFindMany.mockResolvedValue([
      { id: "c1", storageKey: "clips/u1/job1/a.mp4" },
    ]);

    const result = await sweepExpiredClips(NOW);

    expect(mocks.deleteFile).toHaveBeenCalledWith("clips/u1/job1/a.mp4");
    expect(mocks.clipUpdate).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { deletedAt: NOW },
    });
    expect(result).toEqual({ swept: 1, failed: 0 });
  });

  it("marks a clip with an empty storageKey without calling R2", async () => {
    // editClip inserts the row with storageKey "" and an expiresAt before the
    // render that fills it in. A render that never completed leaves a row that
    // expires with no object behind it.
    mocks.clipFindMany.mockResolvedValue([{ id: "c2", storageKey: "" }]);

    const result = await sweepExpiredClips(NOW);

    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(mocks.clipUpdate).toHaveBeenCalledWith({
      where: { id: "c2" },
      data: { deletedAt: NOW },
    });
    expect(result).toEqual({ swept: 1, failed: 0 });
  });

  it("leaves deletedAt null when R2 refuses, so the next run retries", async () => {
    mocks.clipFindMany.mockResolvedValue([
      { id: "c3", storageKey: "clips/u1/job1/b.mp4" },
      { id: "c4", storageKey: "clips/u1/job1/c.mp4" },
    ]);
    mocks.deleteFile.mockRejectedValueOnce(new Error("R2 503"));

    const result = await sweepExpiredClips(NOW);

    expect(mocks.clipUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c3" } })
    );
    // One bad key must not abandon the rest of the page.
    expect(mocks.clipUpdate).toHaveBeenCalledWith({
      where: { id: "c4" },
      data: { deletedAt: NOW },
    });
    expect(result).toEqual({ swept: 1, failed: 1 });
  });

  it("writes nothing in dry-run mode", async () => {
    mocks.clipFindMany.mockResolvedValue([
      { id: "c5", storageKey: "clips/u1/job1/d.mp4" },
    ]);

    const result = await sweepExpiredClips(NOW, { dryRun: true });

    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(mocks.clipUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 1, failed: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/retention.service.test.ts`

Expected: FAIL, "Failed to resolve import ../retention.service".

- [ ] **Step 3: Implement**

Create `packages/shared/src/services/retention.service.ts`. Note that
`redundantSourceCutoff`, `sourceArtifactCutoff` and `TERMINAL_STATUSES` are imported and
declared here but first used in Tasks 6 and 7 - `noUnusedLocals` is not enabled in
`tsconfig.base.json`, so this compiles, and writing the shared preamble once is better than
editing the import block three times.

```typescript
import { prisma } from "../lib/prisma";
import { deleteFile } from "../lib/r2";
import {
  redundantSourceCutoff,
  sourceArtifactCutoff,
} from "../lib/retention";

/** How many rows one rule touches per run.
 *
 *  A page, not the whole backlog: the sweep shares the finalize worker with
 *  real jobs, and an unbounded first run against a bucket nobody has ever
 *  cleaned would hold the R2 client for as long as it takes. A backlog drains
 *  over successive hours instead, which is fine - nothing here is urgent.
 */
export const SWEEP_PAGE_SIZE = 200;

export interface SweepOptions {
  /** Log what would happen, touch neither R2 nor the database. */
  dryRun?: boolean;
}

export interface SweepCounts {
  swept: number;
  failed: number;
}

/** Terminal job states. A job that is still running owns its input, however
 *  old it is - deleting the source of a stuck job guarantees it can never
 *  resume. */
const TERMINAL_STATUSES = ["DONE", "FAILED"] as const;

/** Delete an R2 object, reporting success rather than throwing.
 *
 *  S3 DeleteObject is idempotent - deleting a key that is not there succeeds -
 *  so "already gone" and "just deleted" are the same answer, which is what the
 *  caller wants: both mean the column may be nulled.
 */
async function dropObject(key: string, dryRun: boolean): Promise<boolean> {
  if (dryRun) return true;
  try {
    await deleteFile(key);
    return true;
  } catch (error) {
    console.error(`[retention] failed to delete ${key}:`, error);
    return false;
  }
}

/**
 * Rule A: clips past their plan's retention.
 *
 * Soft delete, not a row delete: usage.service counts stored clips as
 * `deletedAt: null`, so stamping the column is what frees the user's quota,
 * and the row keeps the history that the analytics page reads. storageKey
 * stays too - it costs nothing and it is the only way to tell later which
 * object a row used to own.
 */
export async function sweepExpiredClips(
  now: Date = new Date(),
  options: SweepOptions = {}
): Promise<SweepCounts> {
  const dryRun = options.dryRun ?? false;
  const clips = await prisma.clip.findMany({
    where: { expiresAt: { lte: now }, deletedAt: null },
    select: { id: true, storageKey: true },
    take: SWEEP_PAGE_SIZE,
  });

  let swept = 0;
  let failed = 0;

  for (const clip of clips) {
    // An empty storageKey is a real case, not a defensive one: editClip
    // inserts the row with "" and an expiresAt before the render has produced
    // anything. Sending "" to S3 is a malformed request, not a no-op.
    if (clip.storageKey && !(await dropObject(clip.storageKey, dryRun))) {
      failed++;
      continue;
    }
    if (!dryRun) {
      await prisma.clip.update({
        where: { id: clip.id },
        data: { deletedAt: now },
      });
    }
    swept++;
  }

  return { swept, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/retention.service.test.ts`

Expected: PASS, 5 passed.

- [ ] **Step 5: Confirm the quota contract the soft delete depends on**

`deletedAt` is what returns a user's storage quota, and that link lives in
`usage.service`, not here. It is already asserted - run it rather than duplicating it:

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/usage.service.test.ts`

Expected: PASS, including "getUsageForUser queries clipsStored with deletedAt: null filter".
If that test is gone or changed, stop: the sweep frees no quota and Rule A is cosmetic.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/retention.service.ts packages/shared/src/services/__tests__/retention.service.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(retention): sweep clips past their plan retention

Clip.expiresAt has been written since the retention lib landed and acted on by
nothing, so 7/30/90 day retention has in fact been unlimited on every plan.
Soft delete: usage.service counts stored clips as deletedAt null, so stamping
the column is what returns the quota."
```

---

### Task 6: Sweep Rule B - redundant source copies

**Files:**
- Modify: `packages/shared/src/services/retention.service.ts`
- Modify: `packages/shared/src/services/__tests__/retention.service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/services/__tests__/retention.service.test.ts` (and add
`sweepRedundantSourceCopies` to the existing import from `../retention.service`):

```typescript
describe("sweepRedundantSourceCopies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.clipFindMany.mockResolvedValue([]);
  });

  it("only looks at terminal jobs past the grace that were never swept", async () => {
    mocks.jobFindMany.mockResolvedValue([]);

    await sweepRedundantSourceCopies(NOW);

    expect(mocks.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["DONE", "FAILED"] },
          createdAt: { lt: new Date("2026-07-26T12:00:00Z") },
          sourceSweptAt: null,
        },
      })
    );
  });

  it("drops the upload and the raw artifact, keeps the normalized one", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job1",
        sourceKey: "uploads/u1/original.mp4",
        sourceArtifactKey: "work/u1/job1/source.mp4",
        normalizedArtifactKey: "work/u1/job1/normalized.mp4",
      },
    ]);

    const result = await sweepRedundantSourceCopies(NOW);

    const deleted = mocks.deleteFile.mock.calls.map((c: any[]) => c[0]);
    expect(deleted).toEqual([
      "uploads/u1/original.mp4",
      "work/u1/job1/source.mp4",
    ]);
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: {
        sourceKey: null,
        sourceArtifactKey: null,
        sourceSweptAt: NOW,
      },
    });
    expect(result).toEqual({ swept: 1, failed: 0 });
  });

  it("NEVER deletes the source artifact when it IS the normalized one", async () => {
    // normalizeSource returning "none" stores the same key in both columns.
    // Deleting it here would destroy the only source a live job has, and null
    // a column renderTrim reads.
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job2",
        sourceKey: null,
        sourceArtifactKey: "work/u1/job2/source.mp4",
        normalizedArtifactKey: "work/u1/job2/source.mp4",
      },
    ]);

    const result = await sweepRedundantSourceCopies(NOW);

    expect(mocks.deleteFile).not.toHaveBeenCalled();
    // Still stamped: there was nothing to do, and without the stamp this row
    // re-enters the page on every run for ever.
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job2" },
      data: { sourceSweptAt: NOW },
    });
    expect(result).toEqual({ swept: 1, failed: 0 });
  });

  it("does not stamp or null anything when a delete fails", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job3",
        sourceKey: "uploads/u1/original.mp4",
        sourceArtifactKey: null,
        normalizedArtifactKey: "work/u1/job3/normalized.mp4",
      },
    ]);
    mocks.deleteFile.mockRejectedValueOnce(new Error("R2 503"));

    const result = await sweepRedundantSourceCopies(NOW);

    expect(mocks.jobUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 0, failed: 1 });
  });

  it("writes nothing in dry-run mode", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job4",
        sourceKey: "uploads/u1/original.mp4",
        sourceArtifactKey: "work/u1/job4/source.mp4",
        normalizedArtifactKey: "work/u1/job4/normalized.mp4",
      },
    ]);

    const result = await sweepRedundantSourceCopies(NOW, { dryRun: true });

    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(mocks.jobUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 1, failed: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/retention.service.test.ts`

Expected: FAIL, "sweepRedundantSourceCopies is not a function".

- [ ] **Step 3: Implement**

Append to `packages/shared/src/services/retention.service.ts`:

```typescript
/**
 * Rule B: the copies of the source that nothing reads.
 *
 * A job can hold the same video three times: Job.sourceKey (what the user
 * uploaded, read once by the download stage), Job.sourceArtifactKey (the
 * worker's own copy of those same bytes) and Job.normalizedArtifactKey (the
 * only one transcribe, render and the editor ever read). For an uploaded file
 * the first two are byte-identical. Once the job is terminal and past the
 * grace, both are dead weight - this rule drops them and keeps the normalized
 * artifact for the edit window, which is Rule C's business.
 *
 * The stamp is not bookkeeping, it is the termination condition. When
 * normalizeSource returned "none" the source artifact IS the normalized one,
 * so this rule finds nothing to delete on that job - and without the stamp the
 * job would match the selector again on every hourly run for ever, eventually
 * filling the page with rows that have no work left in them.
 */
export async function sweepRedundantSourceCopies(
  now: Date = new Date(),
  options: SweepOptions = {}
): Promise<SweepCounts> {
  const dryRun = options.dryRun ?? false;
  const jobs = await prisma.job.findMany({
    where: {
      status: { in: [...TERMINAL_STATUSES] },
      createdAt: { lt: redundantSourceCutoff(now) },
      sourceSweptAt: null,
    },
    select: {
      id: true,
      sourceKey: true,
      sourceArtifactKey: true,
      normalizedArtifactKey: true,
    },
    take: SWEEP_PAGE_SIZE,
  });

  let swept = 0;
  let failed = 0;

  for (const job of jobs) {
    const patch: {
      sourceKey?: null;
      sourceArtifactKey?: null;
      sourceSweptAt: Date;
    } = { sourceSweptAt: now };
    let ok = true;

    if (job.sourceKey) {
      if (await dropObject(job.sourceKey, dryRun)) patch.sourceKey = null;
      else ok = false;
    }

    // The guard that matters: when the two columns hold the same string, this
    // key is the live source, not a copy of it.
    if (job.sourceArtifactKey && job.sourceArtifactKey !== job.normalizedArtifactKey) {
      if (await dropObject(job.sourceArtifactKey, dryRun)) {
        patch.sourceArtifactKey = null;
      } else {
        ok = false;
      }
    }

    if (!ok) {
      // Null nothing. A column pointing at a live object is harmless; a column
      // pointing at a deleted one makes renderTrim take the clean-source
      // branch and fail on download instead of degrading to the fallback.
      failed++;
      continue;
    }

    if (!dryRun) {
      await prisma.job.update({ where: { id: job.id }, data: patch });
    }
    swept++;
  }

  return { swept, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/retention.service.test.ts`

Expected: PASS, 10 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/retention.service.ts packages/shared/src/services/__tests__/retention.service.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(retention): drop the source copies nothing reads

A job holds the same video up to three times and only the normalized artifact
is ever read. Once the job is terminal and 24h old the other two are dead
weight. Never touches the source artifact when it IS the normalized one."
```

---

### Task 7: Sweep Rule C - end of the edit window

**Files:**
- Modify: `packages/shared/src/services/retention.service.ts`
- Modify: `packages/shared/src/services/__tests__/retention.service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file (and add `sweepExpiredArtifacts` to the import):

```typescript
describe("sweepExpiredArtifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.clipFindMany.mockResolvedValue([]);
  });

  it("selects terminal jobs past the 7-day window that still hold a key", async () => {
    mocks.jobFindMany.mockResolvedValue([]);

    await sweepExpiredArtifacts(NOW);

    expect(mocks.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["DONE", "FAILED"] },
          createdAt: { lt: new Date("2026-07-20T12:00:00Z") },
          OR: [
            { sourceKey: { not: null } },
            { sourceArtifactKey: { not: null } },
            { normalizedArtifactKey: { not: null } },
          ],
        },
      })
    );
  });

  it("deletes every remaining key once and nulls all three columns", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job1",
        sourceKey: null,
        sourceArtifactKey: "work/u1/job1/source.mp4",
        normalizedArtifactKey: "work/u1/job1/source.mp4",
      },
    ]);

    const result = await sweepExpiredArtifacts(NOW);

    // Same string in both columns - one object, one delete call.
    expect(mocks.deleteFile.mock.calls.map((c: any[]) => c[0])).toEqual([
      "work/u1/job1/source.mp4",
    ]);
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: {
        sourceKey: null,
        sourceArtifactKey: null,
        normalizedArtifactKey: null,
      },
    });
    expect(result).toEqual({ swept: 1, failed: 0 });
  });

  it("leaves every column set when a delete fails, so the next run retries", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job2",
        sourceKey: null,
        sourceArtifactKey: null,
        normalizedArtifactKey: "work/u1/job2/normalized.mp4",
      },
    ]);
    mocks.deleteFile.mockRejectedValueOnce(new Error("R2 503"));

    const result = await sweepExpiredArtifacts(NOW);

    expect(mocks.jobUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 0, failed: 1 });
  });

  it("writes nothing in dry-run mode", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job3",
        sourceKey: null,
        sourceArtifactKey: null,
        normalizedArtifactKey: "work/u1/job3/normalized.mp4",
      },
    ]);

    const result = await sweepExpiredArtifacts(NOW, { dryRun: true });

    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(mocks.jobUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 1, failed: 0 });
  });
});

describe("non-terminal jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clipFindMany.mockResolvedValue([]);
    mocks.jobFindMany.mockResolvedValue([]);
  });

  it("are excluded by both artifact rules, however old they are", async () => {
    await sweepRedundantSourceCopies(NOW);
    await sweepExpiredArtifacts(NOW);

    for (const call of mocks.jobFindMany.mock.calls) {
      expect(call[0].where.status).toEqual({ in: ["DONE", "FAILED"] });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/retention.service.test.ts`

Expected: FAIL, "sweepExpiredArtifacts is not a function".

- [ ] **Step 3: Implement**

Append to `packages/shared/src/services/retention.service.ts`:

```typescript
/**
 * Rule C: the edit window is over.
 *
 * Everything the job still holds goes. Editing a clip from a job this old
 * still works - renderTrim branches on the PRESENCE of the column and falls
 * back to re-trimming the finished clip file - which is exactly why the
 * columns are nulled in the same write that deletes the objects. A column
 * pointing at a deleted object is the one state that turns a degradation into
 * a failure.
 *
 * This rule needs no stamp: it nulls every key it selects on, so a swept job
 * cannot match the selector again.
 */
export async function sweepExpiredArtifacts(
  now: Date = new Date(),
  options: SweepOptions = {}
): Promise<SweepCounts> {
  const dryRun = options.dryRun ?? false;
  const jobs = await prisma.job.findMany({
    where: {
      status: { in: [...TERMINAL_STATUSES] },
      createdAt: { lt: sourceArtifactCutoff(now) },
      OR: [
        { sourceKey: { not: null } },
        { sourceArtifactKey: { not: null } },
        { normalizedArtifactKey: { not: null } },
      ],
    },
    select: {
      id: true,
      sourceKey: true,
      sourceArtifactKey: true,
      normalizedArtifactKey: true,
    },
    take: SWEEP_PAGE_SIZE,
  });

  let swept = 0;
  let failed = 0;

  for (const job of jobs) {
    // A Set: "none" normalization puts the same key in two columns, and a
    // second DeleteObject for a key we just removed is a wasted round trip.
    const keys = [
      ...new Set(
        [
          job.sourceKey,
          job.sourceArtifactKey,
          job.normalizedArtifactKey,
        ].filter((key): key is string => Boolean(key))
      ),
    ];

    let ok = true;
    for (const key of keys) {
      if (!(await dropObject(key, dryRun))) ok = false;
    }

    if (!ok) {
      failed++;
      continue;
    }

    if (!dryRun) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          sourceKey: null,
          sourceArtifactKey: null,
          normalizedArtifactKey: null,
        },
      });
    }
    swept++;
  }

  return { swept, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/retention.service.test.ts`

Expected: PASS, 15 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/retention.service.ts packages/shared/src/services/__tests__/retention.service.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(retention): release the source artifact when the edit window ends

Seven days after a terminal job was created, everything it still holds in R2
goes and every key column is nulled in the same write. renderTrim reads the
column, not the bucket, so the nulls are what turn a missing object into a
degraded trim instead of a failed render."
```

---

### Task 8: The orchestrator and the dry-run switch

**Files:**
- Modify: `packages/shared/src/services/retention.service.ts`
- Modify: `packages/shared/src/services/index.ts`
- Modify: `packages/shared/src/services/__tests__/retention.service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file (add `runRetentionSweep` to the import):

```typescript
describe("runRetentionSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RETENTION_SWEEP_DRY_RUN;
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.clipFindMany.mockResolvedValue([{ id: "c1", storageKey: "clips/a.mp4" }]);
    mocks.jobFindMany.mockResolvedValue([]);
  });

  it("runs all three rules and reports them separately", async () => {
    const result = await runRetentionSweep(NOW);

    expect(result).toEqual({
      clips: { swept: 1, failed: 0 },
      redundantSources: { swept: 0, failed: 0 },
      expiredArtifacts: { swept: 0, failed: 0 },
      dryRun: false,
    });
    expect(mocks.clipUpdate).toHaveBeenCalled();
  });

  it("touches nothing when RETENTION_SWEEP_DRY_RUN is set", async () => {
    process.env.RETENTION_SWEEP_DRY_RUN = "1";

    const result = await runRetentionSweep(NOW);

    expect(result.dryRun).toBe(true);
    expect(result.clips).toEqual({ swept: 1, failed: 0 });
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(mocks.clipUpdate).not.toHaveBeenCalled();
    expect(mocks.jobUpdate).not.toHaveBeenCalled();
  });

  it("treats an empty or absent flag as a live run", async () => {
    process.env.RETENTION_SWEEP_DRY_RUN = "";

    const result = await runRetentionSweep(NOW);

    expect(result.dryRun).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/retention.service.test.ts`

Expected: FAIL, "runRetentionSweep is not a function".

- [ ] **Step 3: Implement**

Append to `packages/shared/src/services/retention.service.ts`:

```typescript
export interface RetentionSweepResult {
  clips: SweepCounts;
  redundantSources: SweepCounts;
  expiredArtifacts: SweepCounts;
  dryRun: boolean;
}

/**
 * One pass of every rule, in cheapest-first order.
 *
 * RETENTION_SWEEP_DRY_RUN exists for exactly one moment: the first run against
 * a bucket that has never been cleaned, where every rule has a full backlog
 * and the counts are the only warning we get before the deletes are real.
 * It is read per run, not cached, so flipping it does not need a redeploy.
 */
export async function runRetentionSweep(
  now: Date = new Date()
): Promise<RetentionSweepResult> {
  const dryRun = Boolean(process.env.RETENTION_SWEEP_DRY_RUN);
  const options: SweepOptions = { dryRun };

  const clips = await sweepExpiredClips(now, options);
  const redundantSources = await sweepRedundantSourceCopies(now, options);
  const expiredArtifacts = await sweepExpiredArtifacts(now, options);

  const prefix = dryRun ? "[retention][dry-run]" : "[retention]";
  console.log(
    `${prefix} clips ${clips.swept}/${clips.failed} failed, ` +
      `redundant sources ${redundantSources.swept}/${redundantSources.failed} failed, ` +
      `expired artifacts ${expiredArtifacts.swept}/${expiredArtifacts.failed} failed`
  );

  return { clips, redundantSources, expiredArtifacts, dryRun };
}
```

In `packages/shared/src/services/index.ts`, add next to the other service exports:

```typescript
export * as retentionService from "./retention.service";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/retention.service.test.ts`

Expected: PASS, 18 passed.

- [ ] **Step 5: Rebuild the shared dist the worker runs**

Run: `docker compose exec -w /app web npm run build -w @clipclap/shared`

Expected: build completes with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/retention.service.ts packages/shared/src/services/index.ts packages/shared/src/services/__tests__/retention.service.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(retention): one pass over all three rules, with a dry-run switch

RETENTION_SWEEP_DRY_RUN reports the counts and writes nothing, which is the
only warning available before the first run against a bucket that has never
been swept."
```

---

### Task 9: Schedule the sweep

The sweep joins the existing hourly maintenance queue. It is not referral work, but the
queue is the project's one maintenance lane and the alternative - a second queue, a second
Worker, a second shutdown path - buys nothing.

**Files:**
- Modify: `packages/shared/src/lib/referral-queue.ts`
- Modify: `packages/shared/src/lib/index.ts:13-21`
- Modify: `apps/worker/src/referral-scheduler.ts`
- Test: `packages/shared/src/lib/__tests__/referral-queue.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/lib/__tests__/referral-queue.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  getRepeatableJobs: vi.fn(),
  removeRepeatableByKey: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = mocks.add;
    getRepeatableJobs = mocks.getRepeatableJobs;
    removeRepeatableByKey = mocks.removeRepeatableByKey;
  },
}));

vi.mock("../redis", () => ({ getRedis: () => ({}) }));

import { registerReferralSchedules, RETENTION_SWEEP_JOB } from "../referral-queue";

describe("registerReferralSchedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRepeatableJobs.mockResolvedValue([]);
  });

  it("registers the retention sweep hourly, keyed so re-registration is a no-op", async () => {
    await registerReferralSchedules();

    expect(mocks.add).toHaveBeenCalledWith(
      RETENTION_SWEEP_JOB,
      {},
      { repeat: { pattern: "0 * * * *" }, jobId: RETENTION_SWEEP_JOB }
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/lib/__tests__/referral-queue.test.ts`

Expected: FAIL - `RETENTION_SWEEP_JOB` is not exported.

- [ ] **Step 3: Implement**

In `packages/shared/src/lib/referral-queue.ts`, add after line 6:

```typescript
/** Storage retention sweep. It shares this queue because it is the same kind
 *  of work - hourly, idempotent, nobody is waiting for it - and a second queue
 *  would mean a second Worker and a second shutdown path for no gain. */
export const RETENTION_SWEEP_JOB = "retention-sweep";
```

and add inside `registerReferralSchedules`, after the existing two `queue.add` calls:

```typescript
  await queue.add(RETENTION_SWEEP_JOB, {}, { repeat: { pattern: "0 * * * *" }, jobId: RETENTION_SWEEP_JOB });
```

In `packages/shared/src/lib/index.ts`, add `RETENTION_SWEEP_JOB` to the existing export
block that ends at line 21 with `} from "./referral-queue";`.

In `apps/worker/src/referral-scheduler.ts`, add `RETENTION_SWEEP_JOB` and
`runRetentionSweep` to the `@clipclap/shared` import, and add this branch inside the
worker callback after the `SUBSCRIPTION_RECONCILE_JOB` branch:

```typescript
      if (job.name === RETENTION_SWEEP_JOB) {
        await runRetentionSweep(now);
        return;
      }
```

(`runRetentionSweep` logs its own counts, so there is nothing to add here.)

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/lib/__tests__/referral-queue.test.ts`

Expected: PASS, 1 passed.

- [ ] **Step 5: Arm the dry run BEFORE the schedule exists**

This step is not optional and not reorderable. The moment `worker-finalize` restarts with
the schedule registered, the sweep runs at the top of every hour against a production
bucket - and the dry run that is supposed to precede the first real deletion does not
happen until Task 14. Set the flag first:

```bash
grep -q '^RETENTION_SWEEP_DRY_RUN=' .env || echo 'RETENTION_SWEEP_DRY_RUN=1' >> .env
grep -n 'RETENTION_SWEEP_DRY_RUN' .env
```

Expected: exactly one line, `RETENTION_SWEEP_DRY_RUN=1`. If the value is empty, set it to
`1` - an empty value is a LIVE run.

- [ ] **Step 6: Rebuild shared and restart the scheduler worker**

Run:
```bash
docker compose exec -w /app web npm run build -w @clipclap/shared
docker compose up -d worker-finalize
docker compose logs --tail 30 worker-finalize
```

(`up -d`, not `restart`: the container must pick up the new `.env` value, which `restart`
does not re-read.)

Expected: the worker boots with `role=finalize` and no errors. (Only the `finalize` role
registers schedules - see `apps/worker/src/index.ts:12`.)

- [ ] **Step 7: Confirm the first scheduled pass is inert**

At the next top of the hour, or immediately via the forced-pass command in
`docs/runbooks/retention-sweep.md`, the log line MUST carry the `[dry-run]` marker:

Run: `docker compose logs --tail 50 worker-finalize | grep retention`

Expected: a line beginning `[retention][dry-run]`. A line without `[dry-run]` means the
flag did not reach the container - stop and fix that before doing anything else.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/lib/referral-queue.ts packages/shared/src/lib/index.ts packages/shared/src/lib/__tests__/referral-queue.test.ts apps/worker/src/referral-scheduler.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(retention): run the sweep hourly on the maintenance queue

Same lane as the hold release and the subscription reconcile: hourly,
idempotent, keyed on jobId so registering it on every worker boot is a no-op."
```

---

### Task 10: `getDownloadUrl` refuses a swept clip

Today it signs a URL for whatever `storageKey` says, so the first user to open an expired
clip gets an R2 404 inside a `<video>` tag with no explanation.

**Files:**
- Modify: `packages/shared/src/services/clip.service.ts:35-55`
- Modify: `apps/web/app/api/clips/[id]/download/route.ts`
- Test: `packages/shared/src/services/__tests__/clip.service.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/shared/src/services/__tests__/clip.service.test.ts`, add
`clipFindFirst: vi.fn()` to the hoisted `mocks`, add `findFirst: mocks.clipFindFirst` to
the mocked `prisma.clip`, add a `getPresignedDownloadUrl` mock:

```typescript
vi.mock("../../lib/r2", () => ({
  getPresignedDownloadUrl: mocks.getPresignedDownloadUrl,
  deleteFile: mocks.deleteFile,
}));
```

(with `getPresignedDownloadUrl: vi.fn()` and `deleteFile: vi.fn()` added to `mocks`), then
append:

```typescript
import { ClipExpiredError, getDownloadUrl } from "../clip.service";

describe("clip.service - getDownloadUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPresignedDownloadUrl.mockResolvedValue("https://r2.example/signed");
  });

  it("signs a URL for a live clip", async () => {
    mocks.clipFindFirst.mockResolvedValue({
      id: "c1",
      storageKey: "clips/u1/job1/a.mp4",
      deletedAt: null,
    });

    await expect(getDownloadUrl("c1", "u1")).resolves.toBe(
      "https://r2.example/signed"
    );
  });

  it("refuses a swept clip instead of signing a URL to a deleted object", async () => {
    mocks.clipFindFirst.mockResolvedValue({
      id: "c2",
      storageKey: "clips/u1/job1/b.mp4",
      deletedAt: new Date("2026-07-20T00:00:00Z"),
    });

    await expect(getDownloadUrl("c2", "u1")).rejects.toBeInstanceOf(
      ClipExpiredError
    );
    expect(mocks.getPresignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("still 404s a clip that belongs to somebody else", async () => {
    mocks.clipFindFirst.mockResolvedValue(null);

    await expect(getDownloadUrl("c3", "u1")).rejects.not.toBeInstanceOf(
      ClipExpiredError
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/clip.service.test.ts`

Expected: FAIL, "No export named ClipExpiredError".

- [ ] **Step 3: Implement**

In `packages/shared/src/services/clip.service.ts`, add above `getDownloadUrl`:

```typescript
/** The clip existed and its retention period ended. Distinct from "not found"
 *  because the answers differ: one is a 404, the other is a 410 with copy that
 *  tells the user what happened to their clip. */
export class ClipExpiredError extends Error {
  constructor(clipId: string) {
    super(`Clip ${clipId} is past its retention period`);
    this.name = "ClipExpiredError";
  }
}
```

and replace the body of `getDownloadUrl` with:

```typescript
export async function getDownloadUrl(
  clipId: string,
  userId: string
): Promise<string> {
  const clip = await prisma.clip.findFirst({
    where: { id: clipId, userId },
  });
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  // The bytes are gone; a signed URL here is a 404 from R2 inside a <video>
  // tag, which reads to the user as a broken product rather than an expiry.
  if (clip.deletedAt) throw new ClipExpiredError(clipId);
  return getPresignedDownloadUrl(clip.storageKey);
}
```

In `apps/web/app/api/clips/[id]/download/route.ts`, replace lines 14-16 with:

```typescript
  const { id } = await params;
  try {
    const url = await clipService.getDownloadUrl(id, session.user.id);
    return NextResponse.json({ url });
  } catch (error) {
    if (error instanceof clipService.ClipExpiredError) {
      return NextResponse.json({ error: "CLIP_EXPIRED" }, { status: 410 });
    }
    throw error;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/clip.service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/clip.service.ts apps/web/app/api/clips/\[id\]/download/route.ts packages/shared/src/services/__tests__/clip.service.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(clips): refuse a download for a clip past its retention

getDownloadUrl signed a URL for whatever storageKey said, so the first expired
clip a user opened was an R2 404 inside a video tag. 410 CLIP_EXPIRED instead,
kept distinct from the 404 a clip that is not yours gets."
```

---

### Task 11: The project DTOs carry `expired`

**Files:**
- Modify: `packages/shared/src/services/project.service.ts:13-21, 69-99, 158-175, 213-241`
- Test: `packages/shared/src/services/__tests__/project.service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/services/__tests__/project.service.test.ts`. The file's
existing `beforeEach` already makes `getPresignedDownloadUrl` return `signed:<key>`, which
is what the assertions below rely on:

```typescript
describe("project DTOs - expired clips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPresignedDownloadUrl.mockImplementation(
      async (key: string) => `signed:${key}`
    );
  });

  it("marks a swept clip expired and gives it no preview URL", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job1",
        userId: "u1",
        originalFilename: "stream.mp4",
        sourceUrl: null,
        sourceKey: null,
        status: "DONE",
        error: null,
        sourceDurationSec: 3600,
        createdAt: new Date("2026-07-01T00:00:00Z"),
        clipsGenerated: 2,
        noClipsReason: null,
        transcriptPartial: false,
        clips: [
          {
            id: "live",
            title: "Live clip",
            storageKey: "clips/u1/job1/live.mp4",
            duration: 30,
            startTime: 0,
            endTime: 30,
            subtitles: true,
            parentClipId: null,
            createdAt: new Date("2026-07-01T00:00:00Z"),
            description: null,
            lowQuality: false,
            deletedAt: null,
          },
          {
            id: "gone",
            title: "Swept clip",
            storageKey: "clips/u1/job1/gone.mp4",
            duration: 30,
            startTime: 30,
            endTime: 60,
            subtitles: true,
            parentClipId: null,
            createdAt: new Date("2026-07-01T00:00:00Z"),
            description: null,
            lowQuality: false,
            deletedAt: new Date("2026-07-20T00:00:00Z"),
          },
        ],
      },
    ]);

    const detail = await getProjectDetail("job1", "u1");

    expect(detail!.clips[0]).toMatchObject({
      id: "live",
      expired: false,
      previewUrl: "signed:clips/u1/job1/live.mp4",
    });
    expect(detail!.clips[1]).toMatchObject({
      id: "gone",
      expired: true,
      previewUrl: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/project.service.test.ts`

Expected: FAIL - `expired` is undefined and the swept clip has a signed `previewUrl`.

- [ ] **Step 3: Implement**

In `packages/shared/src/services/project.service.ts`:

Add to `ProjectDetailClip` (after `lowQuality: boolean;`):

```typescript
  /** The retention sweep dropped the object. The row is kept on purpose - a
   *  clip that silently vanishes reads as data loss, an expired one does not. */
  expired: boolean;
```

Add `deletedAt: true,` to the `select` in both `PROJECT_INCLUDE` and
`PROJECT_DETAIL_INCLUDE`.

In `getProjectDetail`, replace the clip mapping's `previewUrl` line and add the flag:

```typescript
        previewUrl:
          clip.storageKey && !clip.deletedAt
            ? await getPresignedDownloadUrl(clip.storageKey)
            : null,
        expired: Boolean(clip.deletedAt),
```

In `toProjectSummaries`, change the preview clip finder so a swept clip is never chosen as
a project's poster frame:

```typescript
  const previewClip = job.clips.find(
    (clip) => clip.storageKey.length > 0 && !clip.deletedAt
  );
```

and add `deletedAt: Date | null;` to the inline `clips` array types at lines ~190 and ~213
so the new field type-checks.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/project.service.test.ts`

Expected: PASS.

- [ ] **Step 5: Type-check the web app**

Run: `docker compose exec -w /app/apps/web web npx tsc --noEmit`

Expected: no errors. (If `project-detail.tsx` complains about the new required field,
that is Task 12's job - finish this task's commit first only if tsc is clean; otherwise do
Task 12 and commit them together.)

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/project.service.ts packages/shared/src/services/__tests__/project.service.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(projects): expose expired clips instead of signing dead URLs

A swept clip keeps its row, so the project DTOs now say so: no preview URL,
expired true, and never chosen as the project's poster frame."
```

---

### Task 12: The clip card renders an expired clip

**Files:**
- Modify: `apps/web/components/clip-card.tsx:14-73, 100-206`

- [ ] **Step 1: Add the flag to the props**

In `ClipCardClip`, add after `lowQuality?: boolean;`:

```typescript
  expired?: boolean;
```

- [ ] **Step 2: Stop the preview fetch for an expired clip**

Replace the `useEffect` body's opening (lines 45-53) with:

```typescript
  useEffect(() => {
    if (clip.expired) {
      setPreviewUrl(null);
      setPreviewLoading(false);
      return;
    }

    const readyUrl = initialPreviewUrl ?? getCachedClipUrl(clip.id);
    if (readyUrl) {
      rememberClipUrl(clip.id, readyUrl);
      setPreviewUrl(readyUrl);
      setPreviewLoading(false);
      return;
    }
```

and add `clip.expired` to the dependency array on line 73:

```typescript
  }, [clip.id, initialPreviewUrl, clip.expired]);
```

Also make the initial state honour it, replacing lines 35-41:

```typescript
  const initialPreviewUrl = clip.expired
    ? null
    : previewUrlProp ?? clip.previewUrl ?? null;
  const [previewUrl, setPreviewUrl] = useState<string | null>(() =>
    clip.expired ? null : initialPreviewUrl ?? getCachedClipUrl(clip.id)
  );
  const [previewLoading, setPreviewLoading] = useState(
    () => !clip.expired && !initialPreviewUrl && !getCachedClipUrl(clip.id)
  );
```

- [ ] **Step 3: Render the expired state**

Replace the empty-preview fallback (lines 116-120) with:

```typescript
        ) : clip.expired ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
            <FilmStrip className="h-6 w-6" />
            <span className="text-xs">Storage period ended</span>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <FilmStrip className="h-6 w-6" />
          </div>
        )}
```

and disable the two actions that need the bytes - on the Download button add
`disabled={downloading || clip.expired}`, and replace the Edit button with:

```typescript
          <Button
            variant="outline"
            size="sm"
            asChild={!clip.expired}
            disabled={clip.expired}
            className="h-8 px-2"
            title={clip.expired ? "Storage period ended" : "Edit"}
          >
            {clip.expired ? (
              <span className="flex items-center gap-1">
                <PencilSimple className="h-3.5 w-3.5" />
                <span className="text-xs">Edit</span>
              </span>
            ) : (
              <Link href={`/dashboard/editor?clip=${clip.id}`} aria-label={`Edit ${clip.title}`}>
                <PencilSimple className="h-3.5 w-3.5" />
                <span className="text-xs">Edit</span>
              </Link>
            )}
          </Button>
```

Delete stays enabled: removing the row of a clip you no longer have is a reasonable thing
to want.

- [ ] **Step 4: Type-check and eyeball it**

Run: `docker compose exec -w /app/apps/web web npx tsc --noEmit`

Expected: no errors.

Then open `http://localhost:8090/dashboard` (or the prod URL for this host) and confirm a
normal project still renders its clips with working previews. There is no expired clip in
prod yet, so the expired branch is verified by the type-checker and by Task 14's dry run.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/clip-card.tsx
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(web): show an expired clip instead of a broken player

An expired card skips the preview fetch entirely, says \"Storage period ended\"
and disables download and edit. Delete stays: removing the row of a clip you
no longer have is reasonable."
```

---

### Task 13: Defensive `deletedAt` filter on Telegram delivery

Delivery happens minutes after render and the shortest retention is 3 days, so this can
only bite in a pathological backlog - where the failure is the bot sending a signed URL to
an object that is gone.

**Files:**
- Modify: `packages/shared/src/services/telegram-delivery.service.ts:73-84`
- Test: `packages/shared/src/services/__tests__/telegram-delivery.service.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the existing top-level `describe("telegram-delivery.service", ...)` block in
`packages/shared/src/services/__tests__/telegram-delivery.service.test.ts`, which already
has `mocks.telegramDeliveryFindMany` and a `vi.clearAllMocks()` in its `beforeEach`:

```typescript
  it("never hands the poller a clip the retention sweep already dropped", async () => {
    mocks.telegramDeliveryFindMany.mockResolvedValue([]);

    await getPendingTelegramDeliveries();

    const args = mocks.telegramDeliveryFindMany.mock.calls[0][0];
    expect(args.include.job.include.clips.where).toEqual({ deletedAt: null });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/telegram-delivery.service.test.ts`

Expected: FAIL - `clips.where` is undefined.

- [ ] **Step 3: Implement**

In `getPendingTelegramDeliveries`, add a `where` to the `clips` include:

```typescript
          clips: {
            // Defensive: a delivery normally runs minutes after render and the
            // shortest retention is 3 days. In a backlog long enough to cross
            // that, the alternative is the bot sending a signed URL for an
            // object the sweep already dropped.
            where: { deletedAt: null },
            orderBy: [
              { score: { sort: "desc", nulls: "last" } },
              { startTime: "asc" },
            ],
          },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/telegram-delivery.service.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the bot suite - delivery logic lives there**

Run: `docker compose exec -w /app/apps/bot bot npx vitest run --root ../.. apps/bot/src/__tests__/delivery.test.ts`

Expected: PASS, unchanged count. (The bot MUST be tested in the `bot` container - the
`web` container carries a stale copy of `apps/bot` that passes without running the real
code.)

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/telegram-delivery.service.ts packages/shared/src/services/__tests__/telegram-delivery.service.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "fix(telegram): never deliver a clip the sweep already dropped"
```

---

### Task 14: Wire up the environment, the runbook, and the first dry run

**Files:**
- Modify: `.env.example`
- Modify: `.env` (this host - not in git)
- Create: `docs/runbooks/retention-sweep.md`

The flag itself was already set in this host's `.env` back in Task 9, Step 5 - it had to
be, because Task 9 is where the hourly schedule starts firing. This task documents it and
performs the cross-check that lets it come off.

- [ ] **Step 1: Document the flag in `.env.example`**

Append:

```bash
# Set to any non-empty value to make the hourly retention sweep report what it
# would delete and touch neither R2 nor the database. Intended for the first
# run against a bucket that has never been swept; unset it once the counts in
# the worker-finalize log look right.
RETENTION_SWEEP_DRY_RUN=
```

- [ ] **Step 2: Write the runbook**

Create `docs/runbooks/retention-sweep.md`:

```markdown
# Retention sweep - first production run

The sweep deletes R2 objects. Its first run faces a bucket that has never been
cleaned, so read the numbers before they are real.

## 1. Dry run

    echo 'RETENTION_SWEEP_DRY_RUN=1' >> .env
    docker compose up -d worker-finalize
    docker compose logs -f worker-finalize | grep retention

Wait for the top of the hour, or force one pass immediately:

    docker compose exec -w /app worker-finalize node -e \
      "require('/app/packages/shared/dist/index.js').retentionService.runRetentionSweep().then(r=>console.log(r))"

Expect a line like:

    [retention][dry-run] clips 5/0 failed, redundant sources 9/0 failed, expired artifacts 9/0 failed

## 2. Sanity-check the counts against the database

    docker compose exec -T postgres psql -U clipclap -d clipclap \
      -c 'select count(*) from clips where "expiresAt" <= now() and "deletedAt" is null;' \
      -c 'select count(*) from jobs where status in (\'DONE\',\'FAILED\') and "sourceSweptAt" is null;'

The clip count must match the dry run's first number. If it does not, stop -
the selector and the report disagree.

## 3. Go live

Remove `RETENTION_SWEEP_DRY_RUN` from `.env`, then:

    docker compose up -d worker-finalize

Watch the next hourly line. `failed` should be 0. A non-zero `failed` is not an
emergency: the columns were left set on purpose and the next run retries the
same rows.

## What to check a day later

    docker compose exec -T postgres psql -U clipclap -d clipclap \
      -c 'select count(*) from jobs where "sourceArtifactKey" is not null;' \
      -c 'select count(*) from clips where "deletedAt" is not null;'

Artifacts on jobs older than 7 days should be zero. If the number is stuck and
`failed` is non-zero every hour, an R2 credential or a bucket policy is the
likely cause, not the sweep.
```

- [ ] **Step 3: Run the whole suite before touching prod**

Run:
```bash
docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared
docker compose exec -w /app worker-render npx vitest run apps/worker
docker compose exec -w /app/apps/bot bot npx vitest run --root ../.. apps/bot
```

Expected: all three green. Record the actual pass counts in the commit message rather than
claiming "all tests pass".

- [ ] **Step 4: Do the dry run**

Follow `docs/runbooks/retention-sweep.md` section 1 and 2 on this host. Paste the actual
log line and the psql counts into the task notes. Do NOT proceed to section 3 without
showing the user those numbers first - this is the point of no return for 5 expired clips
and the artifacts of 9 jobs.

- [ ] **Step 5: Commit**

```bash
git add .env.example docs/runbooks/retention-sweep.md
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "docs(retention): runbook for the first sweep, and the dry-run flag

The first run faces a bucket nobody has ever cleaned. The runbook makes the
dry run and the count cross-check mandatory before the deletes are real."
```

---

## Verification checklist

Before calling this done, each of these must have been RUN, with the output read:

- [ ] `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared` - green
- [ ] `docker compose exec -w /app worker-render npx vitest run apps/worker` - green
- [ ] `docker compose exec -w /app/apps/bot bot npx vitest run --root ../.. apps/bot` - green
- [ ] `docker compose exec -w /app/apps/web web npx tsc --noEmit` - clean
- [ ] `docker compose exec -w /app web npm run build -w @clipclap/shared` - clean
- [ ] Dry run performed, counts cross-checked against psql, numbers shown to the user
- [ ] A real job submitted end to end after the change, clips delivered in the bot, and
      `work/<user>/<job>/source.mp4` present in R2 with the derived name
- [ ] Any `@test.com` / `@test.local` user rows created during testing deleted afterwards
