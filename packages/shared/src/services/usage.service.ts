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

function getPeriodStart(cycle: BillingCycle | null): Date {
  const d = new Date();
  if (cycle === "WEEKLY") {
    d.setDate(d.getDate() - 7);
  } else {
    d.setDate(d.getDate() - 30);
  }
  return d;
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
  const periodStart = getPeriodStart(user.billingCycle);
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

export interface JobSubmissionCheck {
  allowed: boolean;
  reason?: string;
}

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
  const periodStart = getPeriodStart(user.billingCycle);
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
