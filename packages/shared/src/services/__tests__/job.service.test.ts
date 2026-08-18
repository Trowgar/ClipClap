import { describe, it, expect, beforeEach, vi } from "vitest";
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

vi.mock("../../lib/prisma", () => ({
  prisma: {
    job: { findMany: (...args: unknown[]) => jobFindMany(...args) },
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
import { createJob, findDuplicateJob } from "../job.service";

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
    expect(queueAdd.mock.calls[0][2]).toBeUndefined();
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
