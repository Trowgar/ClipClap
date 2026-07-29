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

const tx = {
  job: { create: vi.fn() },
  freeUsage: { create: vi.fn() },
};

vi.mock("../../lib/prisma", () => ({
  prisma: {
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
import { createJob } from "../job.service";

const JOB = { id: "job_1", userId: "u1" };

describe("job.service createJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    tx.job.create.mockResolvedValue(JOB);
    tx.freeUsage.create.mockResolvedValue({});
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
