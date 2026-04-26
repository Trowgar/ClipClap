import { prisma } from "../lib/prisma";
import { getPlanLimits } from "../config/plans";
import type { Plan, BillingCycle } from "@prisma/client";

export async function getMinutesUsedInPeriod(
  userId: string,
  from: Date,
  to: Date
): Promise<number> {
  const result = await prisma.job.aggregate({
    where: {
      userId,
      createdAt: { gte: from, lte: to },
      status: { not: "FAILED" },
      sourceDurationSec: { not: null },
    },
    _sum: { sourceDurationSec: true },
  });
  const seconds = result._sum.sourceDurationSec ?? 0;
  return Math.ceil(seconds / 60);
}

// Computes the start of the current billing period.
// Anchors to Stripe-tracked currentPeriodEnd when present (correct behavior:
// usage resets at renewal). Falls back to a rolling 7/30-day window when
// currentPeriodEnd is missing or in the past — only happens for legacy users
// or in dunning/canceled states where canSubmitJob will block anyway.
function getPeriodStart(
  cycle: BillingCycle | null,
  currentPeriodEnd: Date | null
): Date {
  const cycleDays = cycle === "WEEKLY" ? 7 : 30;
  const now = Date.now();

  if (currentPeriodEnd && currentPeriodEnd.getTime() > now) {
    const start = new Date(currentPeriodEnd);
    start.setDate(start.getDate() - cycleDays);
    return start;
  }

  const fallback = new Date();
  fallback.setDate(fallback.getDate() - cycleDays);
  return fallback;
}

export interface UsageSummary {
  plan: Plan;
  billingCycle: BillingCycle | null;
  minutesUsed: number;
  minutesLimit: number;
  topUpMinutesRemaining: number;
  storageClipsLimit: number;
}

export async function getUsageForUser(userId: string): Promise<UsageSummary> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.plan === "NONE") {
    return {
      plan: "NONE",
      billingCycle: null,
      minutesUsed: 0,
      minutesLimit: 0,
      topUpMinutesRemaining: 0,
      storageClipsLimit: 0,
    };
  }
  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");
  const periodStart = getPeriodStart(user.billingCycle, user.currentPeriodEnd);
  const minutesUsed = await getMinutesUsedInPeriod(
    userId,
    periodStart,
    new Date()
  );
  return {
    plan: user.plan,
    billingCycle: user.billingCycle,
    minutesUsed,
    minutesLimit: limits.minutesPerPeriod,
    topUpMinutesRemaining: user.topUpMinutesRemaining,
    storageClipsLimit: limits.storageClips,
  };
}

export type JobSubmissionCheck =
  | { allowed: true }
  | { allowed: false; reason: string };

// Lifecycle is enforced strictly here; quota check is best-effort because
// jobDurationMinutes may be 0 at submit time (real source duration only known
// after DOWNLOAD step in worker). Plan 3 will add a re-check post-probe.
export async function canSubmitJob(
  userId: string,
  jobDurationMinutes: number
): Promise<JobSubmissionCheck> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  if (user.plan === "NONE" || user.subscriptionStatus === "NONE") {
    return { allowed: false, reason: "No active subscription. Choose a plan to get started." };
  }
  if (user.subscriptionStatus === "DUNNING") {
    return { allowed: false, reason: "Your last payment failed. Please update your payment method." };
  }
  if (user.subscriptionStatus === "CANCELED_GRACE" || user.subscriptionStatus === "CANCELED") {
    return { allowed: false, reason: "Your subscription is canceled. Resubscribe to create new clips." };
  }

  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");
  const periodStart = getPeriodStart(user.billingCycle, user.currentPeriodEnd);
  const used = await getMinutesUsedInPeriod(userId, periodStart, new Date());
  const projectedUsage = used + jobDurationMinutes;
  const totalAvailable = limits.minutesPerPeriod + user.topUpMinutesRemaining;

  if (projectedUsage > totalAvailable) {
    return {
      allowed: false,
      reason: `This job would exceed your minute limit (${used}/${limits.minutesPerPeriod} used, ${user.topUpMinutesRemaining} top-up available).`,
    };
  }

  return { allowed: true };
}
