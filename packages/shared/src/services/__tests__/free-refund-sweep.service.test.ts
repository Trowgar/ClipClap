import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    freeUsage: {
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { prisma } from "../../lib/prisma";
import {
  REFUND_SWEEP_PAGE_SIZE,
  REFUND_SWEEP_SILENCE_HOURS,
  refundSweepCutoff,
  runFreeRefundSweep,
} from "../free-refund-sweep.service";

/** The tagged-template call reassembled, so a test can assert on the SQL the
 *  service actually sends rather than on a mock's shape. */
function lastSql(): string {
  const call = (prisma.$queryRaw as any).mock.calls.at(-1);
  const strings: string[] = call[0];
  return strings.join(" ? ").replace(/\s+/g, " ");
}

function lastValues(): unknown[] {
  return (prisma.$queryRaw as any).mock.calls.at(-1).slice(1);
}

const NOW = new Date("2026-07-29T18:00:00.000Z");

describe("free refund sweep", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.FREE_REFUND_SWEEP_DISABLED;
    (prisma.$queryRaw as any).mockResolvedValue([]);
    // a charge exists, nothing refunded yet - the state every candidate is in
    (prisma.freeUsage.findFirst as any).mockResolvedValue({
      seconds: 600,
      estimatedCostUsd: 0.095,
    });
    (prisma.freeUsage.count as any).mockResolvedValue(0);
    (prisma.freeUsage.create as any).mockResolvedValue({});
  });

  // -------------------------------------------------------------------------
  // The cutoff
  // -------------------------------------------------------------------------

  it("calls a job dead after six hours of complete silence", () => {
    expect(REFUND_SWEEP_SILENCE_HOURS).toBe(6);
    expect(refundSweepCutoff(NOW).toISOString()).toBe(
      "2026-07-29T12:00:00.000Z"
    );
  });

  // -------------------------------------------------------------------------
  // The selector. Every clause here is load-bearing and none is decoration.
  // -------------------------------------------------------------------------

  it("asks for charges whose job is FAILED, silent and unrefunded", async () => {
    await runFreeRefundSweep(NOW);
    const sql = lastSql();

    expect(sql).toContain("FROM free_usage f");
    expect(sql).toContain("JOIN jobs j ON j.id = f.\"jobId\"");
    // The ledger row IS the free-tier fact - never user.plan, which is mutable
    // and would strand the allowance of anyone who upgraded after a failure.
    expect(sql).toContain("f.kind = 'CHARGE'");
    expect(sql).toContain("j.status = 'FAILED'");
    // Not "has a refund row" filtered in JS afterwards: the NOT EXISTS is what
    // makes the selector self-draining, and therefore what makes the LIMIT
    // safe.
    expect(sql).toContain("FROM free_usage r");
    expect(sql).toContain("r.kind = 'REFUND'");
    // Status alone is not terminality: FAILED is written on every attempt, so
    // the silence of the job's step rows is the real condition.
    expect(sql).toContain("FROM job_steps s");
    expect(sql).toContain("ORDER BY j.\"createdAt\" ASC");
  });

  it("sends the six-hour cutoff and the page size as bound values", async () => {
    await runFreeRefundSweep(NOW);

    expect(lastValues()).toEqual([
      refundSweepCutoff(NOW),
      refundSweepCutoff(NOW),
      REFUND_SWEEP_PAGE_SIZE,
    ]);
  });

  // -------------------------------------------------------------------------
  // The killswitch, which points the opposite way to the retention sweep's
  // -------------------------------------------------------------------------

  it("runs when the killswitch is unset, empty or absent", async () => {
    for (const value of [undefined, ""]) {
      vi.clearAllMocks();
      (prisma.$queryRaw as any).mockResolvedValue([]);
      if (value === undefined) delete process.env.FREE_REFUND_SWEEP_DISABLED;
      else process.env.FREE_REFUND_SWEEP_DISABLED = value;

      const result = await runFreeRefundSweep(NOW);

      expect(result.disabled).toBe(false);
      expect(prisma.$queryRaw).toHaveBeenCalled();
    }
    delete process.env.FREE_REFUND_SWEEP_DISABLED;
  });

  it("stops, and complains, only when the killswitch is explicitly set", async () => {
    process.env.FREE_REFUND_SWEEP_DISABLED = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runFreeRefundSweep(NOW);

    expect(result).toEqual({ refunded: 0, failed: 0, disabled: true });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    // Switched off silently is the failure mode that costs users money they
    // never hear about, so being off is itself a warning.
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "FREE_REFUND_SWEEP_DISABLED"
    );
    warn.mockRestore();
    delete process.env.FREE_REFUND_SWEEP_DISABLED;
  });

  // -------------------------------------------------------------------------
  // Settling
  // -------------------------------------------------------------------------

  it("refunds every candidate and says so in one greppable line each", async () => {
    (prisma.$queryRaw as any).mockResolvedValue([
      { userId: "u1", jobId: "j1", seconds: 600 },
      { userId: "u2", jobId: "j2", seconds: 900 },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await runFreeRefundSweep(NOW);

    expect(result).toMatchObject({ refunded: 2, failed: 0 });
    expect(prisma.freeUsage.create).toHaveBeenCalledTimes(2);
    expect((prisma.freeUsage.create as any).mock.calls[0][0].data).toMatchObject(
      { userId: "u1", jobId: "j1", kind: "REFUND", reason: "FAILED_JOB" }
    );
    // The three things anyone answering "why did this account get its
    // allowance back" needs: which job, whose, and how much.
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain("[free-refund]");
    expect(line).toContain("600s");
    expect(line).toContain("u1");
    expect(line).toContain("j1");
    log.mockRestore();
  });

  it("keeps going when one candidate throws, and leaves it for next hour", async () => {
    (prisma.$queryRaw as any).mockResolvedValue([
      { userId: "u1", jobId: "j1", seconds: 600 },
      { userId: "u2", jobId: "j2", seconds: 900 },
    ]);
    (prisma.freeUsage.create as any)
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue({});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await runFreeRefundSweep(NOW);

    expect(result).toMatchObject({ refunded: 1, failed: 1 });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    log.mockRestore();
  });

  it("is a silent no-op on an empty ledger", async () => {
    (prisma.$queryRaw as any).mockResolvedValue([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runFreeRefundSweep(NOW)).resolves.toEqual({
      refunded: 0,
      failed: 0,
      disabled: false,
    });

    // This runs hourly for ever and the usual answer is zero. A line an hour
    // that always says nothing happened is how a line that matters gets
    // scrolled past.
    expect(log).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    log.mockRestore();
    errors.mockRestore();
  });

  it("writes nothing for a job whose refund already exists", async () => {
    // The selector should never hand this row over, but refundFailedJob's own
    // read-check is the second lock and the unique index is the third. Prove
    // the sweep inherits both rather than assuming the query is the only guard.
    (prisma.$queryRaw as any).mockResolvedValue([
      { userId: "u1", jobId: "j1", seconds: 600 },
    ]);
    (prisma.freeUsage.count as any).mockResolvedValue(1);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runFreeRefundSweep(NOW);

    expect(prisma.freeUsage.create).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
