import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    freeUsage: {
      groupBy: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { prisma } from "../../lib/prisma";
import {
  freeBalanceSeconds,
  chargeFreeSeconds,
  refundFailedJob,
  refundZeroClipJob,
  trueUpFreeCost,
} from "../free-tier.service";
import { FREE_TIER } from "../../config/plans";

function ledger(charged: number, refunded: number) {
  (prisma.freeUsage.groupBy as any).mockResolvedValue([
    { kind: "CHARGE", _sum: { seconds: charged } },
    { kind: "REFUND", _sum: { seconds: refunded } },
  ]);
}

describe("free-tier.service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hands a fresh account the whole allowance", async () => {
    (prisma.freeUsage.groupBy as any).mockResolvedValue([]);
    expect(await freeBalanceSeconds("u1")).toBe(FREE_TIER.lifetimeSeconds);
  });

  it("subtracts charges and adds refunds back", async () => {
    ledger(1800, 600);
    expect(await freeBalanceSeconds("u1")).toBe(
      FREE_TIER.lifetimeSeconds - 1800 + 600
    );
  });

  it("never reports a negative balance", async () => {
    ledger(FREE_TIER.lifetimeSeconds + 5000, 0);
    expect(await freeBalanceSeconds("u1")).toBe(0);
  });

  it("writes a CHARGE row for the probed duration", async () => {
    (prisma.freeUsage.create as any).mockResolvedValue({});
    await chargeFreeSeconds("u1", "job1", 1234, 0.19);

    expect(prisma.freeUsage.create).toHaveBeenCalledWith({
      data: {
        userId: "u1",
        jobId: "job1",
        kind: "CHARGE",
        seconds: 1234,
        estimatedCostUsd: 0.19,
      },
    });
  });

  // Our own breakage must never consume a stranger's only look at the product,
  // so this refund has no cap.
  it("refunds a failed job in full, every time", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 1800,
      estimatedCostUsd: 0.28,
    });
    (prisma.freeUsage.count as any).mockResolvedValue(0);
    (prisma.freeUsage.create as any).mockResolvedValue({});

    await refundFailedJob("u1", "job1");

    expect(prisma.freeUsage.create).toHaveBeenCalledWith({
      data: {
        userId: "u1",
        jobId: "job1",
        kind: "REFUND",
        seconds: 1800,
        estimatedCostUsd: 0,
      },
    });
  });

  it("does not refund a failed job that was never charged", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue(null);
    await refundFailedJob("u1", "job1");
    expect(prisma.freeUsage.create).not.toHaveBeenCalled();
  });

  it("refunds the first zero-clip job", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 900,
      estimatedCostUsd: 0.14,
    });
    (prisma.freeUsage.count as any).mockResolvedValue(0);
    (prisma.freeUsage.create as any).mockResolvedValue({});

    const refunded = await refundZeroClipJob("u1", "job1");

    expect(refunded).toBe(true);
    expect(prisma.freeUsage.create).toHaveBeenCalledOnce();
  });

  it("refuses the second zero-clip refund on the same account", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 900,
      estimatedCostUsd: 0.14,
    });
    (prisma.freeUsage.count as any).mockResolvedValue(1);

    const refunded = await refundZeroClipJob("u1", "job2");

    expect(refunded).toBe(false);
    expect(prisma.freeUsage.create).not.toHaveBeenCalled();
  });

  // The regression test for the hole this whole table exists to close.
  it("computes the balance from the ledger, never from jobs", async () => {
    ledger(3600, 0);
    await freeBalanceSeconds("u1");

    const call = (prisma.freeUsage.groupBy as any).mock.calls[0][0];
    expect(call.where).toEqual({ userId: "u1" });
    expect(JSON.stringify(call)).not.toContain("job");
  });

  // ---------------------------------------------------------------------------
  // Query-shape pins.
  //
  // A mocked client returns whatever the mock was told to return, whatever the
  // query actually asked for. Every behavioural test above therefore stays green
  // through a wrong `by`, `_sum`, `select` or `where` - and the wrong version
  // is silently catastrophic in prod. These assert the query itself, because
  // nothing else in the suite can.
  // ---------------------------------------------------------------------------

  // Aggregate the wrong column (`_sum: { estimatedCostUsd: true }` is one
  // keystroke away) and `row._sum.seconds` is undefined for every row, `?? 0`
  // turns that into zero, and every account on the site reports a full untouched
  // allowance forever. Drop `by: ["kind"]` and charges and refunds collapse into
  // one bucket. Both survive all four balance tests above.
  it("aggregates seconds grouped by kind, scoped to the user", async () => {
    (prisma.freeUsage.groupBy as any).mockResolvedValue([]);
    await freeBalanceSeconds("u1");

    expect(prisma.freeUsage.groupBy).toHaveBeenCalledWith({
      by: ["kind"],
      where: { userId: "u1" },
      _sum: { seconds: true },
    });
  });

  // The CHARGE lookup has to be scoped three ways. Lose `kind: "CHARGE"` and a
  // retry reads back its own REFUND row as the thing to refund; lose `userId`
  // and one account can name another's jobId. Lose `seconds` from the select and
  // the refund row is written with `seconds: undefined`.
  it("looks up the charge by user, job and kind", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue(null);
    await refundFailedJob("u1", "job1");

    expect(prisma.freeUsage.findFirst).toHaveBeenCalledWith({
      where: { userId: "u1", jobId: "job1", kind: "CHARGE" },
      select: { seconds: true, estimatedCostUsd: true },
    });
  });

  // The idempotency guard. This is the only thing standing between a BullMQ
  // retry and a job refunded twice, so its `where` gets pinned: widen it and it
  // blocks legitimate refunds, narrow it and it blocks nothing.
  it("checks for an existing refund of this exact job", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 1800,
      estimatedCostUsd: 0.28,
    });
    (prisma.freeUsage.count as any).mockResolvedValue(1);

    await refundFailedJob("u1", "job1");

    expect(prisma.freeUsage.count).toHaveBeenCalledWith({
      where: { userId: "u1", jobId: "job1", kind: "REFUND" },
    });
    expect(prisma.freeUsage.create).not.toHaveBeenCalled();
  });

  // The account-wide forgiveness counter. It must NOT be scoped to this job -
  // scoping it to the job makes the cap per-job, which is no cap at all.
  it("counts zero-clip forgiveness across the whole account", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 900,
      estimatedCostUsd: 0.14,
    });
    (prisma.freeUsage.count as any).mockResolvedValue(0);
    (prisma.freeUsage.create as any).mockResolvedValue({});

    await refundZeroClipJob("u1", "job1");

    expect(prisma.freeUsage.count).toHaveBeenNthCalledWith(2, {
      where: { userId: "u1", kind: "REFUND", jobId: { not: null } },
    });
  });

  // Charging is a RESERVATION, taken before the job is enqueued. If it were
  // post-hoc, ten videos submitted at once would each see a full balance and all
  // ten would run. Nothing here may read the ledger first and decide.
  it("charges unconditionally, without consulting the ledger", async () => {
    (prisma.freeUsage.create as any).mockResolvedValue({});
    await chargeFreeSeconds("u1", "job1", 1234, 0.19);

    expect(prisma.freeUsage.groupBy).not.toHaveBeenCalled();
    expect(prisma.freeUsage.count).not.toHaveBeenCalled();
  });

  // A failed job is our fault, so the allowance comes back uncapped - the
  // forgiveness counter is checked by the zero-clip path only. Pin it: reusing
  // refundZeroClipJob's cap here would let one bad deploy end trials.
  it("refunds a failed job even after the forgiveness cap is spent", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 1800,
      estimatedCostUsd: 0.28,
    });
    // Zero for this job's idempotency check, but the account has already spent
    // its zero-clip forgiveness many times over.
    (prisma.freeUsage.count as any).mockResolvedValue(0);
    (prisma.freeUsage.create as any).mockResolvedValue({});

    await refundFailedJob("u1", "job9");

    expect(prisma.freeUsage.create).toHaveBeenCalledOnce();
    // One count call, not two: the account-wide cap query is not on this path.
    expect(prisma.freeUsage.count).toHaveBeenCalledOnce();
  });

  it("does not refund a zero-clip job that was never charged", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue(null);
    expect(await refundZeroClipJob("u1", "job1")).toBe(false);
    expect(prisma.freeUsage.create).not.toHaveBeenCalled();
  });

  it("does not refund the same zero-clip job twice", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 900,
      estimatedCostUsd: 0.14,
    });
    (prisma.freeUsage.count as any).mockResolvedValue(1);

    expect(await refundZeroClipJob("u1", "job1")).toBe(false);
    expect(prisma.freeUsage.create).not.toHaveBeenCalled();
  });

  // The refund gives back the ALLOWANCE, not the money. The dollars were really
  // spent - Whisper billed us for the transcript whether or not the run
  // delivered - so the refund row carries 0 and the monthly budget ceiling,
  // which sums estimatedCostUsd, still sees the true cost.
  it("returns seconds but no dollars", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 900,
      estimatedCostUsd: 0.14,
    });
    (prisma.freeUsage.count as any).mockResolvedValue(0);
    (prisma.freeUsage.create as any).mockResolvedValue({});

    await refundZeroClipJob("u1", "job1");

    const data = (prisma.freeUsage.create as any).mock.calls[0][0].data;
    expect(data.seconds).toBe(900);
    expect(data.estimatedCostUsd).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // trueUpFreeCost - what the monthly budget ceiling actually reads.
  // ---------------------------------------------------------------------------

  // Must target the CHARGE row and only the CHARGE row: the REFUND row for the
  // same job carries a deliberate 0, and overwriting it with the real cost would
  // cancel the charge out of the budget sum and make every failed job free.
  it("trues up only the CHARGE row for the job", async () => {
    (prisma.freeUsage.updateMany as any).mockResolvedValue({ count: 1 });
    await trueUpFreeCost("job1", 0.31);

    expect(prisma.freeUsage.updateMany).toHaveBeenCalledWith({
      where: { jobId: "job1", kind: "CHARGE" },
      data: { estimatedCostUsd: 0.31 },
    });
  });

  // It must not touch `seconds`. The probe estimate is what was reserved and
  // what the balance was computed from; only the money is being corrected.
  it("trues up the cost without moving the allowance", async () => {
    (prisma.freeUsage.updateMany as any).mockResolvedValue({ count: 1 });
    await trueUpFreeCost("job1", 0.31);

    const data = (prisma.freeUsage.updateMany as any).mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(["estimatedCostUsd"]);
  });

  // updateMany, not update: a paid-plan job has no ledger row at all, and
  // prisma.update throws on a missing record. The worker calls this on every
  // finalize, so a throw here would fail jobs that were never free.
  it("is a no-op for a job with no ledger row", async () => {
    (prisma.freeUsage.updateMany as any).mockResolvedValue({ count: 0 });
    await expect(trueUpFreeCost("paid-job", 0.31)).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Known-wrong behaviour, pinned deliberately.
  // ---------------------------------------------------------------------------

  // REPORTED BUG, pinned as-specified rather than silently fixed.
  //
  // The forgiveness counter matches `{ kind: "REFUND", jobId: { not: null } }`,
  // which is every refund row there is - including the ones refundFailedJob
  // writes. So an account whose first job FAILED has spent its zero-clip
  // forgiveness without ever seeing an empty result, and the uncapped
  // our-fault refund quietly turns into a capped one.
  //
  // The ledger cannot currently tell the two reasons apart: FreeUsageKind is
  // CHARGE|REFUND and there is no reason column. The fix is a schema change
  // (a third kind, REFUND_ZERO_CLIP, or a `reason` column) plus counting only
  // those rows here, and it belongs in a migration task, not this one.
  //
  // This test exists so the bug is visible in the suite instead of only in a
  // report nobody re-reads. Delete it when the schema can express the
  // distinction - do not delete it to make the suite quieter.
  it("BUG: lets a failed-job refund consume the zero-clip forgiveness", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 900,
      estimatedCostUsd: 0.14,
    });
    // First call: no REFUND for THIS job. Second call: one account-wide refund
    // row exists - the full refund of an earlier job that failed on our side.
    (prisma.freeUsage.count as any)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);

    expect(await refundZeroClipJob("u1", "job2")).toBe(false);
    expect(prisma.freeUsage.create).not.toHaveBeenCalled();
  });

  // Also reported: the balance is floored at 0 but not capped at the allowance.
  // Two concurrent finalizes of the same job both pass the idempotency check and
  // both write a full refund, and the account ends up with MORE free seconds
  // than the tier grants. The durable fix is a unique index on
  // (userId, jobId, kind), not arithmetic here.
  it("BUG: a double refund can push the balance above the allowance", async () => {
    ledger(1800, 3600);
    expect(await freeBalanceSeconds("u1")).toBeGreaterThan(
      FREE_TIER.lifetimeSeconds
    );
  });
});
