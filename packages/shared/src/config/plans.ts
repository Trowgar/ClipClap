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
/** `lifetimeSeconds` and `zeroClipRefunds` are the Milestone 2 replacements for
 *  `runs`/`attempts`, and for now all four coexist: usage.service and the bot
 *  still read the old pair, and they stop only once Task 11 rewrites those
 *  consumers. Do not delete `runs`/`attempts` before then - the tree must
 *  compile at every commit.
 *
 *  `lifetimeSeconds` (3600) is SOURCE seconds, spent against the free_usage
 *  ledger rather than counted from Job rows, because deleteProject hard-deletes
 *  jobs and a jobs-based count is reset by the user pressing Delete. Nine real
 *  prod jobs measured 0.0095 USD per source minute, so the whole allowance is
 *  about 0.57 USD per anchored account.
 *
 *  Seconds replace `runs` because seconds are what the ledger can charge BEFORE
 *  the job runs. `runs` counted delivered clips, which is only knowable
 *  afterwards, so ten simultaneous submissions each saw an unspent allowance.
 *
 *  `zeroClipRefunds` (1) is one forgiveness per account for a run that
 *  transcribed fine and simply found nothing worth cutting. Without it a first
 *  attempt on unclippable video ends the trial and the user leaves having seen
 *  nothing work; with more than one, an account can feed us silence forever. */
export const FREE_TIER = {
  runs: 1,
  attempts: 3,
  lifetimeSeconds: 3600,
  zeroClipRefunds: 1,
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
  // DISABLED 2026-07-25. The free trial shipped in 767a54b was live in prod for
  // a short window and is an unbounded compute faucet: POST /api/register is
  // unauthenticated and unrate-limited, the 30-minute cap is enforced on a
  // client-supplied sourceDurationSec that is absent (and therefore 0) on every
  // URL submission, and DELETE /api/projects/:id hard-deletes the Job rows that
  // ARE the trial's ledger, so a single account can reset itself forever.
  // Zeroed until those three holes are closed AND the owner has approved the
  // commercial terms. Do not re-enable by editing these numbers alone.
  minutesPerPeriod: 0,
  storageClips: 0,
  retentionDays: 0,
  priorityQueue: false,
  concurrentJobsLimit: 0,
  maxSourceDurationMinutes: 0,
  maxFileSizeBytes: 0,
  maxJobsPerDay: 0,
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
