import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Prisma } from "@prisma/client";

/** The unique index on (userId, jobId, kind). */
function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.20.0",
  });
}

/** Records the order in which the transaction body and the enqueue ran, so a
 *  test can assert the enqueue is not merely present but LATER. */
const calls: string[] = [];

/** Statement order INSIDE the transaction. Kept apart from `calls` so the
 *  transaction-versus-enqueue tests keep reading as one list. */
const inner: string[] = [];

const tx = {
  job: {
    create: vi.fn(),
    count: vi.fn(async () => {
      inner.push("count");
      return 0;
    }),
    // release-side additions: the release transaction reads the waiting rows
    // and stamps enqueuedAt on them, both inside the same tx handle as the
    // lock and the count.
    update: vi.fn(),
    findMany: vi.fn(),
  },
  freeUsage: { create: vi.fn() },
  user: { findUniqueOrThrow: vi.fn() },
  // SET LOCAL lock_timeout. Recorded in `inner` because WHERE it sits matters:
  // set after the lock statement it bounds nothing at all.
  $executeRawUnsafe: vi.fn(async (sql: string) => {
    inner.push(`set:${sql}`);
    return 0;
  }),
  // The advisory lock. When it is taken is the whole point: a lock acquired
  // after the count would serialise nothing.
  $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ..._v: unknown[]) => {
    inner.push("lock");
    return [{ ok: 1 }];
  }),
};

const jobFindMany = vi.fn();
const jobUpdate = vi.fn();
const jobGroupBy = vi.fn();
const freeUsageFindFirst = vi.fn();

vi.mock("../../lib/prisma", () => ({
  prisma: {
    job: {
      findMany: (...args: unknown[]) => jobFindMany(...args),
      update: (...args: unknown[]) => jobUpdate(...args),
      groupBy: (...args: unknown[]) => jobGroupBy(...args),
    },
    freeUsage: {
      findFirst: (...args: unknown[]) => freeUsageFindFirst(...args),
    },
    // A faithful-enough interactive transaction: it runs the callback and, if
    // the callback throws, propagates without committing. What matters for
    // these tests is that everything inside it happens before $transaction
    // resolves, which is exactly what awaiting the callback gives us.
    $transaction: vi.fn(async (fn: any) => {
      calls.push("tx:start");
      const result = await fn(tx);
      calls.push("tx:commit");
      return result;
    }),
  },
}));

const queueAdd = vi.fn(async (..._args: unknown[]) => {
  calls.push("enqueue");
});

vi.mock("../../lib/queues", () => ({
  getStageQueue: vi.fn(() => ({ add: queueAdd })),
}));

import { prisma } from "../../lib/prisma";
import { getStageQueue } from "../../lib/queues";
import {
  createJob,
  findDuplicateJob,
  releaseNextQueued,
  releaseStalledQueues,
  ACTIVE_JOB_STATUSES,
} from "../job.service";

const JOB = { id: "job_1", userId: "u1" };

describe("job.service createJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    inner.length = 0;
    tx.job.create.mockResolvedValue(JOB);
    tx.freeUsage.create.mockResolvedValue({});
    // Restored by hand: clearAllMocks forgets the CALLS, not the resolved
    // value a previous test set, so a test that stubbed one job in flight
    // would otherwise refuse every submission after it.
    tx.job.count.mockImplementation(async () => {
      inner.push("count");
      return 0;
    });
    // A free account with nothing in flight, unless a test says otherwise.
    tx.user.findUniqueOrThrow.mockResolvedValue({
      plan: "NONE",
      billingCycle: null,
    });
  });

  it("enqueues the download stage after the transaction commits, never before", async () => {
    await createJob({
      userId: "u1",
      sourceUrl: "https://example.com/v",
      freeCharge: { seconds: 600, estimatedCostUsd: 0.095 },
    });

    // The whole reason the charge moved inside createJob. A worker can pick the
    // download job up the instant this add lands, so an enqueue that happened
    // before the commit could reach TRANSCRIBE - where the money leaves - with
    // no ledger row written at all.
    expect(calls).toEqual(["tx:start", "tx:commit", "enqueue"]);
  });

  it("writes the Job row and the reservation in the SAME transaction", async () => {
    await createJob({
      userId: "u1",
      sourceUrl: "https://example.com/v",
      sourceDurationSec: 612,
      freeCharge: { seconds: 612, estimatedCostUsd: 0.0969 },
    });

    // Same `tx` handle for both, which is what "same transaction" means here:
    // neither row can exist without the other.
    expect(tx.job.create).toHaveBeenCalledTimes(1);
    expect(tx.freeUsage.create).toHaveBeenCalledTimes(1);
    expect(tx.freeUsage.create.mock.calls[0][0]).toEqual({
      data: {
        userId: "u1",
        jobId: "job_1",
        kind: "CHARGE",
        seconds: 612,
        estimatedCostUsd: 0.0969,
      },
    });
  });

  it("writes no ledger row at all when there is no freeCharge", async () => {
    await createJob({ userId: "u1", sourceUrl: "https://example.com/v" });

    // A paying account. A CHARGE row here would be counted by the monthly free
    // budget as free spend, and trueUpFreeCost would later rewrite it.
    expect(tx.freeUsage.create).not.toHaveBeenCalled();
    expect(calls).toEqual(["tx:start", "tx:commit", "enqueue"]);
  });

  it("gives a free job a priority and a paid job none", async () => {
    await createJob({
      userId: "u1",
      sourceUrl: "https://example.com/v",
      freeCharge: { seconds: 60, estimatedCostUsd: 0.0095 },
    });
    const freeOpts = queueAdd.mock.calls[0][2] as any;
    expect(freeOpts.priority).toBeGreaterThan(0);

    queueAdd.mockClear();

    await createJob({ userId: "u2", sourceUrl: "https://example.com/v" });
    // Undefined, NOT 0 or 1. Verified against the installed bullmq 5:
    // moveToActive pops the `wait` list first and only falls back to the
    // prioritized set, and addJob only routes into the prioritized set when
    // opts.priority is truthy. Giving paid jobs an explicit priority would
    // move them off the fast list and make paying users worse off.
    //
    // The options object itself is no longer undefined for a paid job - it
    // now always carries the dl:<jobId> dedup id (see downloadJobId) - so the
    // priority key is what's asserted here, not the whole object.
    const paidOpts = queueAdd.mock.calls[0][2] as any;
    expect(paidOpts.jobId).toBe("dl:job_1");
    expect(paidOpts.priority).toBeUndefined();
  });

  it("does not enqueue when the reservation cannot be written", async () => {
    tx.freeUsage.create.mockRejectedValue(p2002());

    await expect(
      createJob({
        userId: "u1",
        sourceUrl: "https://example.com/v",
        freeCharge: { seconds: 600, estimatedCostUsd: 0.095 },
      })
    ).rejects.toThrow();

    // Deliberately NOT swallowed the way chargeFreeSeconds swallows P2002. That
    // function is handed a jobId that already exists, so a duplicate means an
    // idempotent retry; here the jobId was minted one line earlier inside this
    // same transaction, so a duplicate cannot mean that. And Postgres has
    // already aborted the transaction, so carrying on would produce a confusing
    // failure at commit rather than a clear one here.
    expect(queueAdd).not.toHaveBeenCalled();
    expect(calls).toEqual(["tx:start"]);
  });

  it("enqueues onto the download stage", async () => {
    await createJob({ userId: "u1", sourceKey: "uploads/u1/x.mp4" });
    expect(getStageQueue).toHaveBeenCalledWith("download");
    expect(queueAdd.mock.calls[0][1]).toEqual({ jobId: "job_1", userId: "u1" });
  });

  it("still uses one transaction even with no reservation", async () => {
    await createJob({ userId: "u1", sourceKey: "uploads/u1/x.mp4" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

/**
 * The concurrency limit, which used to be a read in one file and a write in
 * another.
 *
 * Six simultaneous uploads on one free account all counted zero in flight, all
 * passed the route's check and all created: six jobs and six CHARGE rows
 * against a limit of one. These tests pin the three things that stop that -
 * the limit is checked here, it is checked under the lock, and a refusal
 * reaches neither the database nor the queue.
 */
describe("job.service createJob - concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    inner.length = 0;
    tx.job.create.mockResolvedValue(JOB);
    tx.freeUsage.create.mockResolvedValue({});
    // Restored by hand: clearAllMocks forgets the CALLS, not the resolved
    // value a previous test set, so a test that stubbed one job in flight
    // would otherwise refuse every submission after it.
    tx.job.count.mockImplementation(async () => {
      inner.push("count");
      return 0;
    });
    tx.user.findUniqueOrThrow.mockResolvedValue({
      plan: "NONE",
      billingCycle: null,
    });
  });

  it("takes the per-user advisory lock BEFORE counting anything", async () => {
    await createJob({ userId: "u1", sourceKey: "uploads/u1/x.mp4" });

    // A lock taken after the read is not a lock at all - it would let both
    // callers read the same zero and only then queue up to write.
    expect(inner).toEqual([
      "set:SET LOCAL lock_timeout = 5000",
      "lock",
      "count",
    ]);
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    const [strings, userId] = tx.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      string,
    ];
    // Transaction-scoped, so the commit or the rollback releases it - Prisma
    // pools connections, and a session lock would be taken on one connection
    // and never released by the other.
    expect(strings.join("?")).toContain("pg_advisory_xact_lock");
    // Keyed on the user, so two people submitting at once do not queue behind
    // each other.
    expect(strings.join("?")).toContain("hashtext");
    expect(userId).toBe("u1");
  });

  it("refuses when the account is already at its limit", async () => {
    tx.job.count.mockResolvedValue(1);

    const result = await createJob({
      userId: "u1",
      sourceKey: "uploads/u1/x.mp4",
      freeCharge: { seconds: 600, estimatedCostUsd: 0.095 },
    });

    expect(result).toEqual({ status: "concurrent_limit", inFlight: 1, limit: 1 });
    // No job, no reservation, no queue entry. The reservation matters most: a
    // CHARGE row written for a refused submission would spend the allowance on
    // a job that never ran.
    expect(tx.job.create).not.toHaveBeenCalled();
    expect(tx.freeUsage.create).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("reads the limit from the plan on the user row, not from the caller", async () => {
    // PLUS allows two in flight. A caller that passed its own idea of the limit
    // could be working from a plan that changed since it read the user.
    tx.user.findUniqueOrThrow.mockResolvedValue({
      plan: "PLUS",
      billingCycle: "MONTHLY",
    });
    tx.job.count.mockResolvedValue(1);

    const result = await createJob({ userId: "u1", sourceKey: "uploads/u1/x.mp4" });

    expect(result.status).toBe("created");
    expect(tx.job.create).toHaveBeenCalledOnce();
  });

  it("counts only jobs that have not reached a terminal state", async () => {
    await createJob({ userId: "u1", sourceKey: "uploads/u1/x.mp4" });

    const where = (tx.job.count.mock.calls as any[])[0][0].where;
    expect(where.userId).toBe("u1");
    // DONE and FAILED are finished; counting them would refuse every submission
    // an account ever made after its first five.
    expect(where.status.in).not.toContain("DONE");
    expect(where.status.in).not.toContain("FAILED");
    expect(where.status.in).toContain("PENDING");
    expect(where.status.in).toContain("CUTTING");
  });

  it("returns the created job under a status, so a refusal cannot be mistaken for one", async () => {
    const result = await createJob({ userId: "u1", sourceKey: "uploads/u1/x.mp4" });
    expect(result).toEqual({ status: "created", job: JOB });
  });
});

/**
 * CONTENTION IS A REFUSAL, NOT A 500.
 *
 * Reproduced against prod: holding pg_advisory_xact_lock(hashtext(user), 1) in
 * psql and submitting made this function throw PrismaClientKnownRequestError
 * P2028 after 22.7 SECONDS - the `timeout: 15_000` on the transaction did not
 * bound the wait, because Prisma only checks it when the next statement is
 * issued and the blocked statement never returned. The web route had no catch,
 * so the user got a bare 500 and the funnel got nothing.
 */
describe("job.service createJob - lock contention", () => {
  /** What Postgres sends when lock_timeout cancels a blocked statement. */
  function lockTimeout(): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError("Raw query failed", {
      code: "P2010",
      clientVersion: "5.20.0",
      meta: { code: "55P03", message: "ERROR: canceling statement due to lock timeout" },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    inner.length = 0;
    tx.job.create.mockResolvedValue(JOB);
    tx.freeUsage.create.mockResolvedValue({});
    tx.job.count.mockImplementation(async () => {
      inner.push("count");
      return 0;
    });
    tx.user.findUniqueOrThrow.mockResolvedValue({
      plan: "NONE",
      billingCycle: null,
    });
    tx.$executeRawUnsafe.mockImplementation(async (sql: string) => {
      inner.push(`set:${sql}`);
      return 0;
    });
    tx.$queryRaw.mockImplementation(async () => {
      inner.push("lock");
      return [{ ok: 1 }];
    });
  });

  it("bounds the wait with lock_timeout, which the transaction timeout does not", async () => {
    await createJob({ userId: "u1", sourceKey: "uploads/u1/x.mp4" });

    const sql = tx.$executeRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toMatch(/^SET LOCAL lock_timeout = \d+$/);
    // LOCAL, so it dies with the transaction. A plain SET would ride the pooled
    // connection into the next unrelated request.
    expect(sql).toContain("SET LOCAL");
  });

  it("turns a lock timeout into a refusal the caller can render", async () => {
    tx.$queryRaw.mockRejectedValue(lockTimeout());

    const result = await createJob({ userId: "u1", sourceKey: "uploads/u1/x.mp4" });

    expect(result).toEqual({ status: "busy" });
    // Nothing was created and nothing was queued, so a retry is genuinely safe.
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("also refuses on P2028, the shape the bug actually produced", async () => {
    (prisma.$transaction as any).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Transaction already closed", {
        code: "P2028",
        clientVersion: "5.20.0",
      })
    );

    await expect(
      createJob({ userId: "u1", sourceKey: "uploads/u1/x.mp4" })
    ).resolves.toEqual({ status: "busy" });
  });

  it("still throws anything that is not contention", async () => {
    // A dead connection told to "try again in a moment" sends the user round a
    // loop that cannot end. Only the two contention codes are swallowed.
    tx.$queryRaw.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Server has closed the connection", {
        code: "P1017",
        clientVersion: "5.20.0",
      })
    );

    await expect(
      createJob({ userId: "u1", sourceKey: "uploads/u1/x.mp4" })
    ).rejects.toThrow();
  });

  it("does not swallow a P2002 from the reservation insert", async () => {
    // The unique index firing here means a cuid collided or something else is
    // writing rows - never a reason to tell the user to retry.
    tx.freeUsage.create.mockRejectedValue(p2002());

    await expect(
      createJob({
        userId: "u1",
        sourceKey: "uploads/u1/x.mp4",
        freeCharge: { seconds: 60, estimatedCostUsd: 0.042 },
      })
    ).rejects.toThrow();
  });
});

describe("createJob stores the source fingerprint", () => {
  beforeEach(() => {
    calls.length = 0;
    inner.length = 0;
    tx.job.create.mockReset();
    tx.job.create.mockResolvedValue({ id: "j1", userId: "u1" });
    tx.job.count.mockResolvedValue(0);
    tx.user.findUniqueOrThrow.mockResolvedValue({ plan: "NONE", billingCycle: null });
  });

  it("writes it on the row, and null when absent", async () => {
    await createJob({
      userId: "u1",
      sourceUrl: "https://youtu.be/dQw4w9WgXcQ",
      sourceFingerprint: "url:https://youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(tx.job.create.mock.calls[0][0].data.sourceFingerprint).toBe(
      "url:https://youtube.com/watch?v=dQw4w9WgXcQ"
    );

    tx.job.create.mockClear();
    await createJob({ userId: "u1", sourceKey: "uploads/x.mp4" });
    expect(tx.job.create.mock.calls[0][0].data.sourceFingerprint).toBeNull();
  });
});

describe("findDuplicateJob", () => {
  const FP = "url:https://youtube.com/watch?v=dQw4w9WgXcQ";
  const clip = (id: string) => ({
    id,
    title: `clip ${id}`,
    telegramFileId: `file-${id}`,
    storageKey: `clips/${id}.mp4`,
  });

  beforeEach(() => {
    jobFindMany.mockReset();
    jobFindMany.mockResolvedValue([]);
  });

  it("does not even query without a fingerprint", async () => {
    await expect(findDuplicateJob("u1", null)).resolves.toBeNull();
    await expect(findDuplicateJob("u1", undefined)).resolves.toBeNull();
    expect(jobFindMany).not.toHaveBeenCalled();
  });

  // The query shape is the test - a mocked prisma cannot tell a wrong where
  // from a right one, so it is asserted: this user's jobs with this key,
  // newest first, and only clips that are still in storage.
  it("asks for this user's jobs with this key, newest first, with live clips only", async () => {
    await findDuplicateJob("u1", FP);
    const arg = jobFindMany.mock.calls[0][0];
    expect(arg.where).toEqual({ userId: "u1", sourceFingerprint: FP });
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
    expect(arg.select.clips.where.deletedAt).toBeNull();
    expect(arg.select.clips.where.OR[0]).toEqual({ expiresAt: null });
    expect(arg.select.clips.where.OR[1].expiresAt.gt).toBeInstanceOf(Date);
  });

  it("reports a running job as active", async () => {
    jobFindMany.mockResolvedValue([
      { id: "j2", status: "TRANSCRIBING", createdAt: new Date(), clips: [] },
    ]);
    await expect(findDuplicateJob("u1", FP)).resolves.toMatchObject({
      kind: "active",
      job: { id: "j2" },
    });
  });

  it("reports a finished job with live clips as completed, with the clips", async () => {
    jobFindMany.mockResolvedValue([
      { id: "j3", status: "DONE", createdAt: new Date(), clips: [clip("a"), clip("b")] },
    ]);
    await expect(findDuplicateJob("u1", FP)).resolves.toMatchObject({
      kind: "completed",
      job: { id: "j3" },
      clips: [clip("a"), clip("b")],
    });
  });

  // The legitimate retries: a failed run, a run whose clips were swept, a run
  // that produced nothing. None of them may block a resend.
  it.each([
    ["FAILED", []],
    ["DONE", []],
  ])("lets a resend through after a %s job with %j clips", async (status, clips) => {
    jobFindMany.mockResolvedValue([{ id: "j4", status, createdAt: new Date(), clips }]);
    await expect(findDuplicateJob("u1", FP)).resolves.toBeNull();
  });

  // Newest decides: a fresh FAILED retry after an older DONE-with-clips is
  // still a duplicate of the DONE one (the clips exist), but a running job
  // outranks everything.
  it("walks candidates newest first and takes the first that qualifies", async () => {
    jobFindMany.mockResolvedValue([
      { id: "new-failed", status: "FAILED", createdAt: new Date(), clips: [] },
      { id: "old-done", status: "DONE", createdAt: new Date(0), clips: [clip("a")] },
    ]);
    await expect(findDuplicateJob("u1", FP)).resolves.toMatchObject({
      kind: "completed",
      job: { id: "old-done" },
    });
  });
});

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
    const where = (tx.job.count.mock.calls as any[])[0][0].where;
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
    // Mutation: drop the enqueuedAt:null term -> red.
    const posWhere = (tx.job.count.mock.calls as any[])[1][0].where;
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
    // Top-level prisma.job.update, distinct from tx.job.update above: the
    // stamp happens inside the transaction, but the un-stamp on a failed
    // enqueue happens after it, so it goes through the top-level client.
    jobUpdate.mockReset();
    jobUpdate.mockResolvedValue({});
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
    const where = (tx.job.count.mock.calls as any[])[0][0].where;
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

  // A stamped-but-never-added job is invisible to every other repair path:
  // it is no longer "waiting" (enqueuedAt is set) and it was never handed to
  // BullMQ. The function must un-stamp it and move on to the next job rather
  // than let one Redis hiccup take down the whole release - and, worse, abort
  // releaseStalledQueues' per-user loop for every user still to come.
  // Mutation: remove the per-job try/catch -> this test goes red (the
  // rejection propagates out of releaseNextQueued instead of being caught).
  it("un-stamps a job whose enqueue fails and never throws; the other still lands", async () => {
    tx.user.findUniqueOrThrow.mockResolvedValue({ plan: "PLUS", billingCycle: "MONTHLY" });
    tx.job.count.mockResolvedValueOnce(0); // 0 active, PLUS limit 2 -> 2 slots
    tx.job.findMany = vi.fn(async () => [
      { id: "q1", userId: "u1", createdAt: new Date(1) },
      { id: "q2", userId: "u1", createdAt: new Date(2) },
    ]);
    queueAdd.mockImplementationOnce(async () => {
      throw new Error("redis unreachable");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const released = await releaseNextQueued("u1");

    // q1's add rejected; q2's still landed. Only the successful one is
    // reported as released.
    expect(released.map((j) => j.id)).toEqual(["q2"]);
    expect(queueAdd).toHaveBeenCalledTimes(2);
    // The top-level client, not tx - the stamp was committed already, so
    // undoing it is a separate write after the transaction.
    expect(jobUpdate).toHaveBeenCalledWith({
      where: { id: "q1" },
      data: { enqueuedAt: null },
    });

    errorSpy.mockRestore();
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
    const staleBefore = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const countWheres = tx.job.count.mock.calls.map((c: any[]) => c[0].where);
    expect(countWheres.filter((w: any) => +w.updatedAt.gte === +staleBefore)).toHaveLength(2);
  });
});
