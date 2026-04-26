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
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 270 * 60 } });

    const result = await canSubmitJob("u1", 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/limit/i);
  });

  it("canSubmitJob allows when over cap but top-up covers it", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 50,
      subscriptionStatus: "ACTIVE",
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 270 * 60 } });

    const result = await canSubmitJob("u1", 30);
    expect(result.allowed).toBe(true);
  });

  it("canSubmitJob blocks for NONE plan", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "NONE",
      subscriptionStatus: "NONE",
      topUpMinutesRemaining: 0,
    });

    const result = await canSubmitJob("u1", 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/subscription/i);
  });

  it("canSubmitJob blocks during DUNNING", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "PLUS",
      billingCycle: "MONTHLY",
      subscriptionStatus: "DUNNING",
      topUpMinutesRemaining: 0,
    });

    const result = await canSubmitJob("u1", 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/payment/i);
  });

  it("canSubmitJob blocks during CANCELED_GRACE (read-only)", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "PLUS",
      billingCycle: "MONTHLY",
      subscriptionStatus: "CANCELED_GRACE",
      topUpMinutesRemaining: 0,
    });

    const result = await canSubmitJob("u1", 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/canceled|grace/i);
  });
});
