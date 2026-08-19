# Submission Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second submission while one job is running is accepted and queued instead of refused, and starts by itself when a slot frees up.

**Architecture:** `Job.enqueuedAt` (NULL = created and charged but waiting) is the whole queue - no new table. `createJob` keeps its per-user advisory-lock transaction; at the limit it creates the row without enqueueing and answers `queued`+position. Slots free on finalize completion and on any stage's TERMINAL BullMQ failure (worker event hooks), plus an hourly stall guard that presumes a 3h-silent active job dead. Flag `SUBMISSION_QUEUE=on` gates only whether new submissions queue instead of refuse; the release path always runs, so rollback drains rather than strands.

**Tech Stack:** Prisma/Postgres (advisory lock already in place), BullMQ, grammY bot, Next.js route.

**Spec:** `docs/superpowers/specs/2026-08-18-submission-queue-design.md` (decisions §5: no queue cap, release on FAILED, 3h stall guard, web 202).

**Ground rules for every task (from this repo's memory):**
- Tests run INSIDE containers: `docker compose exec -T bot sh -c 'cd /app && /app/node_modules/.bin/vitest run <paths>'` (bot tests MUST run in the `bot` container). Typecheck: `docker compose exec -T bot sh -c 'cd /app/apps/bot && /app/node_modules/.bin/tsc --noEmit -p tsconfig.json'` (ignore pre-existing TS6059 rootDir errors), same pattern with `packages/shared` and `worker-render`/`apps/worker`.
- After editing `packages/shared`, rebuild dist before running dependent suites: `docker compose exec -T bot sh -c 'cd /app && npm run build -w @clipclap/shared'`.
- NEVER run `docker compose up/restart/down`, never edit `.env`, never write to the DB or R2, never run `prisma migrate`. The orchestrator does deploys.
- Commit identity: `git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit` - NO Co-Authored-By trailer. Plain hyphens in all text, never em-dashes.
- Plain `hyphens` everywhere in copy and comments.
- Mutation-test every new test that guards a mechanism: apply the named mutation, confirm the test goes RED, revert. A test that stays green under the mutation is a plan failure - fix the test.

---

### Task 1: Schema - `Job.enqueuedAt` + backfill migration

**Files:**
- Modify: `prisma/schema.prisma` (model Job, ~line 413 and the `@@index` block ~line 482)
- Create: `prisma/migrations/20260819080000_job_enqueued_at/migration.sql`

No generated-client code may reference the column yet (generate happens at deploy), so this task is schema + SQL only.

- [ ] **Step 1: Add the column and index to the schema**

In `prisma/schema.prisma`, inside `model Job`, directly after the `sourceFingerprint` field block, add:

```prisma
  /// When this job was handed to BullMQ. NULL = created and charged but
  /// WAITING for a concurrency slot (the submission queue, spec 2026-08-18).
  /// Backfilled to createdAt for every job that predates the column - they
  /// were all enqueued at creation. The release path (job.service
  /// releaseNextQueued) is what stamps it for queued jobs.
  enqueuedAt                    DateTime?
```

In the same model's index block (after `@@index([status, createdAt])`), add:

```prisma
  @@index([userId, enqueuedAt, createdAt])
```

- [ ] **Step 2: Write the migration with the backfill**

Create `prisma/migrations/20260819080000_job_enqueued_at/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "enqueuedAt" TIMESTAMP(3);

-- Every job that predates the queue was enqueued the moment it was created.
-- Without this backfill the release path would read every historical PENDING
-- row as "waiting for a slot" and re-enqueue it.
UPDATE "jobs" SET "enqueuedAt" = "createdAt";

-- CreateIndex
CREATE INDEX "jobs_userId_enqueuedAt_createdAt_idx" ON "jobs"("userId", "enqueuedAt", "createdAt");
```

- [ ] **Step 3: Validate the schema parses**

Run: `docker compose exec -T bot sh -c 'cd /app && npx prisma validate --schema=prisma/schema.prisma'`
Expected: `The schema at prisma/schema.prisma is valid`

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260819080000_job_enqueued_at
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(queue): Job.enqueuedAt - NULL means created but waiting for a slot

Backfilled to createdAt: every historical job was enqueued at creation.
Index (userId, enqueuedAt, createdAt) serves both the release scan (oldest
NULL first) and the in-flight count. Column only - the mechanics land next."
```

> **Orchestrator checkpoint (not the subagent):** apply the migration and regenerate clients BEFORE Task 2 starts, or Task 2 cannot typecheck:
> `docker compose exec -T -w /app worker-render npx prisma migrate deploy`
> then per container `bot web worker-download worker-transcribe worker-analyze worker-render worker-finalize`: `docker compose exec -T -w /app <svc> npx prisma generate`.

---

### Task 2: Queue mechanics in `job.service` + funnel event

**Files:**
- Modify: `packages/shared/src/services/job.service.ts`
- Modify: `packages/shared/src/services/funnel.service.ts` (FUNNEL_EVENTS)
- Modify: `packages/shared/src/services/index.ts` (type export)
- Test: `packages/shared/src/services/__tests__/job.service.test.ts` (extend; follow the existing `tx` mock scaffolding at the top of that file)

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/services/__tests__/job.service.test.ts`. The file already defines `const tx = {...}` with `job.create/count`, `freeUsage.create`, `user.findUniqueOrThrow`, the `$transaction` mock, `queueAdd`, and `const jobFindMany` on the top-level prisma mock. You will need to EXTEND the mocks:

1. Add to the hoisted section (next to `jobFindMany`):

```ts
const jobUpdate = vi.fn();
const jobGroupBy = vi.fn();
const freeUsageFindFirst = vi.fn();
```

2. Extend the top-level prisma mock's `job` object to
`{ findMany: (...args: unknown[]) => jobFindMany(...args), update: (...a: unknown[]) => jobUpdate(...a), groupBy: (...a: unknown[]) => jobGroupBy(...a) }`
and add `freeUsage: { findFirst: (...a: unknown[]) => freeUsageFindFirst(...a) }`.
ALSO add `update: vi.fn()` and `findMany: vi.fn()` to the `tx.job` object (releaseNextQueued runs inside the transaction mock).

3. Append the test suites:

```ts
describe("createJob under the submission queue", () => {
  beforeEach(() => {
    calls.length = 0;
    inner.length = 0;
    tx.job.create.mockReset();
    tx.job.create.mockResolvedValue({ id: "j1", userId: "u1", createdAt: new Date() });
    tx.job.count.mockReset();
    tx.job.count.mockImplementation(async () => {
      inner.push("count");
      return 0;
    });
    tx.user.findUniqueOrThrow.mockResolvedValue({ plan: "NONE", billingCycle: null });
    tx.freeUsage.create.mockReset();
    queueAdd.mockClear();
    delete process.env.SUBMISSION_QUEUE;
  });

  afterEach(() => {
    delete process.env.SUBMISSION_QUEUE;
  });

  // The in-flight count must not see rows that are WAITING - else one queued
  // job would block the next release forever. Mutation: drop the enqueuedAt
  // filter from the count -> this test goes red.
  it("counts only ENQUEUED active jobs as in flight", async () => {
    await createJob({ userId: "u1", sourceKey: "k" });
    const where = tx.job.count.mock.calls[0][0].where;
    expect(where.enqueuedAt).toEqual({ not: null });
    expect(where.status).toEqual({ in: [...ACTIVE_JOB_STATUSES] });
  });

  it("stamps enqueuedAt on an immediately-started job and dedupes the BullMQ add", async () => {
    await createJob({ userId: "u1", sourceKey: "k" });
    expect(tx.job.create.mock.calls[0][0].data.enqueuedAt).toBeInstanceOf(Date);
    expect(queueAdd).toHaveBeenCalledTimes(1);
    // Deterministic BullMQ id, so a double release can never enqueue twice.
    expect(queueAdd.mock.calls[0][2]).toMatchObject({ jobId: "dl:j1" });
  });

  // Flag off = today's behaviour, byte for byte.
  it("refuses as concurrent_limit at the cap when the flag is off", async () => {
    tx.job.count.mockResolvedValueOnce(1);
    const result = await createJob({ userId: "u1", sourceKey: "k" });
    expect(result).toEqual({ status: "concurrent_limit", inFlight: 1, limit: 1 });
    expect(tx.job.create).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("queues at the cap when the flag is on: row without enqueuedAt, charge kept, NO BullMQ add", async () => {
    process.env.SUBMISSION_QUEUE = "on";
    // First count: in-flight (at cap). Second count: queued rows for position.
    tx.job.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const result = await createJob({
      userId: "u1",
      sourceKey: "k",
      freeCharge: { seconds: 60, estimatedCostUsd: 0.01 },
    });
    expect(result).toMatchObject({ status: "queued", position: 2 });
    expect(tx.job.create.mock.calls[0][0].data.enqueuedAt).toBeNull();
    // The reservation is written exactly as for a started job.
    expect(tx.freeUsage.create).toHaveBeenCalledTimes(1);
    expect(queueAdd).not.toHaveBeenCalled();
    // Position counts THIS user's waiting rows, oldest semantics belong to
    // release; here only the shape matters. Mutation: drop the enqueuedAt:null
    // term -> red.
    const posWhere = tx.job.count.mock.calls[1][0].where;
    expect(posWhere).toEqual({ userId: "u1", status: "PENDING", enqueuedAt: null });
  });
});

describe("releaseNextQueued", () => {
  beforeEach(() => {
    calls.length = 0;
    inner.length = 0;
    tx.job.count.mockReset();
    tx.job.count.mockImplementation(async () => {
      inner.push("count");
      return 0;
    });
    tx.job.findMany = vi.fn(async () => []);
    tx.job.update = vi.fn(async () => ({}));
    tx.user.findUniqueOrThrow.mockResolvedValue({ plan: "NONE", billingCycle: null });
    freeUsageFindFirst.mockReset();
    freeUsageFindFirst.mockResolvedValue(null);
    queueAdd.mockClear();
  });

  it("takes the SAME per-user lock before counting - lock, then count", async () => {
    await releaseNextQueued("u1");
    expect(inner[0]).toMatch(/^set:/);
    expect(inner[1]).toBe("lock");
    expect(inner[2]).toBe("count");
  });

  it("releases the oldest waiting job into the free slot and stamps enqueuedAt", async () => {
    tx.job.count.mockResolvedValueOnce(0); // 0 active, limit 1 -> 1 slot
    tx.job.findMany = vi.fn(async () => [
      { id: "q1", userId: "u1", createdAt: new Date(1) },
    ]);
    const released = await releaseNextQueued("u1");
    expect(released.map((j) => j.id)).toEqual(["q1"]);
    // Oldest first. Mutation: orderBy desc -> red.
    expect((tx.job.findMany as any).mock.calls[0][0]).toMatchObject({
      where: { userId: "u1", status: "PENDING", enqueuedAt: null },
      orderBy: { createdAt: "asc" },
      take: 1,
    });
    expect(tx.job.update).toHaveBeenCalledWith({
      where: { id: "q1" },
      data: { enqueuedAt: expect.any(Date) },
    });
    // Enqueued with the dedup id; no free CHARGE row -> no priority.
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd.mock.calls[0][1]).toEqual({ jobId: "q1", userId: "u1" });
    expect(queueAdd.mock.calls[0][2]).toEqual({ jobId: "dl:q1" });
  });

  it("keeps the free-job priority for a job charged to the free ledger", async () => {
    tx.job.count.mockResolvedValueOnce(0);
    tx.job.findMany = vi.fn(async () => [
      { id: "q1", userId: "u1", createdAt: new Date(1) },
    ]);
    freeUsageFindFirst.mockResolvedValue({ id: "fu1" });
    await releaseNextQueued("u1");
    expect(freeUsageFindFirst.mock.calls[0][0].where).toEqual({
      jobId: "q1",
      kind: "CHARGE",
    });
    expect(queueAdd.mock.calls[0][2]).toMatchObject({ priority: 10 });
  });

  it("releases nothing while the slot is genuinely held", async () => {
    tx.job.count.mockResolvedValueOnce(1); // 1 active, limit 1
    const released = await releaseNextQueued("u1");
    expect(released).toEqual([]);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  // The stall guard's view: an active job silent for 3h does not hold the
  // slot. Mutation: drop the updatedAt term when staleBefore is set -> red.
  it("ignores actives silent since staleBefore when asked to", async () => {
    const staleBefore = new Date("2026-08-19T09:00:00Z");
    await releaseNextQueued("u1", { staleBefore });
    const where = tx.job.count.mock.calls[0][0].where;
    expect(where.updatedAt).toEqual({ gte: staleBefore });
    expect(where.enqueuedAt).toEqual({ not: null });
  });

  it("returns [] instead of throwing on lock contention", async () => {
    (prisma.$transaction as any).mockRejectedValueOnce(
      Object.assign(new Error("timeout"), { code: "P2028" })
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(releaseNextQueued("u1")).resolves.toEqual([]);
    warn.mockRestore();
  });
});

describe("releaseStalledQueues", () => {
  beforeEach(() => {
    jobGroupBy.mockReset();
    tx.job.count.mockReset();
    tx.job.count.mockResolvedValue(0);
    tx.job.findMany = vi.fn(async () => []);
    tx.job.update = vi.fn(async () => ({}));
    tx.user.findUniqueOrThrow.mockResolvedValue({ plan: "NONE", billingCycle: null });
    freeUsageFindFirst.mockReset();
    freeUsageFindFirst.mockResolvedValue(null);
    queueAdd.mockClear();
  });

  it("visits exactly the users who have a waiting job, with the 3h line", async () => {
    jobGroupBy.mockResolvedValue([{ userId: "u1" }, { userId: "u2" }]);
    const now = new Date("2026-08-19T12:00:00Z");
    await releaseStalledQueues(now);
    expect(jobGroupBy.mock.calls[0][0]).toMatchObject({
      by: ["userId"],
      where: { status: "PENDING", enqueuedAt: null },
    });
    // Two users -> two release transactions, each with staleBefore = now - 3h.
    const staleBefore = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const countWheres = tx.job.count.mock.calls.map((c: any[]) => c[0].where);
    expect(countWheres.filter((w: any) => +w.updatedAt.gte === +staleBefore)).toHaveLength(2);
  });
});
```

Also extend the import line at the top of the test file:

```ts
import {
  createJob,
  findDuplicateJob,
  releaseNextQueued,
  releaseStalledQueues,
} from "../job.service";
import { ACTIVE_JOB_STATUSES } from "../job.service";
```

(If `ACTIVE_JOB_STATUSES` is already imported elsewhere in the file, do not import twice.)

Note on the `$transaction` mock: the existing mock is `vi.fn(async (fn) => { ... })`. The lock-contention test uses `mockRejectedValueOnce`; import `prisma` from `../../lib/prisma` in the test file if it is not already imported (it is - line near the queue mock).

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `docker compose exec -T bot sh -c 'cd /app && /app/node_modules/.bin/vitest run packages/shared/src/services/__tests__/job.service.test.ts'`
Expected: FAIL - `releaseNextQueued` is not exported, the count has no `enqueuedAt` term, etc.

- [ ] **Step 3: Implement in `job.service.ts`**

3a. Extend the result union (replace the existing `CreateJobResult` type):

```ts
export type CreateJobResult =
  | { status: "created"; job: Job }
  /** Created and charged, but WAITING for a concurrency slot. `position` is
   *  1-based among this user's waiting jobs (1 = next in line). Only emitted
   *  when SUBMISSION_QUEUE=on; the flag off reproduces concurrent_limit. */
  | { status: "queued"; job: Job; position: number }
  | { status: "concurrent_limit"; inFlight: number; limit: number }
  | { status: "busy" };
```

3b. Add near `FREE_JOB_PRIORITY`:

```ts
/** Kill switch, read per call like YTDLP_PROXY: only the exact literal "on"
 *  queues; anything else refuses at the cap exactly as before the queue
 *  existed. The RELEASE path deliberately does not consult this - turning the
 *  flag off must drain the queue, not strand it. */
export function submissionQueueEnabled(): boolean {
  return process.env.SUBMISSION_QUEUE === "on";
}

/** Deterministic BullMQ id for a job's download add. BullMQ ignores an add
 *  whose id it has already seen, which makes a double release (completion
 *  hook and stall guard racing) a no-op instead of a double download. */
function downloadJobId(jobId: string): string {
  return `dl:${jobId}`;
}
```

3c. In `createJob`'s transaction body, change the in-flight count and the refusal branch (currently `const inFlight = await tx.job.count({... status ...}); if (inFlight >= limit) return concurrent_limit;`):

```ts
        // Only ENQUEUED rows hold a slot. A waiting row (enqueuedAt NULL) must
        // not count, or one queued job would block every later release: the
        // queue would deadlock on its own members.
        const inFlight = await tx.job.count({
          where: {
            userId: input.userId,
            status: { in: [...ACTIVE_JOB_STATUSES] },
            enqueuedAt: { not: null },
          },
        });

        const atCapacity = inFlight >= limit;
        if (atCapacity && !submissionQueueEnabled()) {
          return { status: "concurrent_limit", inFlight, limit };
        }

        const created = await tx.job.create({
          data: {
            userId: input.userId,
            sourceUrl: input.sourceUrl,
            sourceKey: input.sourceKey,
            sourceFingerprint: input.sourceFingerprint ?? null,
            originalFilename: input.originalFilename,
            subtitles: input.subtitles ?? true,
            sourceDurationSec: input.sourceDurationSec,
            status: "PENDING",
            // NULL is the queue: released by releaseNextQueued when a slot
            // frees. The charge below is written either way - a queued job has
            // reserved its seconds the moment the user was told "got it".
            enqueuedAt: atCapacity ? null : new Date(),
          },
        });

        if (input.freeCharge) {
          await tx.freeUsage.create({
            data: {
              userId: input.userId,
              jobId: created.id,
              kind: "CHARGE",
              seconds: input.freeCharge.seconds,
              estimatedCostUsd: input.freeCharge.estimatedCostUsd,
            },
          });
        }

        if (atCapacity) {
          // 1-based among this user's waiting rows, self included - the row
          // above is visible to this count because it is the same transaction.
          const position = await tx.job.count({
            where: { userId: input.userId, status: "PENDING", enqueuedAt: null },
          });
          return { status: "queued", job: created, position };
        }

        return { status: "created", job: created };
```

3d. After the transaction, the enqueue guard stays `if (result.status !== "created") return result;` (a queued job is NOT added). Change the `add` options to carry the dedup id:

```ts
  await getStageQueue("download").add(
    "download",
    {
      jobId: job.id,
      userId: job.userId,
    },
    // Only free jobs carry a priority. Passing one for paid jobs would move
    // them OFF the wait list into the prioritized set, which - per the read of
    // moveToActive above - is the slower of the two, so "being explicit" would
    // make paying users worse off.
    //
    // The deterministic jobId makes re-adding this job a no-op - see
    // downloadJobId.
    {
      jobId: downloadJobId(job.id),
      ...(input.freeCharge ? { priority: FREE_JOB_PRIORITY } : {}),
    }
  );
```

3e. Append the release functions at the end of the file (after `findDuplicateJob`):

```ts
/** How long an active job may go without touching its row before the stall
 *  guard presumes its worker dead and stops counting it against the limit.
 *  Every stage updates Job.status (and thus updatedAt) as it runs, so a 3h
 *  silence is not a slow job - it is a job nobody is running. */
export const QUEUE_STALL_MS = 3 * 60 * 60 * 1000;

/**
 * Hand the oldest waiting jobs to BullMQ while this user has free slots.
 *
 * Runs under the SAME advisory lock as createJob, so a submission and a
 * release can never both read a stale count. NEVER throws: it is called from
 * worker event handlers and an hourly sweep, and a failed release is repaired
 * by the next completion or the stall guard - taking a worker down over it
 * would cost more than the wait.
 *
 * `staleBefore` is the stall guard's view: actives whose updatedAt is older
 * stop holding a slot. The normal hooks pass nothing and trust every active.
 */
export async function releaseNextQueued(
  userId: string,
  opts: { staleBefore?: Date } = {}
): Promise<Job[]> {
  let released: Job[] = [];
  try {
    released = await prisma.$transaction(
      async (tx): Promise<Job[]> => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${LOCK_WAIT_MS}`);
        await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${userId}), 1)) AS _lock`;

        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { plan: true, billingCycle: true },
        });
        const limit = getPlanLimits(
          user.plan,
          user.billingCycle ?? "MONTHLY"
        ).concurrentJobsLimit;

        const active = await tx.job.count({
          where: {
            userId,
            status: { in: [...ACTIVE_JOB_STATUSES] },
            enqueuedAt: { not: null },
            ...(opts.staleBefore ? { updatedAt: { gte: opts.staleBefore } } : {}),
          },
        });
        const slots = limit - active;
        if (slots <= 0) return [];

        const next = await tx.job.findMany({
          where: { userId, status: "PENDING", enqueuedAt: null },
          orderBy: { createdAt: "asc" },
          take: slots,
        });
        const now = new Date();
        for (const job of next) {
          await tx.job.update({
            where: { id: job.id },
            data: { enqueuedAt: now },
          });
        }
        return next;
      },
      { timeout: 15_000, maxWait: 10_000 }
    );
  } catch (err) {
    // Includes lock contention AND a user row deleted mid-flight. Both are
    // repaired by the next release attempt; neither may take the caller down.
    console.warn(
      `[queue] release for user ${userId} failed:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }

  // Outside the transaction for the same reason createJob enqueues outside:
  // a worker may pick the download up the instant the add lands.
  for (const job of released) {
    const freeCharged = await prisma.freeUsage.findFirst({
      where: { jobId: job.id, kind: "CHARGE" },
      select: { id: true },
    });
    await getStageQueue("download").add(
      "download",
      { jobId: job.id, userId: job.userId },
      {
        jobId: downloadJobId(job.id),
        ...(freeCharged ? { priority: FREE_JOB_PRIORITY } : {}),
      }
    );
    console.log(`[queue] released job ${job.id} for user ${job.userId}`);
  }
  return released;
}

/**
 * The hourly stall guard: for every user with a waiting job, run a release
 * that refuses to count actives silent for QUEUE_STALL_MS as slot-holders.
 * A dead worker must not hold somebody's queue forever; a healthy active has
 * touched its row within the window and keeps its slot.
 */
export async function releaseStalledQueues(now: Date): Promise<number> {
  const users = await prisma.job.groupBy({
    by: ["userId"],
    where: { status: "PENDING", enqueuedAt: null },
  });
  const staleBefore = new Date(now.getTime() - QUEUE_STALL_MS);
  let releasedTotal = 0;
  for (const { userId } of users) {
    const released = await releaseNextQueued(userId, { staleBefore });
    releasedTotal += released.length;
  }
  if (releasedTotal > 0) {
    console.warn(`[queue] stall guard released ${releasedTotal} job(s)`);
  }
  return releasedTotal;
}
```

3f. In `funnel.service.ts`, add to `FUNNEL_EVENTS` after `VIDEO_SUBMITTED`:

```ts
  /** Both: a submission was accepted into the queue (not refused) because a
   *  job was already running. Counts people who ever waited; the jobs table
   *  holds the how-often. NOT a refusal - upload_rejected_concurrent stops
   *  being written the day the flag turns on. */
  VIDEO_QUEUED: "video_queued",
```

- [ ] **Step 4: Rebuild shared, run the tests**

Run: `docker compose exec -T bot sh -c 'cd /app && npm run build -w @clipclap/shared && /app/node_modules/.bin/vitest run packages/shared/src/services/__tests__/job.service.test.ts packages/shared/src/services/__tests__/funnel.service.test.ts'`
Expected: PASS, no failures in the pre-existing tests either.

- [ ] **Step 5: Mutation-test the three named guards**

One at a time, apply, run the single test, confirm RED, revert:
1. Remove `enqueuedAt: { not: null }` from createJob's in-flight count -> "counts only ENQUEUED active jobs" red.
2. Change releaseNextQueued's `orderBy` to `{ createdAt: "desc" }` -> "releases the oldest" red.
3. Remove the `updatedAt` spread when `staleBefore` is set -> "ignores actives silent since staleBefore" red.

If any stays green, fix the test before proceeding.

- [ ] **Step 6: Typecheck shared and commit**

Run: `docker compose exec -T bot sh -c 'cd /app/packages/shared && /app/node_modules/.bin/tsc --noEmit -p tsconfig.json'`
Expected: exit 0.

```bash
git add packages/shared/src/services/job.service.ts packages/shared/src/services/funnel.service.ts packages/shared/src/services/__tests__/job.service.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(queue): createJob queues at the cap behind SUBMISSION_QUEUE; releaseNextQueued frees slots

At the concurrency cap with the flag on, the row is created and charged
exactly as a started job but enqueuedAt stays NULL and the answer is
queued+position instead of a refusal. releaseNextQueued hands the oldest
waiting jobs to BullMQ under the same per-user advisory lock as createJob;
releaseStalledQueues is the hourly view that refuses to let a 3h-silent
active hold a slot. Deterministic BullMQ ids (dl:<jobId>) make a double
release a no-op. Flag off = concurrent_limit byte for byte; the release
path ignores the flag so rollback drains the queue instead of stranding it."
```

---

### Task 3: Worker hooks + hourly stall rule

**Files:**
- Modify: `apps/worker/src/worker-app.ts`
- Modify: `packages/shared/src/lib/referral-queue.ts` (new job name + schedule)
- Modify: `packages/shared/src/lib/index.ts` (export the new job name)
- Modify: `apps/worker/src/referral-scheduler.ts` (handle the new job)
- Test: `apps/worker/src/__tests__/queue-release-hooks.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/__tests__/queue-release-hooks.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  releaseNextQueued: vi.fn(async () => []),
}));

vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clipclap/shared")>();
  return { ...actual, releaseNextQueued: mocks.releaseNextQueued };
});

import { maybeReleaseAfterStageEvent } from "../worker-app";

/**
 * A slot frees in exactly two situations: the pipeline ENDED well (finalize
 * completed) or it ENDED badly (any stage exhausted its BullMQ attempts).
 * Everything else - a mid-pipeline stage completing, a failure that will be
 * retried - must not release, or the queue would overshoot the limit while
 * the pipeline is still alive.
 */
describe("maybeReleaseAfterStageEvent", () => {
  beforeEach(() => {
    mocks.releaseNextQueued.mockClear();
  });

  it("releases when finalize completes", async () => {
    await maybeReleaseAfterStageEvent("finalize", "completed", {
      data: { jobId: "j1", userId: "u1" },
    } as never);
    expect(mocks.releaseNextQueued).toHaveBeenCalledWith("u1");
  });

  it("does NOT release when a mid-pipeline stage completes", async () => {
    await maybeReleaseAfterStageEvent("download", "completed", {
      data: { jobId: "j1", userId: "u1" },
    } as never);
    expect(mocks.releaseNextQueued).not.toHaveBeenCalled();
  });

  it("releases on a TERMINAL failure of any stage", async () => {
    await maybeReleaseAfterStageEvent("download", "failed", {
      data: { jobId: "j1", userId: "u1" },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as never);
    expect(mocks.releaseNextQueued).toHaveBeenCalledWith("u1");
  });

  // Mutation: change >= to > in the terminal check -> this test goes red.
  it("does NOT release on a failure that will be retried", async () => {
    await maybeReleaseAfterStageEvent("transcribe", "failed", {
      data: { jobId: "j1", userId: "u1" },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as never);
    expect(mocks.releaseNextQueued).not.toHaveBeenCalled();
  });

  it("survives a missing job or userId and a throwing release", async () => {
    await maybeReleaseAfterStageEvent("finalize", "completed", undefined);
    await maybeReleaseAfterStageEvent("finalize", "completed", {
      data: {},
    } as never);
    mocks.releaseNextQueued.mockRejectedValueOnce(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      maybeReleaseAfterStageEvent("finalize", "completed", {
        data: { jobId: "j1", userId: "u1" },
      } as never)
    ).resolves.toBeUndefined();
    err.mockRestore();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `docker compose exec -T worker-render sh -c 'cd /app && /app/node_modules/.bin/vitest run apps/worker/src/__tests__/queue-release-hooks.test.ts'`
Expected: FAIL - `maybeReleaseAfterStageEvent` is not exported.

- [ ] **Step 3: Implement the hook in `worker-app.ts`**

Add to the imports from `@clipclap/shared`: `releaseNextQueued`.

Add the exported helper (below `dispatchStageJob`):

```ts
/**
 * Free a queue slot when - and only when - a job's PIPELINE ended.
 *
 * "Ended" is finalize completing (the one stage that runs last) or any stage
 * exhausting its BullMQ attempts (a mid-pipeline terminal failure never
 * reaches finalize). A retriable failure keeps its slot: the job is still
 * alive and about to run again, and releasing on it would put two of the
 * user's jobs on workers with a limit of one - exactly what the advisory
 * lock in createJob exists to prevent.
 *
 * Swallows everything. This runs inside BullMQ event handlers; the queue is
 * self-healing (next completion or the hourly stall guard retries), a downed
 * worker is not.
 */
export async function maybeReleaseAfterStageEvent(
  role: StageName,
  event: "completed" | "failed",
  job:
    | {
        data?: unknown;
        attemptsMade?: number;
        opts?: { attempts?: number };
      }
    | undefined
): Promise<void> {
  try {
    if (!job) return;
    if (event === "completed" && role !== "finalize") return;
    if (event === "failed") {
      const attempts = job.opts?.attempts ?? 1;
      if ((job.attemptsMade ?? 0) < attempts) return;
    }
    const userId = (job.data as { userId?: string } | undefined)?.userId;
    if (!userId) return;
    await releaseNextQueued(userId);
  } catch (error) {
    console.error(`[queue] post-${event} release failed:`, error);
  }
}
```

Wire it into `createStageWorker`'s existing event handlers:

```ts
  worker.on("completed", (job) => {
    console.log(`[${role}] completed ${job.id}`);
    void maybeReleaseAfterStageEvent(role, "completed", job);
  });
  worker.on("failed", (job, err) => {
    console.error(`[${role}] failed ${job?.id}:`, err.message);
    void maybeReleaseAfterStageEvent(role, "failed", job ?? undefined);
  });
```

- [ ] **Step 4: Add the hourly stall rule**

In `packages/shared/src/lib/referral-queue.ts`, after `TRIBUTE_RECONCILE_JOB`:

```ts
/** Submission-queue stall guard. Same queue, same reasoning as the sweeps:
 *  hourly, idempotent, nobody is waiting on the rule itself. */
export const QUEUE_STALL_JOB = "submission-queue-stall";
```

In `registerReferralSchedules`, after the TRIBUTE line (offset to :30 so the hourly rules do not all fire together):

```ts
  await queue.add(QUEUE_STALL_JOB, {}, { repeat: { pattern: "30 * * * *" }, jobId: QUEUE_STALL_JOB });
```

In `packages/shared/src/lib/index.ts`, add `QUEUE_STALL_JOB` to the export list from `./referral-queue`.

In `apps/worker/src/referral-scheduler.ts`: add `QUEUE_STALL_JOB` and `releaseStalledQueues` to the `@clipclap/shared` import, and a branch before the closing of the handler:

```ts
      if (job.name === QUEUE_STALL_JOB) {
        // Logs its own releases; a zero run is silent on purpose - an hourly
        // "nothing happened" line is noise that buries the real ones.
        await releaseStalledQueues(now);
        return;
      }
```

- [ ] **Step 5: Rebuild shared, run the new tests plus the worker suite**

Run: `docker compose exec -T bot sh -c 'cd /app && npm run build -w @clipclap/shared'`
then `docker compose exec -T worker-render sh -c 'cd /app && /app/node_modules/.bin/vitest run apps/worker/src/__tests__/queue-release-hooks.test.ts apps/worker/src/__tests__/worker-role.test.ts'`
Expected: PASS.

- [ ] **Step 6: Mutation-test the terminal check**

Change `< attempts` to `<= attempts` in `maybeReleaseAfterStageEvent` -> "releases on a TERMINAL failure" must go red. Revert. Then change `role !== "finalize"` to `role !== "download"` -> "does NOT release when a mid-pipeline stage completes" must go red. Revert.

- [ ] **Step 7: Typecheck worker and commit**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker && /app/node_modules/.bin/tsc --noEmit -p tsconfig.json'`
Expected: exit 0.

```bash
git add apps/worker/src/worker-app.ts apps/worker/src/__tests__/queue-release-hooks.test.ts packages/shared/src/lib/referral-queue.ts packages/shared/src/lib/index.ts apps/worker/src/referral-scheduler.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(queue): free a slot when the pipeline ends - finalize completed or any stage's terminal failure

Plus the hourly stall rule (submission-queue-stall, :30) that releases past a
3h-silent active. A retriable failure keeps its slot; mid-pipeline completions
never release. Hooks swallow their own errors - the queue self-heals, a downed
worker does not."
```

---

### Task 4: Bot - accept-and-queue copy on both paths

**Files:**
- Modify: `apps/bot/src/i18n/types.ts` (one entry), `apps/bot/src/i18n/{en,ru,uk,es,pt,id,ar}.ts`
- Modify: `apps/bot/src/handlers.ts` (both `created.status` consumers)
- Test: `apps/bot/src/__tests__/funnel.test.ts` (extend)

- [ ] **Step 1: Add the copy**

`apps/bot/src/i18n/types.ts`, after `duplicateDone`:

```ts
  /** Accepted into the queue: a job is already running, this one starts by
   *  itself. position is 1-based (1 = next in line). */
  queuedBehind: (position: number) => string;
```

Locale entries (insert after each file's `duplicateDone` entry, keeping each file's formatting):

`en.ts`:
```ts
  queuedBehind: (position) =>
    position <= 1
      ? "Got it - I'm still working on your other video, so this one waits its turn: it's next in line and starts by itself. No need to resend it."
      : `Got it - I'm still working on your other video, so this one waits its turn: number ${position} in line. It starts by itself - no need to resend it.`,
```

`ru.ts`:
```ts
  queuedBehind: (position) =>
    position <= 1
      ? "Принял - я ещё занят твоим другим видео, так что это подождёт своей очереди: оно следующее и стартует само. Присылать заново не нужно."
      : `Принял - я ещё занят твоим другим видео, так что это подождёт своей очереди: оно в ней под номером ${position}. Стартует само - присылать заново не нужно.`,
```

`uk.ts`:
```ts
  queuedBehind: (position) =>
    position <= 1
      ? "Прийняв - я ще зайнятий твоїм іншим відео, тож це почекає своєї черги: воно наступне і стартує само. Надсилати вдруге не потрібно."
      : `Прийняв - я ще зайнятий твоїм іншим відео, тож це почекає своєї черги: воно в ній під номером ${position}. Стартує само - надсилати вдруге не потрібно.`,
```

`es.ts`:
```ts
  queuedBehind: (position) =>
    position <= 1
      ? "Recibido - todavía estoy con tu otro video, así que este espera su turno: es el siguiente y arranca solo. No hace falta reenviarlo."
      : `Recibido - todavía estoy con tu otro video, así que este espera su turno: es el número ${position} de la cola. Arranca solo - no hace falta reenviarlo.`,
```

`pt.ts`:
```ts
  queuedBehind: (position) =>
    position <= 1
      ? "Recebido - ainda estou no seu outro vídeo, então este espera a vez: é o próximo e começa sozinho. Não precisa reenviar."
      : `Recebido - ainda estou no seu outro vídeo, então este espera a vez: é o número ${position} da fila. Começa sozinho - não precisa reenviar.`,
```

`id.ts`:
```ts
  queuedBehind: (position) =>
    position <= 1
      ? "Diterima - aku masih mengerjakan videomu yang lain, jadi yang ini menunggu giliran: dia berikutnya dan mulai sendiri. Tidak perlu dikirim ulang."
      : `Diterima - aku masih mengerjakan videomu yang lain, jadi yang ini menunggu giliran: nomor ${position} dalam antrean. Mulai sendiri - tidak perlu dikirim ulang.`,
```

`ar.ts`:
```ts
  queuedBehind: (position) =>
    position <= 1
      ? "استلمته - ما زلت أعمل على فيديوك الآخر، لذا سينتظر هذا دوره: إنه التالي وسيبدأ من تلقاء نفسه. لا داعي لإعادة إرساله."
      : `استلمته - ما زلت أعمل على فيديوك الآخر، لذا سينتظر هذا دوره: رقمه في الطابور ${position}. سيبدأ من تلقاء نفسه - لا داعي لإعادة إرساله.`,
```

- [ ] **Step 2: Write the failing bot test**

In `apps/bot/src/__tests__/funnel.test.ts`, inside the `refusals the bot used to swallow` describe (it has the harness, `videoUrlUpdate`, and the prisma mocks), add. NOTE: the URL path calls the real `createJob`, whose `$transaction` this suite's prisma mock does not implement - so mock `$transaction` for this test only, returning the queued result shape via the service. Simpler and equal in value: mock at the module boundary. This suite does NOT mock `@clipclap/shared`, so instead drive the transaction: add `$transaction: mocks.dollarTransaction` to the prisma mock object (hoisted `dollarTransaction: vi.fn()`), and in this test resolve it to the queued result by implementing it as a function that runs the callback against a tx stub. That reimplements half of job.service - too much. THEREFORE: test the queued path at the unit where it lives - `handleVideo`/URL handler behaviour - by mocking `jobService.createJob` via `vi.spyOn`. `jobService` is imported as a namespace (`import { jobService } from "@clipclap/shared"`), so:

```ts
  it("accepts a second video into the queue: says the position, keeps the delivery row, counts video_queued", async () => {
    process.env.SUBMISSION_QUEUE = "on";
    mocks.probeVideoUrl.mockResolvedValue({ ok: true, durationSec: 900, title: "Второе видео" });
    const createJobSpy = vi
      .spyOn(jobService, "createJob")
      .mockResolvedValue({
        status: "queued",
        job: { id: "jq1", userId: "u1" } as never,
        position: 1,
      });
    const deliverySpy = vi
      .spyOn(sharedModule, "createTelegramDelivery")
      .mockResolvedValue({} as never);
    const { client } = harness();

    try {
      await handleUpdate(
        client as never,
        videoUrlUpdate("https://example.com/watch?v=second") as never,
        CONFIG
      );
    } finally {
      createJobSpy.mockRestore();
      deliverySpy.mockRestore();
      delete process.env.SUBMISSION_QUEUE;
    }

    // Accepted, not refused: the queued message with the position, no
    // upload_rejected_* row, and the funnel step that counts queued people.
    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").queuedBehind(1)
    );
    expect(deliverySpy).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "jq1" })
    );
    expect(eventsRecorded()).toContain("video_queued");
    expect(refusalsRecorded()).toEqual([]);
  });
```

Imports to add at the top of the test file: `import * as sharedModule from "@clipclap/shared";` and ensure `jobService` is imported (add `import { jobService } from "@clipclap/shared";` if absent). If `vi.spyOn(jobService, ...)` fails because the namespace is frozen, fall back to `vi.spyOn(sharedModule.jobService, "createJob")`.

- [ ] **Step 3: Run, confirm failure**

Run: `docker compose exec -T bot sh -c 'cd /app && /app/node_modules/.bin/vitest run apps/bot/src/__tests__/funnel.test.ts'`
Expected: the new test FAILS (`queuedBehind` missing / no queued branch).

- [ ] **Step 4: Implement both handler paths**

In `apps/bot/src/handlers.ts`, BOTH places that read `created.status` (file path ~after the busy branch at `const job = created.job;`, and the URL path likewise):

The union member `queued` carries `job`, so `const job = created.job;` still typechecks after the two refusal branches return. After the existing `showQueuedBoard(...)` call and BEFORE the `isShortSource` notice, add on each path:

```ts
  if (created.status === "queued") {
    await client.sendMessage(
      message.chat.id,
      dict.queuedBehind(created.position)
    );
    await recordFunnelEvent(
      "bot",
      from.id,
      FUNNEL_EVENTS.VIDEO_QUEUED,
      from.language_code
    );
  }
```

(`FUNNEL_EVENTS` and `recordFunnelEvent` are already imported in handlers.ts.)

- [ ] **Step 5: Run the whole bot suite**

Run: `docker compose exec -T bot sh -c 'cd /app && /app/node_modules/.bin/vitest run apps/bot/src/__tests__'`
Expected: ALL PASS (the pre-queue tests must not change: with the flag off createJob never answers `queued`).

- [ ] **Step 6: Typecheck bot and commit**

Run: `docker compose exec -T bot sh -c 'cd /app/apps/bot && /app/node_modules/.bin/tsc --noEmit -p tsconfig.json'` (ignore pre-existing TS6059 lines; exit code must be 0)

```bash
git add apps/bot/src/i18n apps/bot/src/handlers.ts apps/bot/src/__tests__/funnel.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(bot): a second video is accepted into the queue, not refused

Both submit paths handle status queued: the delivery row and the progress
board exactly as a started job, plus one line naming the position, plus the
video_queued funnel step. Copy in 7 locales. Flag off keeps the old refusal."
```

---

### Task 5: Web - 202 + queued fields

**Files:**
- Modify: `apps/web/app/api/jobs/route.ts` (POST, after the `busy` branch, before the 201 return)
- Modify: `apps/web/lib/api.ts` (jobs.create return type)

The dashboard already labels a PENDING job "queued" (`apps/web/components/project-list.tsx` line ~47), and `upload-zone.tsx` only reads `job.id` from the response - so the response must carry the job fields at the top level, with `queued`/`position` added.

- [ ] **Step 1: Route change**

In `apps/web/app/api/jobs/route.ts`, directly before `return NextResponse.json(created.job, { status: 201 });`:

```ts
  if (created.status === "queued") {
    // Accepted, not refused: 202 with the job itself at the top level so the
    // upload flow (which reads job.id and navigates to the project) works
    // unchanged, plus the queue facts for any client that wants to say so.
    await recordFunnelEvent("web", userId, FUNNEL_EVENTS.VIDEO_QUEUED);
    return NextResponse.json(
      { ...created.job, queued: true, position: created.position },
      { status: 202 }
    );
  }
```

(`FUNNEL_EVENTS` is already imported in the route.)

- [ ] **Step 2: API client type**

In `apps/web/lib/api.ts`, change the create return type so a client can see the queue facts:

```ts
    create: (data: {
      url?: string;
      sourceKey?: string;
      originalFilename?: string;
      subtitles: boolean;
      sourceDurationSec?: number;
    }) =>
      fetchApi<JobWithClips & { queued?: boolean; position?: number }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify(data),
      }),
```

- [ ] **Step 3: Typecheck web**

Run: `docker compose exec -T web sh -c 'cd /app/apps/web && /app/node_modules/.bin/tsc --noEmit -p tsconfig.json'` (ignore pre-existing TS6059; exit 0)

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/jobs/route.ts apps/web/lib/api.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(web): a submission at the cap answers 202 queued+position instead of 429

The job rides at the top level of the body so the upload flow's job.id read
and the project navigation work unchanged; the dashboard already labels a
PENDING job as queued. video_queued recorded beside it."
```

---

### Task 6 (orchestrator only - NOT a subagent task): deploy, live E2E, records

- [ ] Migration was applied after Task 1; run the second backfill to close the deploy window (old code created-and-enqueued rows with NULL enqueuedAt):
  `docker compose exec -T postgres psql -U clipclap -d clipclap -c 'UPDATE "jobs" SET "enqueuedAt" = "createdAt" WHERE "enqueuedAt" IS NULL;'`
- [ ] Rebuild shared dist; verify bot + workers restart clean; web: `compose run ... prisma generate && next build` + `compose restart web`.
- [ ] Live E2E with a synthetic user (@test.local, `isSynthetic: true`) via `compose run --no-deps` script from packages/shared with `SUBMISSION_QUEUE=on`: two createJob calls -> first `created`, second `queued` position 1; then `releaseNextQueued` -> enqueuedAt stamped; verify the BullMQ add landed with id `dl:<jobId>`; delete the synthetic rows and the BullMQ jobs after.
- [ ] Flag on: add `SUBMISSION_QUEUE=on` to `.env` (Read+Edit, never sed), `docker compose up -d bot web worker-download worker-transcribe worker-analyze worker-render worker-finalize` is NOT needed for bot/workers (tsx reads env per process start - it IS needed: env_file is read at container creation) -> recreate the containers that read the flag: bot, web, and all five workers; then per-container `prisma generate` and `npm run build -w @clipclap/shared` per the deploy-regen memory; web needs its build+restart afterwards.
- [ ] Verify the scheduler registered `submission-queue-stall` (worker-finalize logs / `redis-cli` repeat set).
- [ ] Update the spec status line, memory `project_submission_gates_2026_08_18`, and MEMORY.md.

---

## Self-review notes

- Spec §2.1-§2.6 map to Tasks 1 (column+backfill), 2 (createJob/queued/position, release), 3 (hooks + stall rule), 4 (bot copy + video_queued), 5 (web 202). §4 edge cases: healed FAILED double-release is covered by the BullMQ dedup id (Task 2) and the idempotent count-under-lock; deleted-user release path returns [] (findUniqueOrThrow caught); the 200ms album race rides the SAME advisory lock that was already reproduced against Postgres for the concurrency limit - the live E2E in Task 6 exercises created-then-queued against the real DB.
- `upload_rejected_concurrent` keeps existing for flag-off and for the busy path; nothing rewrites history.
- Types: `CreateJobResult["queued"]` carries `job`, so both bot paths' `const job = created.job;` lines survive; verified against handlers.ts lines 2282 and 2540.
