import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "../../config/billing";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    // findUnique as well as findUniqueOrThrow: the free gate now asks
    // isTrialAnchored, which reads the account through findUnique.
    user: { findUniqueOrThrow: vi.fn(), findUnique: vi.fn() },
    job: { aggregate: vi.fn(), count: vi.fn() },
    clip: { count: vi.fn() },
    // The free allowance is the ledger: groupBy is the per-account balance,
    // aggregate is the month's global spend against the budget ceiling.
    freeUsage: { groupBy: vi.fn(), aggregate: vi.fn() },
    // The federated half of the anchor check.
    account: { count: vi.fn() },
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

// The free plan is switched off in two independent places, and the tests below
// read both from the config rather than hard-coding a moment in time:
//   - NONE_LIMITS is zeroed (see the comment above it in ../../config/plans.ts),
//     which is what BALANCE_REACHABLE in the free-tier suite tracks;
//   - FREE_TIER_MONTHLY_BUDGET_USD is unset in production, which closes the
//     budget and is asserted unconditionally down there.
// Un-zeroing either one on its own does not open the free plan.

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

  // NONE is no longer a flat refusal - it routes to the free-tier gate, which
  // decides on the anchor, the ledger and the monthly budget rather than on the
  // plan alone. With no anchor on the account that gate refuses, which is the
  // property this case cares about: NONE does not walk through.
  it("blocks a NONE plan the free gate will not admit", async () => {
    mockUser({ plan: "NONE", subscriptionStatus: "NONE" });
    (prisma.user.findUnique as any).mockResolvedValue({
      telegramId: null,
      emailVerified: null,
      email: "a@b.com",
      emailCanonical: "a@b.com",
    });
    (prisma.account.count as any).mockResolvedValue(0);
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
 * before paying. It is LIFETIME, not per-period: a monthly free tier renews
 * forever and is farmable by anyone patient enough to wait for the reset, and
 * the goal here is "prove the product once", not "run a free service".
 *
 * The gate reads three things and nothing else: the anchor, the free_usage
 * ledger, and the month's global budget. It used to count Job rows instead,
 * which was both resettable - deleteProject hard-deletes jobs, so an account
 * could clear its own trial with the Delete button - and raceable, because a
 * "run" only counted once it had produced clips, so ten simultaneous
 * submissions each saw an unspent allowance.
 *
 * These tests pin the new sources AND the order the three are consulted in.
 * The order is not cosmetic: a refusal that names the wrong reason sends the
 * user off to buy a plan for something a plan would not fix.
 */
describe("the free-tier gate", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const FREE_CAP = getPlanLimits("NONE").maxSourceDurationMinutes;

  // The balance refusal is only REACHABLE when a submission with a non-zero
  // duration can get past the length check, and NONE_LIMITS is zeroed today
  // (see the comment above NONE_LIMITS in ../../config/plans.ts), so every
  // such submission is currently refused for length first. The two cases that
  // need a real duration are gated on that config rather than deleted, so they
  // come back on their own the moment the numbers are un-zeroed.
  const BALANCE_REACHABLE = FREE_CAP > 0;

  const ORIGINAL_BUDGET = process.env.FREE_TIER_MONTHLY_BUDGET_USD;

  beforeEach(() => {
    vi.clearAllMocks();
    // An OPEN budget is the background for every case except the two that are
    // about the budget itself. Without it every refusal below would come back
    // as FREE_BUDGET_CLOSED and would prove nothing about the check it means
    // to be testing.
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "50";
    (prisma.freeUsage.aggregate as any).mockResolvedValue({
      _sum: { estimatedCostUsd: 1 },
    });
  });

  afterEach(() => {
    if (ORIGINAL_BUDGET === undefined) {
      delete process.env.FREE_TIER_MONTHLY_BUDGET_USD;
    } else {
      process.env.FREE_TIER_MONTHLY_BUDGET_USD = ORIGINAL_BUDGET;
    }
  });

  /** A never-subscribed account, anchored by a verified email. */
  function freeUser(overrides: Record<string, unknown> = {}) {
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
    (prisma.user.findUnique as any).mockResolvedValue({
      telegramId: null,
      emailVerified: new Date(),
      email: "a@b.com",
      emailCanonical: "a@b.com",
    });
    (prisma.job.aggregate as any).mockResolvedValue({
      _sum: { sourceDurationSec: 0 },
    });
  }

  /** Ledger rows shaped the way Postgres actually returns them: a kind with no
   *  rows is OMITTED from the group-by, never returned as a zero. */
  function ledgerCharged(seconds: number) {
    (prisma.freeUsage.groupBy as any).mockResolvedValue(
      seconds > 0 ? [{ kind: "CHARGE", _sum: { seconds } }] : []
    );
  }

  it("reads the allowance off the ledger, never off job rows", async () => {
    ledgerCharged(0);

    const status = await getFreeTrialStatus("u1");

    expect(status).toEqual({
      remainingSeconds: FREE_TIER.lifetimeSeconds,
      lifetimeSeconds: FREE_TIER.lifetimeSeconds,
      exhausted: false,
    });
    // Job rows are hard-deleted by deleteProject. Counting them here is what
    // let an account reset its own trial by pressing Delete.
    expect((prisma.job.count as any).mock.calls).toHaveLength(0);
    // Lifetime, not windowed: a createdAt filter would silently turn the
    // allowance into a renewable free tier.
    const groupByArgs = (prisma.freeUsage.groupBy as any).mock.calls[0][0];
    expect(groupByArgs.where.createdAt).toBeUndefined();
  });

  it("reports exhausted once the whole allowance has been charged", async () => {
    ledgerCharged(FREE_TIER.lifetimeSeconds);

    const status = await getFreeTrialStatus("u1");

    expect(status.remainingSeconds).toBe(0);
    expect(status.exhausted).toBe(true);
  });

  it("lets an anchored account with a full balance and an open budget through", async () => {
    freeUser();
    ledgerCharged(0);

    expect(await canSubmitJob("u1", FREE_CAP)).toEqual({ allowed: true });
  });

  it("refuses an unanchored account first, before it mentions minutes", async () => {
    freeUser();
    (prisma.user.findUnique as any).mockResolvedValue({
      telegramId: null,
      emailVerified: null,
      email: "a@b.com",
      emailCanonical: "a@b.com",
    });
    (prisma.account.count as any).mockResolvedValue(0);
    ledgerCharged(0);

    // Deliberately over the length cap as well: an account that has no
    // allowance at all must not be told about minutes it does not have, and
    // the anchor is the only refusal that is true here.
    const res = await canSubmitJob("u1", FREE_CAP + 1);

    expect(res).toMatchObject({ allowed: false, code: "FREE_NOT_ANCHORED" });
    expect((prisma.freeUsage.groupBy as any).mock.calls).toHaveLength(0);
  });

  it("refuses a source over the free ceiling before consulting the balance", async () => {
    freeUser();
    ledgerCharged(0);

    const res = await canSubmitJob("u1", FREE_CAP + 1);

    expect(res).toMatchObject({ allowed: false, code: "FREE_SOURCE_TOO_LONG" });
    if (res.allowed) throw new Error("unreachable");
    expect(res.reason).toContain(String(FREE_CAP));
    // Telling someone their minutes are spent when the real problem is a
    // three-hour VOD pushes them to buy for a reason that is not true - and
    // length is the one refusal they can act on immediately.
    expect((prisma.freeUsage.groupBy as any).mock.calls).toHaveLength(0);
  });

  it.runIf(BALANCE_REACHABLE)(
    "refuses when the remaining balance is smaller than the video",
    async () => {
      freeUser();
      ledgerCharged(FREE_TIER.lifetimeSeconds - 60);

      const res = await canSubmitJob("u1", FREE_CAP);

      expect(res).toMatchObject({ allowed: false, code: "FREE_EXHAUSTED" });
      if (res.allowed) throw new Error("unreachable");
      // The numbers travel structurally, so a surface can say them in its own
      // language instead of reprinting the English `reason`.
      expect(res.trial).toMatchObject({
        remainingSeconds: 60,
        lifetimeSeconds: FREE_TIER.lifetimeSeconds,
      });
      // Their own allowance is the personal reason, and it wins: the global
      // budget is not even read once this has fired.
      expect((prisma.freeUsage.aggregate as any).mock.calls).toHaveLength(0);
    }
  );

  it.runIf(BALANCE_REACHABLE)(
    "prefers the personal reason over the global one when both apply",
    async () => {
      freeUser();
      ledgerCharged(FREE_TIER.lifetimeSeconds);
      delete process.env.FREE_TIER_MONTHLY_BUDGET_USD;

      const res = await canSubmitJob("u1", FREE_CAP);

      expect(res).toMatchObject({ allowed: false, code: "FREE_EXHAUSTED" });
    }
  );

  it("refuses when the month's global budget is spent", async () => {
    freeUser();
    ledgerCharged(0);
    (prisma.freeUsage.aggregate as any).mockResolvedValue({
      _sum: { estimatedCostUsd: 50 },
    });

    const res = await canSubmitJob("u1", FREE_CAP);

    expect(res).toMatchObject({ allowed: false, code: "FREE_BUDGET_CLOSED" });
    if (res.allowed) throw new Error("unreachable");
    // The user's own balance is untouched - the pause is ours, not theirs, and
    // the copy must be able to say so.
    expect(res.trial).toMatchObject({ exhausted: false });
  });

  /**
   * ALWAYS ON, and the reason this rewrite is safe to land on a live host.
   *
   * FREE_TIER_MONTHLY_BUDGET_USD is not set in production, and an unset
   * ceiling reads as zero - closed - because the failure direction has to be
   * "no free tier", never "unlimited free tier". So a brand-new account with a
   * perfect anchor and an untouched allowance is still refused, and the free
   * plan cannot go live by accident: someone has to put a number in .env.
   */
  it("refuses everything while FREE_TIER_MONTHLY_BUDGET_USD is unset", async () => {
    delete process.env.FREE_TIER_MONTHLY_BUDGET_USD;
    freeUser();
    ledgerCharged(0);

    const res = await canSubmitJob("u1", FREE_CAP);

    expect(res).toMatchObject({ allowed: false, code: "FREE_BUDGET_CLOSED" });
  });

  it("leaves a paying subscriber out of the free gate entirely", async () => {
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

    expect(res).toEqual({ allowed: true });
    expect((prisma.user.findUnique as any).mock.calls).toHaveLength(0);
    expect((prisma.freeUsage.groupBy as any).mock.calls).toHaveLength(0);
    expect((prisma.freeUsage.aggregate as any).mock.calls).toHaveLength(0);
  });

  /**
   * A free allowance is for people who have never paid. Someone who subscribed
   * and canceled must get the lifecycle message and the resubscribe path, not
   * a fresh allowance - otherwise cancel-and-resubscribe is a renewing free
   * tier.
   */
  it("does not hand a free allowance to a canceled ex-subscriber", async () => {
    freeUser({ subscriptionStatus: "CANCELED" });
    ledgerCharged(0);

    const res = await canSubmitJob("u1", 5);

    expect(res).toMatchObject({ allowed: false, code: "LIFECYCLE" });
    // The decisive part: neither the anchor nor the ledger was consulted, so
    // no allowance was handed out.
    expect((prisma.user.findUnique as any).mock.calls).toHaveLength(0);
    expect((prisma.freeUsage.groupBy as any).mock.calls).toHaveLength(0);
  });

  it("getUsageForUser reports the real free limits, not zeros", async () => {
    freeUser();
    (prisma.clip.count as any).mockResolvedValue(0);

    const usage = await getUsageForUser("u1");
    const free = getPlanLimits("NONE");

    expect(usage.plan).toBe("NONE");
    expect(usage.minutesLimit).toBe(free.minutesPerPeriod);
    expect(usage.storageClipsLimit).toBe(free.storageClips);
    expect(usage.retentionDays).toBe(free.retentionDays);
  });
});
