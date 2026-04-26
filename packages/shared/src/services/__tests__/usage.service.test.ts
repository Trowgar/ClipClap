import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: { findUniqueOrThrow: vi.fn() },
    job: { aggregate: vi.fn() },
  },
}));

import { prisma } from "../../lib/prisma";
import {
  getMinutesUsedInPeriod,
  getUsageForUser,
  canSubmitJob,
} from "../usage.service";

describe("usage.service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getMinutesUsedInPeriod sums source durations in window", async () => {
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 1800 } });
    const minutes = await getMinutesUsedInPeriod("u1", new Date(), new Date());
    expect(minutes).toBe(30);
  });

  it("getMinutesUsedInPeriod returns 0 when no jobs", async () => {
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: null } });
    const minutes = await getMinutesUsedInPeriod("u1", new Date(), new Date());
    expect(minutes).toBe(0);
  });

  it("getUsageForUser returns plan limits and usage for STARTER monthly", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 1800 } });

    const usage = await getUsageForUser("u1");
    expect(usage.plan).toBe("STARTER");
    expect(usage.minutesUsed).toBe(30);
    expect(usage.minutesLimit).toBe(270);
    expect(usage.topUpMinutesRemaining).toBe(0);
  });

  it("canSubmitJob blocks when over period cap and no top-up", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 0,
      subscriptionStatus: "ACTIVE",
      currentPeriodEnd: null,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 270 * 60 } });

    const result = await canSubmitJob("u1", 10);
    expect(result).toEqual(
      expect.objectContaining({ allowed: false, reason: expect.stringMatching(/limit/i) })
    );
  });

  it("canSubmitJob allows when over cap but top-up covers it", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 50,
      subscriptionStatus: "ACTIVE",
      currentPeriodEnd: null,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 270 * 60 } });

    const result = await canSubmitJob("u1", 30);
    expect(result).toEqual({ allowed: true });
  });

  it("canSubmitJob blocks for NONE plan", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "NONE",
      subscriptionStatus: "NONE",
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
    });

    const result = await canSubmitJob("u1", 10);
    expect(result).toEqual(
      expect.objectContaining({ allowed: false, reason: expect.stringMatching(/subscription/i) })
    );
  });

  it("canSubmitJob blocks during DUNNING", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "PLUS",
      billingCycle: "MONTHLY",
      subscriptionStatus: "DUNNING",
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
    });

    const result = await canSubmitJob("u1", 10);
    expect(result).toEqual(
      expect.objectContaining({ allowed: false, reason: expect.stringMatching(/payment/i) })
    );
  });

  it("canSubmitJob blocks during CANCELED_GRACE (read-only)", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "PLUS",
      billingCycle: "MONTHLY",
      subscriptionStatus: "CANCELED_GRACE",
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
    });

    const result = await canSubmitJob("u1", 10);
    expect(result).toEqual(
      expect.objectContaining({ allowed: false, reason: expect.stringMatching(/canceled|grace/i) })
    );
  });

  it("canSubmitJob anchors period to currentPeriodEnd when present", async () => {
    const futureEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      subscriptionStatus: "ACTIVE",
      topUpMinutesRemaining: 0,
      currentPeriodEnd: futureEnd,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 60 * 60 } });

    await canSubmitJob("u1", 10);

    const aggregateCall = (prisma.job.aggregate as any).mock.calls[0][0];
    const periodStart = aggregateCall.where.createdAt.gte as Date;
    const periodEnd = aggregateCall.where.createdAt.lte as Date;
    const expectedStart = new Date(futureEnd);
    expectedStart.setDate(expectedStart.getDate() - 30);
    expect(periodStart.getTime()).toBe(expectedStart.getTime());
    expect(periodEnd.getTime()).toBeGreaterThanOrEqual(Date.now() - 1000);
  });
});
