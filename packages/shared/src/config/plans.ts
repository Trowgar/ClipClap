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
 *  need once. Lifetime is also the only shape the data can express honestly:
 *  usage.service's minute accounting is windowed by billing period and can
 *  never answer "ever", so the gate counts jobs with no date filter instead.
 *
 *  `runs` is denominated in jobs that ACTUALLY PRODUCED CLIPS, not in minutes.
 *  Minutes are the wrong unit for a free tier: the per-job cost is dominated by
 *  fixed work (a transcript, then several analysis passes over it), so thirty
 *  one-minute videos cost far more than one thirty-minute video while spending
 *  the same "minutes". Counting delivered runs bounds the thing that actually
 *  costs money.
 *
 *  `attempts` is the backstop that makes the above safe. Because a run only
 *  counts once it produced clips, a user submitting unclippable video would
 *  otherwise never exhaust the trial while still costing a transcript every
 *  time. Attempts cap the total jobs a free account may ever start. FAILED
 *  jobs are excluded from that count - our own breakages must not consume a
 *  stranger's only look at the product. */
export const FREE_TIER = {
  runs: 1,
  attempts: 3,
} as const;

/** Not a plan - a sample. Every field is the smallest value that still lets one
 *  real video through end to end, because each zero here is a wall a new user
 *  hits before seeing anything.
 *
 *  maxSourceDurationMinutes (30) is the cost lever. Whisper plus the analysis
 *  passes run about $0.36 per source hour, so a 30-minute ceiling caps one free
 *  run near $0.18 and the whole lifetime allowance near $0.54 in the worst case
 *  where all three attempts transcribe and none produce clips. A 3-hour VOD
 *  trial would be six times that and slow enough that the user leaves before it
 *  finishes. 30 minutes is still a real podcast segment or stream chunk rather
 *  than a toy, which matters: the trial has to run on the content the user
 *  actually wants clipped or it proves nothing. It also stays far under the
 *  180-minute paid cap, so length remains a reason to subscribe. */
const NONE_LIMITS: PlanLimits = {
  // Enough for one full-length free source. The real gate is the run counter
  // below, not this number; it exists so the minute arithmetic shared with the
  // paid plans cannot refuse a source the trial is meant to accept.
  minutesPerPeriod: 30,
  // One run can yield up to 12 clips, so anything less would silently discard
  // part of the only result this user will ever see for free.
  storageClips: 12,
  // Long enough to watch the clips, show someone, and come back; short enough
  // that free output is not indefinite storage. Retention is a paid feature -
  // 7/30/90 days is part of what a plan buys.
  retentionDays: 3,
  priorityQueue: false,
  // Exactly one: a free account never needs to run two jobs at once, and 0
  // would block every submission.
  concurrentJobsLimit: 1,
  maxSourceDurationMinutes: 30,
  // 500 MB comfortably holds 30 minutes of ordinary upload while keeping the
  // 2 GB path a paid one.
  maxFileSizeBytes: 500 * MB,
  // Same number as the lifetime attempt backstop, so the daily gate can never
  // be the looser of the two and let a burst outrun it.
  maxJobsPerDay: FREE_TIER.attempts,
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
