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
 *  denominated in: 0.012 USD per source minute plus 0.030 per run, fitted over
 *  every prod job that carries cost telemetry (see estimatedUsdPerRun for the
 *  query and its output). A full 3600-second allowance spent in one run
 *  reserves 0.75 USD, and 0.03 more for each extra run it is split across.
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
  /** The part of a free run's cash cost that scales with length: 0.0060 for
   *  whisper-1, which is billed per minute of audio and is exact (every prod
   *  job's transcription figure is secs/60 * 0.006 to the cent), plus 0.0060
   *  for the share of the critic that grows with the transcript.
   *
   *  The critic half was 0.0040 and was too low. The largest analysis figure in
   *  the table below is 0.273 on a 3138-second source, which is 0.0052 per
   *  minute AFTER subtracting the flat part - and that is a measurement, not a
   *  worst case, so it is rounded up rather than fitted to.
   *
   *  Compute is NOT in here and must never be. cost-telemetry records it on the
   *  job because it is real capacity, but the server is rented whether a job
   *  runs or not, so charging it to the monthly budget spends a ceiling that is
   *  denominated in money on something that is not money. */
  estimatedUsdPerSourceMinute: 0.012,
  /** The part that does NOT scale with length.
   *
   *  The critic makes a roughly fixed number of calls with a roughly fixed
   *  prompt whatever the source is, so a short video pays almost all of it. The
   *  purely per-minute model was 2-3x low there and that error runs in the
   *  dangerous direction: reservations are what bound in-flight spend, so
   *  under-counting them lets a burst overshoot the ceiling before a single job
   *  finalizes.
   *
   *  RECALIBRATED 2026-07-30, from 0.020, because 0.020 was fitted to ONE run
   *  whose critic happened to cost 0.029 and the next near-identical 188-second
   *  run cost 0.042. gpt-5.1's OUTPUT tokens at 10 USD/1M are what move, and
   *  neither constant modelled them. Re-run this against prod before touching
   *  either number - `cash` is the real money (transcription + analysis);
   *  compute is excluded on purpose, see above:
   *
   *    SELECT "sourceDurationSec" AS secs,
   *           round(("estimatedTranscriptionCostUsd"
   *                  + "estimatedAnalysisCostUsd")::numeric, 4) AS cash,
   *           round((0.030 + "sourceDurationSec" / 60.0 * 0.012)::numeric, 4)
   *             AS reserved,
   *           id
   *      FROM jobs
   *     WHERE "estimatedTotalCostUsd" IS NOT NULL
   *     ORDER BY "sourceDurationSec";
   *
   *     secs |  cash  | reserved |            id
   *    ------+--------+----------+---------------------------
   *      501 | 0.0500 |   0.1302 | cmpkb1o4v00015zbx4rfjy0zj
   *     1789 | 0.2330 |   0.3878 | cmrkvyzln000113tcps7f5hv0
   *     1790 | 0.1800 |   0.3880 | cmpg0xg2a0001nsy610003yxf
   *     1790 | 0.2710 |   0.3880 | cmrv9t0x5000y9pvweq9c8j78
   *     1790 | 0.1800 |   0.3880 | cmpfzi7jz00016olp9gr9p4ng
   *     2385 | 0.2410 |   0.5070 | cmrj4sopj0001jqlzmsfl120l
   *     3138 | 0.5370 |   0.6576 | cmrvawjxs00129pvw0oe1c1kv
   *     3138 | 0.5020 |   0.6576 | cms7jhcbz0003nb7fkfdki0lp
   *     3138 | 0.5870 |   0.6576 | cmrzcqhl6000138lkg41n8bs0
   *     3138 | 0.4710 |   0.6576 | cms2c8ahm000droa7tcqh30ho
   *
   *  Two SHORT runs pin the flat term and are not in that table, because the
   *  free-plan walks that produced them ended by deleting the project and the
   *  job row went with it. Both are recorded here so the fit can be checked:
   *  174s cost 0.046 cash (walk 1) and 188s cost 0.0610 cash (walk 2, which is
   *  the run that exposed this). 0.030 + 188/60*0.012 = 0.0676, so the shorter
   *  end clears by 11% and the 3138-second worst case by 12%. The line through
   *  those two extremes is 0.0275 + 0.0107/min; both constants are rounded UP
   *  from it, because an over-reservation costs a little headroom while a job
   *  is in flight and an under-reservation is a hole in the ceiling. */
  estimatedUsdPerRun: 0.03,
} as const;

/**
 * What a free job's reservation costs the monthly budget.
 *
 * Two components, not one. A flat per-run charge covers the critic, whose cost
 * barely moves with source length, and the per-minute rate covers transcription
 * and the part of analysis that does grow. The single per-minute rate this
 * replaced reserved 0.028 for a run that really cost 0.046 in cash - 39% under,
 * and worst on exactly the short sources a new user tries first.
 *
 * Checked against every prod job that carries cost telemetry - the query and
 * its output are in estimatedUsdPerRun above, and it is the thing to re-run
 * rather than to trust this sentence about. It reserves above the measured cash
 * line in every one of them, by 11% at the thinnest. That claim was FALSE when
 * it was first written: the constants it described reserved 0.543 for a
 * 3138-second job that cost 0.587, and 0.0513 for a 188-second job that cost
 * 0.0610. Finalize replaces the reservation with the measured figure, so an
 * over-reservation costs nothing but a little headroom while the job is in
 * flight; an under-reservation is a hole in the ceiling.
 *
 * Kept beside the constants it multiplies so the web route and the bot cannot
 * each invent their own rounding. Seconds in, USD out - no minute rounding,
 * because the ledger stores the probe's exact seconds and a ceil here would
 * bill a 61-second video for two minutes.
 *
 * ZERO SECONDS STILL RESERVES THE PER-RUN PART, and that is the point of the
 * floor rather than an edge case nobody thought about. Zero is what an UPLOAD
 * carries: nothing measures a file's length before this route runs, so the old
 * "zero seconds means zero dollars" rule made an upload reserve 0.00 and left
 * the in-flight bound absent on exactly the path where six concurrent
 * submissions were once seen sailing through. A submission whose length we have
 * not measured is still a run, and a run costs the flat fee whatever it turns
 * out to contain. reviseFreeChargeSeconds re-derives the whole figure once the
 * probe lands, so the floor is only ever what is held in the meantime.
 */
export function estimatedFreeCostUsd(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return FREE_TIER.estimatedUsdPerRun;
  }
  return (
    FREE_TIER.estimatedUsdPerRun +
    (seconds / 60) * FREE_TIER.estimatedUsdPerSourceMinute
  );
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

/** The floor under every plan - an ENGINE fact, not a plan limit.
 *
 *  Measured on the first outside-user corpus (57 jobs, 2026-08-18): sources
 *  under 60s gave 1 clip in 14 jobs; 1-5 minutes gave 13 clips in 20 jobs
 *  (0.65 per job); over 5 minutes gave 98 in 23 (4.3 per job). The engine cuts
 *  clips OUT of talk; there is nothing to cut in a 40-second video, and the
 *  user learns that after a wait and a "no clips" message - or worse, spends
 *  the one zero-clip forgiveness the free tier grants. Duration is known
 *  before a job exists (probe, Telegram metadata, the web client), so the
 *  refusal happens there, in copy that says what works.
 *
 *  `shortNoticeSec` is not a refusal: below it the source is accepted with a
 *  one-line heads-up that short sources usually give 0-2 clips. */
export const SOURCE_FLOOR = {
  minDurationSec: 60,
  shortNoticeSec: 300,
} as const;

/** True when a KNOWN duration is under the floor. Unknown (0/undefined) is
 *  not judged - a document without metadata is not a 30-second video. */
export function isBelowSourceFloor(durationSec: number | undefined | null): boolean {
  return (
    typeof durationSec === "number" &&
    durationSec > 0 &&
    durationSec < SOURCE_FLOOR.minDurationSec
  );
}

/** True when a known duration is at or above the floor but under the notice
 *  line - accepted, but worth a word about what to expect. */
export function isShortSource(durationSec: number | undefined | null): boolean {
  return (
    typeof durationSec === "number" &&
    durationSec >= SOURCE_FLOOR.minDurationSec &&
    durationSec < SOURCE_FLOOR.shortNoticeSec
  );
}

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
