import { describe, it, expect, beforeEach, vi } from "vitest";
import { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "../../config/billing";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: { findUniqueOrThrow: vi.fn() },
    job: { aggregate: vi.fn(), count: vi.fn() },
    clip: { count: vi.fn() },
  },
}));

import { prisma } from "../../lib/prisma";
import {
  getMinutesUsedInPeriod,
  getUsageForUser,
  canSubmitJob,
  getFreeTrialStatus,
} from "../usage.service";
import { FREE_TIER, getPlanLimits } from "../../config/plans";

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

  it("getUsageForUser reports the free allowance for NONE plan", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "NONE",
      billingCycle: null,
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
    });
    (prisma.clip.count as any).mockResolvedValueOnce(0).mockResolvedValueOnce(3);
    (prisma.job.count as any).mockResolvedValue(0);

    const usage = await getUsageForUser("u1");
    const free = getPlanLimits("NONE");

    expect(usage.plan).toBe("NONE");
    expect(usage.minutesUsed).toBe(0);
    expect(usage.minutesLimit).toBe(free.minutesPerPeriod);
    expect(usage.storageClipsLimit).toBe(free.storageClips);
    expect(usage.retentionDays).toBe(free.retentionDays);
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

  it("canSubmitJob blocks a NONE plan whose free run is already spent", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "NONE",
      subscriptionStatus: "NONE",
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
    });
    (prisma.job.count as any).mockResolvedValue(FREE_TIER.runs);

    const result = await canSubmitJob("u1", 10);
    expect(result).toEqual(
      expect.objectContaining({ allowed: false, code: "FREE_TRIAL_USED" })
    );
  });

  it("getUsageForUser reports subscriptionState PERIOD_ENDED for a lapsed ACTIVE plan", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "MAX",
      billingCycle: "MONTHLY",
      subscriptionStatus: "ACTIVE",
      topUpMinutesRemaining: 0,
      currentPeriodStart: null,
      currentPeriodEnd: new Date(
        Date.now() - (SUBSCRIPTION_GRACE_BUFFER_DAYS + 5) * 24 * 60 * 60 * 1000
      ),
      tributeSubscriptionId: null,
      stripeSubscriptionId: null,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
    (prisma.clip.count as any).mockResolvedValue(0);

    const usage = await getUsageForUser("u1");
    expect(usage.subscriptionState).toEqual({ phase: "PERIOD_ENDED", live: false });
  });

  it("getUsageForUser reports subscriptionState ACTIVE for a live plan", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "MAX",
      billingCycle: "MONTHLY",
      subscriptionStatus: "ACTIVE",
      topUpMinutesRemaining: 0,
      currentPeriodStart: null,
      currentPeriodEnd: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      tributeSubscriptionId: null,
      stripeSubscriptionId: null,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
    (prisma.clip.count as any).mockResolvedValue(0);

    const usage = await getUsageForUser("u1");
    expect(usage.subscriptionState).toEqual({ phase: "ACTIVE", live: true });
  });

  it("getUsageForUser reports subscriptionState NONE for NONE plan", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "NONE",
      billingCycle: null,
      subscriptionStatus: "NONE",
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
      tributeSubscriptionId: null,
      stripeSubscriptionId: null,
    });
    (prisma.clip.count as any).mockResolvedValue(0);

    const usage = await getUsageForUser("u1");
    expect(usage.subscriptionState).toEqual({ phase: "NONE", live: false });
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

  // NONE is no longer a flat refusal - it routes to the free-trial gate, which
  // decides on lifetime run/attempt counts rather than on the plan alone.
  it("blocks NONE plan once the free run is spent", async () => {
    mockUser({ plan: "NONE", subscriptionStatus: "NONE" });
    (prisma.job.count as any).mockResolvedValue(FREE_TIER.runs);
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

/**
 * The free allowance is what lets a brand-new account see one real result
 * before paying. It is deliberately LIFETIME, not per-period: a monthly free
 * tier renews forever and can be farmed, and the goal here is "prove the
 * product once", not "run a free service".
 *
 * "Lifetime" is why these counts cannot go through getMinutesUsedInPeriod -
 * that function only ever answers "how much inside this window". The trial
 * gate therefore uses unwindowed job counts, and these tests pin that: a query
 * that grows a createdAt filter would silently turn the trial into a
 * renewable one, so the absence of that filter is asserted, not assumed.
 */
describe("free trial allowance", () => {
  beforeEach(() => vi.clearAllMocks());

  const DAY = 24 * 60 * 60 * 1000;

  function mockFreeUser(overrides: Record<string, unknown> = {}) {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "NONE",
      billingCycle: null,
      subscriptionStatus: "NONE",
      topUpMinutesRemaining: 0,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      ...overrides,
    });
    (prisma.job.aggregate as any).mockResolvedValue({
      _sum: { sourceDurationSec: 0 },
    });
  }

  /** getFreeTrialStatus issues [runs, attempts] in that order. */
  function mockCounts(runs: number, attempts: number) {
    (prisma.job.count as any)
      .mockResolvedValueOnce(runs)
      .mockResolvedValueOnce(attempts);
  }

  it("counts runs and attempts over the whole lifetime, with no date window", async () => {
    mockCounts(0, 2);

    const status = await getFreeTrialStatus("u1");

    expect(status.runsUsed).toBe(0);
    expect(status.attemptsUsed).toBe(2);
    expect(status.runsLimit).toBe(FREE_TIER.runs);
    expect(status.attemptsLimit).toBe(FREE_TIER.attempts);

    const [runsQuery, attemptsQuery] = (prisma.job.count as any).mock.calls.map(
      (c: any[]) => c[0]
    );
    // A createdAt filter here would make the allowance renewable.
    expect(runsQuery.where.createdAt).toBeUndefined();
    expect(attemptsQuery.where.createdAt).toBeUndefined();
    // A run is a job that actually produced clips.
    expect(runsQuery.where.clipsGenerated).toEqual({ gt: 0 });
  });

  it("lets a brand-new NONE user submit inside the allowance", async () => {
    mockFreeUser();
    mockCounts(0, 0);

    const res = await canSubmitJob("u1", 12);

    expect(res.allowed).toBe(true);
  });

  it("blocks the same user once a run has produced clips", async () => {
    mockFreeUser();
    mockCounts(FREE_TIER.runs, FREE_TIER.runs);

    const res = await canSubmitJob("u1", 12);

    expect(res.allowed).toBe(false);
    if (res.allowed) throw new Error("unreachable");
    expect(res.code).toBe("FREE_TRIAL_USED");
    // The copy has to state what was used and what a plan gives, not just
    // "subscription required".
    expect(res.reason).toMatch(/free/i);
  });

  /**
   * A run that produced nothing must not burn the trial. The product's own
   * failure copy already promises minutes are not spent when nothing comes
   * back, and the market leader auto-refunds a "No Clips Rendered" project -
   * a trial that charges for an empty result teaches the new user exactly the
   * wrong thing about the product on their only look at it.
   */
  it("does not burn the trial on a run that produced no clips", async () => {
    mockFreeUser();
    mockCounts(0, 1);

    const res = await canSubmitJob("u1", 12);

    expect(res.allowed).toBe(true);
  });

  /**
   * ...but empty runs are not free to US - each one pays for a transcript.
   * The attempt backstop is what bounds that, since the run counter alone
   * would let a user submit unclippable video forever.
   */
  it("blocks once the lifetime attempt backstop is reached, even with no clips ever made", async () => {
    mockFreeUser();
    mockCounts(0, FREE_TIER.attempts);

    const res = await canSubmitJob("u1", 12);

    expect(res.allowed).toBe(false);
    if (res.allowed) throw new Error("unreachable");
    expect(res.code).toBe("FREE_TRIAL_ATTEMPTS");
  });

  it("does not count FAILED jobs as attempts", async () => {
    mockCounts(0, 0);
    await getFreeTrialStatus("u1");
    const attemptsQuery = (prisma.job.count as any).mock.calls[1][0];
    // A user whose link died three times has seen nothing; locking them out
    // for our own failures is the opposite of a trial.
    expect(attemptsQuery.where.status).toEqual({ not: "FAILED" });
  });

  it("refuses a source longer than the free maximum with a reason that names the cap", async () => {
    mockFreeUser();
    mockCounts(0, 0);
    const freeCap = getPlanLimits("NONE").maxSourceDurationMinutes;

    const res = await canSubmitJob("u1", freeCap + 1);

    expect(res.allowed).toBe(false);
    if (res.allowed) throw new Error("unreachable");
    expect(res.code).toBe("FREE_SOURCE_TOO_LONG");
    expect(res.reason).toContain(String(freeCap));
  });

  it("allows a source exactly at the free maximum", async () => {
    mockFreeUser();
    mockCounts(0, 0);
    const freeCap = getPlanLimits("NONE").maxSourceDurationMinutes;

    const res = await canSubmitJob("u1", freeCap);

    expect(res.allowed).toBe(true);
  });

  // The too-long refusal must win over the exhausted one: telling someone the
  // trial is spent when the real problem is a 3-hour file sends them to buy a
  // plan for the wrong reason.
  it("reports the duration problem, not the trial state, when both apply", async () => {
    mockFreeUser();
    mockCounts(FREE_TIER.runs, FREE_TIER.attempts);
    const freeCap = getPlanLimits("NONE").maxSourceDurationMinutes;

    const res = await canSubmitJob("u1", freeCap + 60);

    expect(res.allowed).toBe(false);
    if (res.allowed) throw new Error("unreachable");
    expect(res.code).toBe("FREE_SOURCE_TOO_LONG");
  });

  it("leaves a paying subscriber untouched by the trial gate", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      subscriptionStatus: "ACTIVE",
      topUpMinutesRemaining: 0,
      currentPeriodStart: null,
      currentPeriodEnd: new Date(Date.now() + 5 * DAY),
    });
    (prisma.job.aggregate as any).mockResolvedValue({
      _sum: { sourceDurationSec: 0 },
    });

    // 120 min is over the free cap and fine on STARTER.
    const res = await canSubmitJob("u1", 120);

    expect(res.allowed).toBe(true);
    // The trial counters must not even be consulted for a paying user.
    expect((prisma.job.count as any).mock.calls).toHaveLength(0);
  });

  /**
   * A trial is for people who have never paid. Someone who subscribed and
   * canceled must get the lifecycle message and the resubscribe path, not a
   * fresh free run - otherwise cancel/resubscribe is a renewable free tier.
   */
  it("does not hand a free run to a canceled ex-subscriber", async () => {
    mockFreeUser({ plan: "NONE", subscriptionStatus: "CANCELED" });
    mockCounts(0, 0);

    const res = await canSubmitJob("u1", 5);

    expect(res.allowed).toBe(false);
    if (res.allowed) throw new Error("unreachable");
    // The lifecycle path, not the trial path. (Which lifecycle sentence they
    // get is decided by getSubscriptionState, which collapses to phase NONE
    // once plan is NONE - pre-existing behaviour, not this gate's business.)
    expect(res.code).toBe("LIFECYCLE");
    // The decisive part: the trial counters were never even consulted, so no
    // free run was handed out.
    expect((prisma.job.count as any).mock.calls).toHaveLength(0);
  });

  it("getUsageForUser reports the real free limits, not zeros", async () => {
    mockFreeUser();
    (prisma.clip.count as any).mockResolvedValue(0);
    mockCounts(0, 0);

    const usage = await getUsageForUser("u1");
    const free = getPlanLimits("NONE");

    expect(usage.plan).toBe("NONE");
    expect(usage.minutesLimit).toBe(free.minutesPerPeriod);
    expect(usage.storageClipsLimit).toBe(free.storageClips);
    expect(usage.retentionDays).toBe(free.retentionDays);
  });
});
