import { describe, it, expect, beforeEach, vi } from "vitest";
import { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "../../config/billing";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: { findUniqueOrThrow: vi.fn() },
    job: { aggregate: vi.fn() },
    clip: { count: vi.fn() },
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

  it("getUsageForUser includes clipsStored, retentionDays, currentPeriodEnd, clipsTotal", async () => {
    const periodEnd = new Date("2026-06-24T00:00:00Z");
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 100,
      currentPeriodEnd: periodEnd,
    });
    (prisma.job.aggregate as any).mockResolvedValue({
      _sum: { sourceDurationSec: 2700 },
    });
    (prisma.clip.count as any)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(42);

    const usage = await getUsageForUser("u1");

    expect(usage.clipsStored).toBe(8);
    expect(usage.clipsTotal).toBe(42);
    expect(usage.retentionDays).toBe(7);
    expect(usage.currentPeriodEnd).toEqual(periodEnd);
    expect(usage.topUpMinutesRemaining).toBe(100);
  });

  it("getUsageForUser queries clipsStored with deletedAt: null filter", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
    (prisma.clip.count as any).mockResolvedValue(0);

    await getUsageForUser("u1");

    const calls = (prisma.clip.count as any).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][0]).toEqual({ where: { userId: "u1", deletedAt: null } });
    expect(calls[1][0]).toEqual({ where: { userId: "u1" } });
  });

  it("getUsageForUser returns zero/null defaults for NONE plan", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "NONE",
      billingCycle: null,
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
    });
    (prisma.clip.count as any).mockResolvedValueOnce(0).mockResolvedValueOnce(3);

    const usage = await getUsageForUser("u1");

    expect(usage.plan).toBe("NONE");
    expect(usage.minutesUsed).toBe(0);
    expect(usage.minutesLimit).toBe(0);
    expect(usage.storageClipsLimit).toBe(0);
    expect(usage.retentionDays).toBe(0);
    expect(usage.currentPeriodEnd).toBeNull();
    expect(usage.clipsStored).toBe(0);
    expect(usage.clipsTotal).toBe(3);
  });

  it("getUsageForUser reports paymentProvider 'tribute' when tributeSubscriptionId is set", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "MAX",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
      tributeSubscriptionId: "sub_trib_1",
      stripeSubscriptionId: null,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
    (prisma.clip.count as any).mockResolvedValue(0);

    const usage = await getUsageForUser("u1");
    expect(usage.paymentProvider).toBe("tribute");
  });

  it("getUsageForUser reports paymentProvider 'stripe' when stripeSubscriptionId is set", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "MAX",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
      tributeSubscriptionId: null,
      stripeSubscriptionId: "sub_stripe_1",
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
    (prisma.clip.count as any).mockResolvedValue(0);

    const usage = await getUsageForUser("u1");
    expect(usage.paymentProvider).toBe("stripe");
  });

  it("getUsageForUser reports paymentProvider null when neither subscription id is set", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "NONE",
      billingCycle: null,
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
      tributeSubscriptionId: null,
      stripeSubscriptionId: null,
    });
    (prisma.clip.count as any).mockResolvedValue(0);

    const usage = await getUsageForUser("u1");
    expect(usage.paymentProvider).toBeNull();
  });

  it("canSubmitJob blocks when over period cap and no top-up", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 0,
      subscriptionStatus: "ACTIVE",
      currentPeriodStart: null,
      currentPeriodEnd: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
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
      currentPeriodStart: null,
      currentPeriodEnd: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
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

  it("canSubmitJob blocks DUNNING once period has lapsed past grace", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "PLUS",
      billingCycle: "MONTHLY",
      subscriptionStatus: "DUNNING",
      topUpMinutesRemaining: 0,
      currentPeriodStart: null,
      currentPeriodEnd: new Date(
        Date.now() - (SUBSCRIPTION_GRACE_BUFFER_DAYS + 1) * 24 * 60 * 60 * 1000
      ),
    });

    const result = await canSubmitJob("u1", 10);
    expect(result).toEqual(
      expect.objectContaining({ allowed: false, reason: expect.stringMatching(/ended|period/i) })
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

  it("canSubmitJob anchors period to currentPeriodEnd when present (no stored start)", async () => {
    const futureEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      subscriptionStatus: "ACTIVE",
      topUpMinutesRemaining: 0,
      currentPeriodStart: null,
      currentPeriodEnd: futureEnd,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 60 * 60 } });

    await canSubmitJob("u1", 10);

    const aggregateCall = (prisma.job.aggregate as any).mock.calls[0][0];
    const periodStart = aggregateCall.where.createdAt.gte as Date;
    const periodEnd = aggregateCall.where.createdAt.lte as Date;
    const expectedStart = new Date(futureEnd);
    expectedStart.setMonth(expectedStart.getMonth() - 1);
    expect(periodStart.getTime()).toBe(expectedStart.getTime());
    expect(periodEnd.getTime()).toBeGreaterThanOrEqual(Date.now() - 1000);
  });
});

describe("canSubmitJob grace + period logic", () => {
  beforeEach(() => vi.clearAllMocks());

  const DAY = 24 * 60 * 60 * 1000;

  function mockUser(overrides: Record<string, unknown>) {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      subscriptionStatus: "ACTIVE",
      topUpMinutesRemaining: 0,
      currentPeriodStart: null,
      currentPeriodEnd: new Date(Date.now() + 5 * DAY),
      ...overrides,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
  }

  it("blocks NONE plan", async () => {
    mockUser({ plan: "NONE", subscriptionStatus: "NONE" });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(false);
  });

  it("blocks CANCELED_GRACE even within period", async () => {
    mockUser({ subscriptionStatus: "CANCELED_GRACE" });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(false);
  });

  it("allows ACTIVE within period", async () => {
    mockUser({ subscriptionStatus: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 2 * DAY) });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(true);
  });

  it("allows DUNNING while within grace (period ended < grace ago)", async () => {
    mockUser({
      subscriptionStatus: "DUNNING",
      currentPeriodEnd: new Date(Date.now() - 1 * DAY),
    });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(true);
  });

  it("blocks DUNNING after grace has elapsed", async () => {
    mockUser({
      subscriptionStatus: "DUNNING",
      currentPeriodEnd: new Date(Date.now() - (SUBSCRIPTION_GRACE_BUFFER_DAYS + 1) * DAY),
    });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(false);
  });

  it("blocks ACTIVE whose period ended past grace (missed renewal)", async () => {
    mockUser({
      subscriptionStatus: "ACTIVE",
      currentPeriodEnd: new Date(Date.now() - (SUBSCRIPTION_GRACE_BUFFER_DAYS + 1) * DAY),
    });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(false);
  });

  it("blocks DUNNING/ACTIVE exactly at the grace boundary (half-open interval)", async () => {
    mockUser({
      subscriptionStatus: "DUNNING",
      currentPeriodEnd: new Date(Date.now() - SUBSCRIPTION_GRACE_BUFFER_DAYS * DAY),
    });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(false);
  });

  it("blocks ACTIVE with null currentPeriodEnd", async () => {
    mockUser({ subscriptionStatus: "ACTIVE", currentPeriodEnd: null });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(false);
  });

  it("blocks over-quota user (presign-style duration 0)", async () => {
    mockUser({ subscriptionStatus: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 2 * DAY) });
    // STARTER MONTHLY limit is 270 min; simulate 300 used.
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 300 * 60 } });
    const res = await canSubmitJob("u1", 0);
    expect(res.allowed).toBe(false);
  });

  it("allows exactly-at-limit user with duration 0 (presign)", async () => {
    mockUser({ subscriptionStatus: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 2 * DAY) });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 270 * 60 } });
    const res = await canSubmitJob("u1", 0);
    expect(res.allowed).toBe(true);
  });
});

describe("getPeriodStart via getUsageForUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses stored currentPeriodStart when present", async () => {
    const start = new Date("2026-04-30T00:00:00Z");
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      subscriptionStatus: "ACTIVE",
      topUpMinutesRemaining: 0,
      currentPeriodStart: start,
      currentPeriodEnd: new Date("2026-05-30T00:00:00Z"),
      stripeSubscriptionId: "sub_1",
      tributeSubscriptionId: null,
    });
    (prisma.clip.count as any).mockResolvedValue(0);
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 0 } });

    await getUsageForUser("u1");

    // The aggregate window must start at the stored period start.
    const aggArgs = (prisma.job.aggregate as any).mock.calls[0][0];
    expect(aggArgs.where.createdAt.gte).toEqual(start);
  });
});
