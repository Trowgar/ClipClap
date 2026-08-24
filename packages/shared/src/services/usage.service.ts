import { prisma } from "../lib/prisma";
import {
  getPlanLimits,
  FREE_TIER,
  FREE_TRIM_FLOOR_SEC,
  SOURCE_FLOOR,
} from "../config/plans";
import {
  getSubscriptionState,
  type SubscriptionState,
  type SubscriptionPhase,
} from "./subscription-state";
// Both anchor and balance come from free-tier.service, and the budget from
// free-budget.service. NEVER reach for user.service for any of this: that file
// already imports this one, so an import back would close a cycle.
import { freeBalanceSeconds, isTrialAnchored } from "./free-tier.service";
import { freeBudgetStatus } from "./free-budget.service";
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
  /** Seconds of source left on the account, for ever. */
  remainingSeconds: number;
  /** The lifetime allowance, so a surface can render "x of y". */
  lifetimeSeconds: number;
  exhausted: boolean;
}

/**
 * The free allowance, answered over the account's whole life.
 *
 * It reads the free_usage ledger and nothing else. It used to count Job rows -
 * one run that produced clips, three attempts - and that shape had two holes
 * this one does not. DELETE: deleteProject hard-deletes jobs, so a jobs-based
 * count was reset by the user pressing Delete. RACE: "a run that produced
 * clips" is only knowable after the run, so ten simultaneous submissions each
 * saw an unspent allowance. The ledger charges seconds BEFORE the job starts,
 * lives in its own table, and survives a project delete.
 *
 * Still lifetime, still with no date window. freeBalanceSeconds carries that
 * property (and its own test asserts the absence of a createdAt filter): a
 * period-shaped question can never express "one free allowance, ever".
 */
export async function getFreeTrialStatus(
  userId: string
): Promise<FreeTrialStatus> {
  const remainingSeconds = await freeBalanceSeconds(userId);
  return {
    remainingSeconds,
    lifetimeSeconds: FREE_TIER.lifetimeSeconds,
    exhausted: remainingSeconds <= 0,
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
  | "FREE_NOT_ANCHORED"
  | "FREE_EXHAUSTED"
  | "FREE_SOURCE_TOO_LONG"
  | "FREE_BUDGET_CLOSED";

/** The numbers behind a QUOTA refusal, so a presentation layer can say them
 *  in its own language instead of reprinting `reason`. */
export interface QuotaBlockDetail {
  usedMinutes: number;
  limitMinutes: number;
  topUpMinutes: number;
}

/**
 * `reason` is English prose for logs and for the web UI. It is NOT a message
 * for a Telegram chat: the bot's audience is majority non-English and renders
 * refusals through its own dictionary. Everything a translation needs is
 * therefore also carried structurally - `code` always, plus `trial` / `phase`
 * / `quota` for the codes whose wording depends on more than the code itself.
 */
export type JobSubmissionCheck =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      code: SubmissionBlockCode;
      trial?: FreeTrialStatus;
      /** Set for code LIFECYCLE: which phase refused. "canceled" and "the
       *  period ran out" are different sentences to a user. */
      phase?: SubscriptionPhase;
      /** Set for code QUOTA. */
      quota?: QuotaBlockDetail;
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
      phase: state.phase,
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
      quota: {
        usedMinutes: used,
        limitMinutes: limits.minutesPerPeriod,
        topUpMinutes: user.topUpMinutesRemaining,
      },
    };
  }

  return { allowed: true };
}

/**
 * The free-tier gate.
 *
 * Order matters, and it is not arbitrary:
 *   1. Anchor first. An unverified account has no allowance at all, so telling
 *      it about minutes it does not have would be a lie.
 *   2. Length next. Telling someone their trial is spent when the real problem
 *      is a three-hour VOD pushes them to buy for a reason that is not true,
 *      and length is the one refusal they can act on immediately.
 *   3. Balance, then the global budget. Balance is about this user; the budget
 *      is about everyone, and a user whose own allowance is gone should hear
 *      the personal reason rather than a global one.
 */
async function checkFreeTrial(
  userId: string,
  jobDurationMinutes: number
): Promise<JobSubmissionCheck> {
  const limits = getPlanLimits("NONE");

  if (!(await isTrialAnchored(userId))) {
    return {
      allowed: false,
      code: "FREE_NOT_ANCHORED",
      reason:
        "Confirm your email to unlock your free minutes. We sent you a link when you signed up - ask for another one if it is gone.",
    };
  }

  if (jobDurationMinutes > limits.maxSourceDurationMinutes) {
    return {
      allowed: false,
      code: "FREE_SOURCE_TOO_LONG",
      reason: `Your free minutes cover videos up to ${limits.maxSourceDurationMinutes} minutes. Send a shorter video, or pick a plan for sources up to ${getPlanLimits("STARTER", "WEEKLY").maxSourceDurationMinutes} minutes.`,
    };
  }

  const trial = await getFreeTrialStatus(userId);
  const neededSeconds = jobDurationMinutes * 60;

  // `trial.exhausted` is not redundant with the comparison beside it, and this
  // is the one line in the gate that must not be simplified.
  //
  // jobDurationMinutes is 0 whenever the source has not been probed - which is
  // every URL submission on the web path today. That makes neededSeconds 0, and
  // an empty balance is not LESS than 0, so a spent account walks straight past
  // the comparison. Until this clause was added, the only thing refusing that
  // account was the closed budget one check further down, which means the day a
  // ceiling goes into .env an exhausted account is allowed through. Verified
  // against the live gate, not reasoned about.
  //
  // Task 12 will make submissions carry a real duration, and this clause still
  // stays: an upload reserves provisionally and a probe can fail, so the gate
  // must not depend on its caller having measured anything.
  // NOT ENOUGH LEFT FOR THE WHOLE VIDEO IS NO LONGER A REFUSAL.
  //
  // It was, until 2026-08-24, and the measurement that ended it is this: the
  // median FIRST source sent to this product is 966 seconds against a
  // 900-second allowance, so `remainingSeconds < neededSeconds` turned away 23
  // of 42 accounts before they had seen a single clip. What happens instead is
  // in stages/source-recheck.ts - the source is cut to what the allowance
  // covers, the user gets real clips, and the balance lands on zero while they
  // are holding them.
  //
  // So the question here is no longer "does it fit" but "is there anything
  // useful this submission can still produce", and it is refused on three
  // grounds only:
  //
  //   - `trial.exhausted`, which still leads for the reason above it:
  //     neededSeconds is 0 on any unprobed submission, and the flag is what
  //     refuses a spent account that the arithmetic would wave through.
  //   - Less left than the shortest source we accept at all.
  //   - A source we KNOW is too long, against a balance too small to cut it
  //     into anything worth having. FREE_TRIM_FLOOR_SEC is that line, and it is
  //     measured: below ten minutes of source the empty rate runs 40% to 82%,
  //     so trimming there would spend the user's last minutes on a run that
  //     probably returns nothing. Refusing keeps their minutes AND is the one
  //     refusal that has ever sent anybody to the plans screen.
  //
  // Only when the duration is KNOWN, and that condition is load-bearing rather
  // than defensive: neededSeconds is 0 for every unprobed upload, and treating
  // an unknown length as over-long would refuse uploads at submit that the
  // download stage can measure and settle honestly a minute later. It also
  // saves the wasted download in the case we can already decide.
  if (
    trial.exhausted ||
    trial.remainingSeconds < SOURCE_FLOOR.minDurationSec ||
    (neededSeconds > trial.remainingSeconds &&
      trial.remainingSeconds < FREE_TRIM_FLOOR_SEC)
  ) {
    return {
      allowed: false,
      code: "FREE_EXHAUSTED",
      // The copy states what they HAD and what is left, and deliberately says
      // nothing about the length of this particular video: on the duration-0
      // path we do not know it, and "this video needs 0 minutes" is nonsense.
      trial,
      reason: `Your free minutes will not cover this - ${Math.floor(trial.remainingSeconds / 60)} of ${trial.lifetimeSeconds / 60} left. Starter is 75 minutes of video a week for 3 USD.`,
    };
  }

  const budget = await freeBudgetStatus();
  if (!budget.open) {
    return {
      allowed: false,
      code: "FREE_BUDGET_CLOSED",
      trial,
      reason:
        "Free runs are paused until the first of next month. Pick a plan to clip now - Starter is 75 minutes of video a week for 3 USD.",
    };
  }

  return { allowed: true };
}
