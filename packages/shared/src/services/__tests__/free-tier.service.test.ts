import { describe, it, expect, beforeEach, vi } from "vitest";
import { Prisma } from "@prisma/client";

/** The unique index on (userId, jobId, kind) rejecting a second refund. */
function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.20.0",
  });
}

/** A Prisma error that is NOT the duplicate we forgive. Same class, so an
 *  `instanceof` check that forgot to compare the code cannot tell it apart. */
function p2003(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Foreign key constraint", {
    code: "P2003",
    clientVersion: "5.20.0",
  });
}

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

  // The one shape the ledger() helper cannot produce, and the shape real
  // Postgres actually returns for almost every free account. groupBy OMITS a
  // kind that has no rows - it does not hand back _sum.seconds: null - so an
  // account that has been charged and never refunded yields a ONE-element
  // array and the REFUND branch never executes. What carries that case is the
  // `let refunded = 0` initialiser, not the `?? 0` beside it. Every other
  // balance test feeds both kinds and so has never exercised this.
  it("handles a ledger with charges and no refunds at all", async () => {
    (prisma.freeUsage.groupBy as any).mockResolvedValue([
      { kind: "CHARGE", _sum: { seconds: 1200 } },
    ]);
    expect(await freeBalanceSeconds("u1")).toBe(
      FREE_TIER.lifetimeSeconds - 1200
    );
  });

  // The mirror case, and the one that would silently grant a second allowance:
  // a REFUND-only ledger must not read as a full balance plus the refund.
  it("handles a ledger with refunds and no charges at all", async () => {
    (prisma.freeUsage.groupBy as any).mockResolvedValue([
      { kind: "REFUND", _sum: { seconds: 600 } },
    ]);
    expect(await freeBalanceSeconds("u1")).toBe(
      FREE_TIER.lifetimeSeconds + 600
    );
  });

  // groupBy returns _sum: null for an empty sum. Note this does NOT kill a
  // mutant that drops the `?? 0`: JavaScript coerces null to 0 in arithmetic,
  // so that operator is satisfying TypeScript, not guarding runtime. The test
  // stays because the OUTCOME is worth pinning whatever the mechanism, but the
  // `?? 0` is not what makes it pass - the initialisers are.
  it("treats a null sum as zero", async () => {
    (prisma.freeUsage.groupBy as any).mockResolvedValue([
      { kind: "CHARGE", _sum: { seconds: null } },
      { kind: "REFUND", _sum: { seconds: null } },
    ]);
    expect(await freeBalanceSeconds("u1")).toBe(FREE_TIER.lifetimeSeconds);
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

  // chargeFreeSeconds is the only one of these that runs on the submit path, so
  // an unhandled constraint error here is a 500 on a button press. The realistic
  // trigger is a retried submission whose reservation already landed, where the
  // post-condition the caller wanted - a CHARGE row for this job - already
  // holds. Swallow it and submit becomes idempotent.
  it("treats a duplicate reservation as a no-op", async () => {
    (prisma.freeUsage.create as any).mockRejectedValue(p2002());
    await expect(
      chargeFreeSeconds("u1", "job1", 1234, 0.19)
    ).resolves.toBeUndefined();
  });

  // The catch stays narrow here too: a real write failure must not be reported
  // as seconds successfully reserved, or the job runs against an allowance
  // nothing ever deducted.
  it("lets a non-P2002 charge failure surface", async () => {
    (prisma.freeUsage.create as any).mockRejectedValue(
      new Error("connection reset")
    );
    await expect(chargeFreeSeconds("u1", "job1", 1234, 0.19)).rejects.toThrow(
      "connection reset"
    );
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
        reason: "FAILED_JOB",
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
    expect((prisma.freeUsage.create as any).mock.calls[0][0].data.reason).toBe(
      "ZERO_CLIPS"
    );
  });

  // The two count calls must be stubbed separately. Returning 1 for both makes
  // this pass at the alreadyRefunded check instead - a different rule, already
  // covered below - and the cap is never exercised at all.
  it("refuses the second zero-clip refund on the same account", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 900,
      estimatedCostUsd: 0.14,
    });
    (prisma.freeUsage.count as any)
      .mockResolvedValueOnce(0) // no refund for THIS job yet
      .mockResolvedValueOnce(1); // but the account's forgiveness is spent

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

  // The account-wide forgiveness counter, and the single most delicate `where`
  // in the file. It must NOT be scoped to this job - that makes the cap per-job,
  // which is no cap at all. It must ALSO carry reason: "ZERO_CLIPS", or it
  // counts the uncapped refunds refundFailedJob writes and charges the user a
  // forgiveness for our own breakage.
  it("counts zero-clip forgiveness account-wide, by reason", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 900,
      estimatedCostUsd: 0.14,
    });
    (prisma.freeUsage.count as any).mockResolvedValue(0);
    (prisma.freeUsage.create as any).mockResolvedValue({});

    await refundZeroClipJob("u1", "job1");

    expect(prisma.freeUsage.count).toHaveBeenNthCalledWith(2, {
      where: { userId: "u1", kind: "REFUND", reason: "ZERO_CLIPS" },
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
  //
  // The userId matters too. jobId is a bare String with no foreign key, so
  // nothing in the database stops two users holding the same jobId string, and
  // an updateMany scoped to jobId alone rewrites both accounts' rows.
  it("trues up only the CHARGE row for this user's job", async () => {
    (prisma.freeUsage.updateMany as any).mockResolvedValue({ count: 1 });
    await trueUpFreeCost("u1", "job1", 0.31);

    expect(prisma.freeUsage.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", jobId: "job1", kind: "CHARGE" },
      data: { estimatedCostUsd: 0.31 },
    });
  });

  // It must not touch `seconds`. The probe estimate is what was reserved and
  // what the balance was computed from; only the money is being corrected.
  it("trues up the cost without moving the allowance", async () => {
    (prisma.freeUsage.updateMany as any).mockResolvedValue({ count: 1 });
    await trueUpFreeCost("u1", "job1", 0.31);

    const data = (prisma.freeUsage.updateMany as any).mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(["estimatedCostUsd"]);
  });

  // ---------------------------------------------------------------------------
  // The two defects the first draft of this service shipped with. Both are now
  // fixed in the schema rather than worked around here, so these assert the
  // corrected behaviour. They are the regression tests for that fix.
  // ---------------------------------------------------------------------------

  // Defect 1, fixed by FreeUsageReason.
  //
  // The forgiveness counter used to match every REFUND row on the account,
  // including the ones refundFailedJob writes. An account whose first job broke
  // on our side had therefore spent its zero-clip forgiveness without ever
  // seeing an empty result, which turned the deliberately uncapped our-fault
  // refund into a capped one.
  //
  // The count is now narrowed by reason, so a FAILED_JOB row is invisible to it.
  // Here the account has a failed-job refund on record and still gets its
  // forgiveness: the ZERO_CLIPS count is what the second stub answers, and it is
  // zero.
  it("does not let a failed-job refund consume the forgiveness", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 900,
      estimatedCostUsd: 0.14,
    });
    (prisma.freeUsage.count as any)
      .mockResolvedValueOnce(0) // no refund for THIS job
      .mockResolvedValueOnce(0); // no ZERO_CLIPS refund, despite an earlier
    // FAILED_JOB one existing on the account
    (prisma.freeUsage.create as any).mockResolvedValue({});

    expect(await refundZeroClipJob("u1", "job2")).toBe(true);
    expect(prisma.freeUsage.create).toHaveBeenCalledOnce();
  });

  // Defect 2, fixed by @@unique([userId, jobId, kind]).
  //
  // Two finalizes of one job could both pass the read-check and both insert,
  // leaving the account above the tier. The index now rejects the loser with
  // P2002, and the loser must conclude what its read-check would have: already
  // refunded. Anything else turns a benign race into a failed job.
  it("treats a P2002 on a failed-job refund as already refunded", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 1800,
      estimatedCostUsd: 0.28,
    });
    (prisma.freeUsage.count as any).mockResolvedValue(0);
    (prisma.freeUsage.create as any).mockRejectedValue(p2002());

    await expect(refundFailedJob("u1", "job1")).resolves.toBeUndefined();
  });

  it("treats a P2002 on a zero-clip refund as forgiveness not granted", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 900,
      estimatedCostUsd: 0.14,
    });
    (prisma.freeUsage.count as any).mockResolvedValue(0);
    (prisma.freeUsage.create as any).mockRejectedValue(p2002());

    // False, not true: the seconds are back, but this call is not what put them
    // there, and a caller that told the user "forgiveness spent" twice would be
    // lying once.
    expect(await refundZeroClipJob("u1", "job1")).toBe(false);
  });

  // The narrowness has to be tested with a PRISMA error, not a plain one.
  // A guard that checks `instanceof PrismaClientKnownRequestError` and forgets
  // `err.code === "P2002"` still rethrows a bare Error, so the plain-Error tests
  // above pass while every foreign-key and constraint failure is silently
  // reported as a refund granted. Only a same-class, different-code error can
  // catch that.
  it("lets a non-P2002 prisma error surface on every path", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 900,
      estimatedCostUsd: 0.14,
    });
    (prisma.freeUsage.count as any).mockResolvedValue(0);
    (prisma.freeUsage.create as any).mockRejectedValue(p2003());

    await expect(chargeFreeSeconds("u1", "j", 100, 0.1)).rejects.toThrow(
      "Foreign key constraint"
    );
    await expect(refundFailedJob("u1", "job1")).rejects.toThrow(
      "Foreign key constraint"
    );
    await expect(refundZeroClipJob("u1", "job1")).rejects.toThrow(
      "Foreign key constraint"
    );
  });

  // The P2002 catch must stay narrow. A dead connection or a constraint we have
  // not thought of has to surface, not be silently swallowed as a duplicate -
  // that would report a refund the user never received.
  it("lets a non-P2002 write failure surface", async () => {
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 900,
      estimatedCostUsd: 0.14,
    });
    (prisma.freeUsage.count as any).mockResolvedValue(0);
    (prisma.freeUsage.create as any).mockRejectedValue(
      new Error("connection reset")
    );

    await expect(refundFailedJob("u1", "job1")).rejects.toThrow(
      "connection reset"
    );
    await expect(refundZeroClipJob("u1", "job1")).rejects.toThrow(
      "connection reset"
    );
  });

  // The balance deliberately has no upper cap. A Math.min here would mask a
  // double write rather than prevent it, and the unique index is what prevents
  // it. This pins the absence: if a balance ever does exceed the allowance, the
  // ledger has rows it should not, and that must stay visible rather than being
  // quietly clamped away.
  it("does not clamp the balance to the allowance", async () => {
    ledger(1800, 3600);
    expect(await freeBalanceSeconds("u1")).toBe(
      FREE_TIER.lifetimeSeconds - 1800 + 3600
    );
  });
});
