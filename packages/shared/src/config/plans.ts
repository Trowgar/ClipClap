import type { Plan, BillingCycle } from "@prisma/client";

export interface PlanLimits {
  minutesPerPeriod: number;
  storageClips: number;
  retentionDays: number;
  priorityQueue: boolean;
  concurrentJobsLimit: number;
  maxSourceDurationMinutes: number;
  maxFileSizeBytes: number;
  maxJobsPerDay: number;
  priceUsd: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** The one size cap in the product, in bytes. It is enforced in three places
 *  that must agree, because the failure copy states the number as fact:
 *  the presigned-upload check (apps/web/app/api/uploads/route.ts, via
 *  maxFileSizeBytes below), the bot's Telegram download limit
 *  (apps/bot/src/handlers.ts), and yt-dlp's --max-filesize for a pasted link
 *  (apps/worker/src/processors/download.ts). If they drift, SOURCE_TOO_LARGE
 *  tells a user to do something the next surface will also refuse. */
export const MAX_SOURCE_FILESIZE_BYTES = 2 * GB;

const ABUSE_CAPS = {
  maxSourceDurationMinutes: 180,
  maxFileSizeBytes: MAX_SOURCE_FILESIZE_BYTES,
} as const;

export const PLAN_LIMITS: Record<
  Exclude<Plan, "NONE">,
  Record<BillingCycle, PlanLimits | null>
> = {
  STARTER: {
    WEEKLY: {
      minutesPerPeriod: 75,
      storageClips: 20,
      retentionDays: 7,
      priorityQueue: false,
      concurrentJobsLimit: 1,
      maxSourceDurationMinutes: ABUSE_CAPS.maxSourceDurationMinutes,
      maxFileSizeBytes: ABUSE_CAPS.maxFileSizeBytes,
      maxJobsPerDay: 20,
      priceUsd: 3,
    },
    MONTHLY: {
      minutesPerPeriod: 270,
      storageClips: 20,
      retentionDays: 7,
      priorityQueue: false,
      concurrentJobsLimit: 1,
      maxSourceDurationMinutes: ABUSE_CAPS.maxSourceDurationMinutes,
      maxFileSizeBytes: ABUSE_CAPS.maxFileSizeBytes,
      maxJobsPerDay: 20,
      priceUsd: 9,
    },
  },
  PLUS: {
    WEEKLY: null,
    MONTHLY: {
      minutesPerPeriod: 1000,
      storageClips: 150,
      retentionDays: 30,
      priorityQueue: false,
      concurrentJobsLimit: 2,
      maxSourceDurationMinutes: ABUSE_CAPS.maxSourceDurationMinutes,
      maxFileSizeBytes: ABUSE_CAPS.maxFileSizeBytes,
      maxJobsPerDay: 50,
      priceUsd: 29,
    },
  },
  MAX: {
    WEEKLY: null,
    MONTHLY: {
      minutesPerPeriod: 3500,
      storageClips: 1000,
      retentionDays: 90,
      priorityQueue: true,
      concurrentJobsLimit: 3,
      maxSourceDurationMinutes: ABUSE_CAPS.maxSourceDurationMinutes,
      maxFileSizeBytes: ABUSE_CAPS.maxFileSizeBytes,
      maxJobsPerDay: 100,
      priceUsd: 89,
    },
  },
};

/** The free allowance on a brand-new account.
 *
 *  It is LIFETIME, not per-period. A recurring free tier renews forever and is
 *  farmable by anyone patient enough to wait for the reset; the point of this
 *  allowance is only "see one real result before paying", which is a thing you
 *  need once.
 *
 *  Denominated in SECONDS OF SOURCE, because that is what the money is
 *  denominated in: 0.0095 USD per source minute, measured over the nine real
 *  jobs in prod that carry cost telemetry. 3600 seconds is 0.57 USD.
 *
 *  Sixty minutes rather than thirty: the audience clips 3-8 hour VODs, and a
 *  half-hour ceiling forces them to hand-trim a segment first, which is the
 *  exact work they came here to avoid. Sixty rather than a hundred and twenty:
 *  Starter gives 75 minutes PER WEEK for 3 USD, and a lifetime free allowance
 *  has to stay clearly under one week of the entry tier or it competes with the
 *  cheapest paid plan. That constraint, not cost, is what caps generosity.
 *
 *  `zeroClipRefunds` is the backstop that keeps the minute accounting honest.
 *  A run that transcribes but finds nothing has cost us money while showing the
 *  user nothing, so the first one is forgiven and later ones are not. */
export const FREE_TIER = {
  lifetimeSeconds: 3600,
  zeroClipRefunds: 1,
  /** Measured over the nine prod jobs carrying cost telemetry: 0.0060 for
   *  whisper-1 plus 0.0035 for the gpt-5.1 critic. Compute is not in here
   *  because the server is paid for whether a job runs or not. Used only to
   *  pre-charge the monthly budget; finalize replaces it with the real figure. */
  estimatedUsdPerSourceMinute: 0.0095,
} as const;

/**
 * What a free job's reservation costs the monthly budget.
 *
 * Kept beside the constant it multiplies so the web route and the bot cannot
 * each invent their own rounding. Seconds in, USD out - no minute rounding,
 * because the ledger stores the probe's exact seconds and a ceil here would
 * bill a 61-second video for two minutes.
 */
export function estimatedFreeCostUsd(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return (seconds / 60) * FREE_TIER.estimatedUsdPerSourceMinute;
}

/** Not a plan - a sample. Every field is the smallest value that still lets one
 *  real video through end to end, because each zero here is a wall a new user
 *  hits before seeing anything.
 *
 *  Re-enabled 2026-07-29. The three holes that forced the July zeroing are
 *  closed elsewhere, and none of them is closed by these numbers:
 *    1. Unverified open registration -> the trial now requires a verified email
 *       or a linked telegramId (isTrialAnchored in free-tier.service).
 *    2. Client-supplied source duration -> the real duration comes from
 *       source-probe; the request body is no longer trusted for gating.
 *    3. Deleting a project reset the ledger -> the ledger is free_usage, which
 *       has no cascade from Job.
 *  Plus a monthly USD ceiling (FREE_TIER_MONTHLY_BUDGET_USD) that closes the
 *  trial on its own and is unset by default. Do not raise these numbers without
 *  checking all four are still in place. */
const NONE_LIMITS: PlanLimits = {
  // Lifetime seconds live in FREE_TIER and are answered by the ledger, not by
  // usage.service's period window - which can only ever say "inside this
  // window" and cannot express "ever".
  minutesPerPeriod: 0,
  storageClips: 10,
  retentionDays: 3,
  priorityQueue: false,
  // DO NOT raise above 1. The zero-clip forgiveness cap is a read-then-write
  // over the whole account, and the unique index on (userId, jobId, kind)
  // deliberately does not collide two DIFFERENT jobs - so two zero-clip jobs
  // finalizing at once both pass the check and both refund, giving two
  // forgivenesses on a cap of one. Reproduced against real Postgres. This
  // number being 1 is the only thing holding that shut; raising it needs a
  // partial unique index on (userId, reason) or a serialisable transaction
  // first.
  //
  // The number now MEANS something, which it did not until 2026-07-29: the
  // limit was read in the route and written three statements later, so six
  // simultaneous uploads all passed a check that said zero. createJob enforces
  // it inside its transaction under a per-user advisory lock. Everything above
  // rests on that, so do not move the check back out to a caller.
  concurrentJobsLimit: 1,
  maxSourceDurationMinutes: 60,
  maxFileSizeBytes: ABUSE_CAPS.maxFileSizeBytes,
  maxJobsPerDay: 5,
  priceUsd: 0,
};

export function getPlanLimits(plan: Plan, cycle?: BillingCycle): PlanLimits {
  if (plan === "NONE") return NONE_LIMITS;
  const cycleToUse = cycle ?? "MONTHLY";
  const limits = PLAN_LIMITS[plan][cycleToUse];
  if (!limits) throw new Error(`Plan ${plan} has no weekly cycle`);
  return limits;
}

export function getPlanFromPriceId(
  priceId: string
): { plan: Plan; cycle: BillingCycle } | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_STARTER_WEEKLY_PRICE_ID) {
    return { plan: "STARTER", cycle: "WEEKLY" };
  }
  if (priceId === process.env.STRIPE_STARTER_MONTHLY_PRICE_ID) {
    return { plan: "STARTER", cycle: "MONTHLY" };
  }
  if (priceId === process.env.STRIPE_PLUS_MONTHLY_PRICE_ID) {
    return { plan: "PLUS", cycle: "MONTHLY" };
  }
  if (priceId === process.env.STRIPE_MAX_MONTHLY_PRICE_ID) {
    return { plan: "MAX", cycle: "MONTHLY" };
  }
  return null;
}

export const TOPUP_PACKS = {
  SMALL: { minutes: 100, priceUsd: 6, envKey: "STRIPE_TOPUP_SMALL_PRICE_ID" },
  LARGE: { minutes: 300, priceUsd: 15, envKey: "STRIPE_TOPUP_LARGE_PRICE_ID" },
} as const;

export type TopupPack = keyof typeof TOPUP_PACKS;
