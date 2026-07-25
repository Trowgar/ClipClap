import { prisma } from "../lib/prisma";
import { getPlanLimits, FREE_TIER } from "../config/plans";
import {
  getSubscriptionState,
  type SubscriptionState,
  type SubscriptionPhase,
} from "./subscription-state";
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

export interface FreeTrialStatus {
  /** Lifetime jobs that produced at least one clip. */
  runsUsed: number;
  runsLimit: number;
  /** Lifetime jobs that were not our own failures. */
  attemptsUsed: number;
  attemptsLimit: number;
  exhausted: boolean;
}

/**
 * The free allowance, answered over the account's whole life.
 *
 * Neither count carries a `createdAt` filter, and that is the entire point:
 * getMinutesUsedInPeriod can only ever say "how much inside this window", so a
 * period-shaped question cannot express "one free run, ever". Adding a date
 * filter to either query below silently converts the trial into a renewable
 * free tier - the shared tests assert its absence for that reason.
 *
 * A run is a job that produced clips, so a job that came back empty leaves the
 * allowance intact: the user has not yet seen the product work, which is the
 * thing the allowance is for. Attempts then bound what those empty runs may
 * cost us. FAILED jobs count as neither - a user whose link died three times
 * has seen nothing, and locking them out for our breakage is the opposite of a
 * trial. This mirrors the billing rule, where FAILED is likewise not charged.
 */
export async function getFreeTrialStatus(
  userId: string
): Promise<FreeTrialStatus> {
  const [runsUsed, attemptsUsed] = await Promise.all([
    prisma.job.count({ where: { userId, clipsGenerated: { gt: 0 } } }),
    prisma.job.count({ where: { userId, status: { not: "FAILED" } } }),
  ]);

  return {
    runsUsed,
    runsLimit: FREE_TIER.runs,
    attemptsUsed,
    attemptsLimit: FREE_TIER.attempts,
    exhausted:
      runsUsed >= FREE_TIER.runs || attemptsUsed >= FREE_TIER.attempts,
  };
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
  subscriptionState: SubscriptionState;
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
  const subscriptionState = getSubscriptionState(user, new Date());

  if (user.plan === "NONE") {
    // Report the real free allowance rather than zeros. The account card reads
    // these numbers, and a card that says "0 clips, 0 days" to someone who is
    // holding clips we just made for them is simply wrong.
    const free = getPlanLimits("NONE");
    return {
      plan: "NONE",
      billingCycle: null,
      minutesUsed: 0,
      minutesLimit: free.minutesPerPeriod,
      topUpMinutesRemaining: user.topUpMinutesRemaining,
      storageClipsLimit: free.storageClips,
      clipsStored,
      retentionDays: free.retentionDays,
      currentPeriodEnd: null,
      clipsTotal,
      paymentProvider,
      subscriptionState,
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
    subscriptionState,
  };
}

/** Why a submission was refused, so each surface can say it in the user's own
 *  language. The bot serves an audience whose largest single locale is Russian;
 *  before this existed it pasted `reason` through untranslated. `reason` stays
 *  on the union as the English fallback the web API returns verbatim. */
export type SubmissionBlockCode =
  | "LIFECYCLE"
  | "QUOTA"
  | "FREE_TRIAL_USED"
  | "FREE_TRIAL_ATTEMPTS"
  | "FREE_SOURCE_TOO_LONG";

export type JobSubmissionCheck =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      code: SubmissionBlockCode;
      trial?: FreeTrialStatus;
    };

// Block messages by phase. ACTIVE/DUNNING entries are never read (guarded by
// state.live) but are present so the map is total over SubscriptionPhase.
const LIFECYCLE_BLOCK_REASON: Record<SubscriptionPhase, string> = {
  NONE: "No active subscription. Choose a plan to get started.",
  ACTIVE: "",
  DUNNING: "",
  CANCELED: "Your subscription is canceled. Resubscribe to create new clips.",
  CANCELED_GRACE:
    "Your subscription is canceled. Resubscribe to create new clips.",
  PERIOD_ENDED:
    "Your subscription period has ended. Renew to continue creating clips.",
};

// Lifecycle is enforced strictly here; quota check is best-effort because
// jobDurationMinutes may be 0 at submit time (real source duration only known
// after DOWNLOAD step in worker). Plan 3 will add a re-check post-probe.
export async function canSubmitJob(
  userId: string,
  jobDurationMinutes: number
): Promise<JobSubmissionCheck> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  // Lifecycle gate: single source of truth shared with the account card and the
  // reconcile cron. `live` is false for NONE/CANCELED*/period-ended; the message
  // is chosen per phase so the user sees why they were blocked. This preserves
  // the exact reason strings the original inline checks returned.
  const state = getSubscriptionState(user, new Date());

  // A never-subscribed account gets the free allowance instead of a refusal.
  // Both fields are checked, not the derived phase: getSubscriptionState
  // collapses to phase NONE as soon as *either* plan or status is NONE, so a
  // canceled ex-subscriber whose plan was reset would otherwise be handed a
  // fresh free run and cancel-and-resubscribe would become a renewing free
  // tier. Requiring subscriptionStatus NONE too means "has never had a plan".
  if (user.plan === "NONE" && user.subscriptionStatus === "NONE") {
    return checkFreeTrial(userId, jobDurationMinutes);
  }

  if (!state.live) {
    return {
      allowed: false,
      reason: LIFECYCLE_BLOCK_REASON[state.phase],
      code: "LIFECYCLE",
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
      code: "QUOTA",
    };
  }

  return { allowed: true };
}

/**
 * The free-tier gate.
 *
 * Order matters. The duration refusal comes first, because telling someone
 * their trial is spent when the real problem is that they sent a three-hour
 * VOD would push them to buy a plan for a reason that is not true - and they
 * would still be blocked afterwards if the trial really were spent. Length is
 * also the one refusal the user can act on immediately, by sending a shorter
 * cut.
 */
async function checkFreeTrial(
  userId: string,
  jobDurationMinutes: number
): Promise<JobSubmissionCheck> {
  const limits = getPlanLimits("NONE");

  if (jobDurationMinutes > limits.maxSourceDurationMinutes) {
    return {
      allowed: false,
      code: "FREE_SOURCE_TOO_LONG",
      reason: `Your free run covers videos up to ${limits.maxSourceDurationMinutes} minutes. Send a shorter video to try it free, or pick a plan for sources up to ${getPlanLimits("STARTER", "WEEKLY").maxSourceDurationMinutes} minutes.`,
    };
  }

  const trial = await getFreeTrialStatus(userId);

  if (trial.runsUsed >= trial.runsLimit) {
    return {
      allowed: false,
      code: "FREE_TRIAL_USED",
      trial,
      reason: `You have used your free run - that was ${trial.runsUsed} video, free and without a card. Pick a plan to keep clipping: Starter is 75 minutes of video a week, sources up to 180 minutes, 20 clips kept for 7 days.`,
    };
  }

  if (trial.attemptsUsed >= trial.attemptsLimit) {
    return {
      allowed: false,
      code: "FREE_TRIAL_ATTEMPTS",
      trial,
      reason: `Your free trial is used up: ${trial.attemptsUsed} videos processed and no clips came out of them. Pick a plan to keep trying - Starter is 75 minutes of video a week for 3 EUR.`,
    };
  }

  return { allowed: true };
}
