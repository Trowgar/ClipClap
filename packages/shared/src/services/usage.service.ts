import { prisma } from "../lib/prisma";
import { getPlanLimits } from "../config/plans";
import { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "../config/billing";
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

// Computes the start of the current billing period (the usage window start).
// Prefers the provider-supplied currentPeriodStart so the window matches the
// real billing period even during DUNNING/grace. Falls back to subtracting one
// calendar month (monthly) or 7 days (weekly) from currentPeriodEnd, and finally
// to a rolling window from now for legacy rows with no period info.
function getPeriodStart(
  cycle: BillingCycle | null,
  currentPeriodStart: Date | null,
  currentPeriodEnd: Date | null
): Date {
  if (currentPeriodStart) {
    return currentPeriodStart;
  }

  if (currentPeriodEnd) {
    const start = new Date(currentPeriodEnd);
    if (cycle === "WEEKLY") {
      start.setDate(start.getDate() - 7);
    } else {
      start.setMonth(start.getMonth() - 1);
    }
    return start;
  }

  const fallback = new Date();
  if (cycle === "WEEKLY") {
    fallback.setDate(fallback.getDate() - 7);
  } else {
    fallback.setMonth(fallback.getMonth() - 1);
  }
  return fallback;
}

export type PaymentProvider = "stripe" | "tribute" | null;

export interface UsageSummary {
  plan: Plan;
  billingCycle: BillingCycle | null;
  minutesUsed: number;
  minutesLimit: number;
  topUpMinutesRemaining: number;
  storageClipsLimit: number;
  clipsStored: number;
  retentionDays: number;
  currentPeriodEnd: Date | null;
  clipsTotal: number;
  paymentProvider: PaymentProvider;
}

function resolvePaymentProvider(user: {
  tributeSubscriptionId: string | null;
  stripeSubscriptionId: string | null;
}): PaymentProvider {
  if (user.tributeSubscriptionId) return "tribute";
  if (user.stripeSubscriptionId) return "stripe";
  return null;
}

export async function getUsageForUser(userId: string): Promise<UsageSummary> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const [clipsStored, clipsTotal] = await Promise.all([
    prisma.clip.count({ where: { userId, deletedAt: null } }),
    prisma.clip.count({ where: { userId } }),
  ]);

  const paymentProvider = resolvePaymentProvider(user);

  if (user.plan === "NONE") {
    return {
      plan: "NONE",
      billingCycle: null,
      minutesUsed: 0,
      minutesLimit: 0,
      topUpMinutesRemaining: 0,
      storageClipsLimit: 0,
      clipsStored,
      retentionDays: 0,
      currentPeriodEnd: null,
      clipsTotal,
      paymentProvider,
    };
  }

  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");
  const periodStart = getPeriodStart(
    user.billingCycle,
    user.currentPeriodStart,
    user.currentPeriodEnd
  );
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
    clipsStored,
    retentionDays: limits.retentionDays,
    currentPeriodEnd: user.currentPeriodEnd,
    clipsTotal,
    paymentProvider,
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
  if (
    user.subscriptionStatus === "CANCELED_GRACE" ||
    user.subscriptionStatus === "CANCELED"
  ) {
    return { allowed: false, reason: "Your subscription is canceled. Resubscribe to create new clips." };
  }

  // ACTIVE or DUNNING: access is allowed only while the billing period is still
  // live within the grace buffer. This is the defense-in-depth that stops a
  // missed renewal webhook (or a stale DB row) from granting access forever.
  const graceMs = SUBSCRIPTION_GRACE_BUFFER_DAYS * 24 * 60 * 60 * 1000;
  if (
    !user.currentPeriodEnd ||
    user.currentPeriodEnd.getTime() + graceMs <= Date.now()
  ) {
    return {
      allowed: false,
      reason: "Your subscription period has ended. Renew to continue creating clips.",
    };
  }

  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");
  const periodStart = getPeriodStart(
    user.billingCycle,
    user.currentPeriodStart,
    user.currentPeriodEnd
  );
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
