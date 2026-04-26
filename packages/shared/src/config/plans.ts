import type { Plan, BillingCycle } from "@prisma/client";

export interface PlanLimits {
  minutesPerPeriod: number;
  storageClips: number;
  retentionDays: number;
  subtitlePresets: string[];
  priorityQueue: boolean;
  concurrentJobsLimit: number;
  maxSourceDurationMinutes: number;
  maxFileSizeBytes: number;
  maxJobsPerDay: number;
  priceUsd: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

const ABUSE_CAPS = {
  maxSourceDurationMinutes: 180,
  maxFileSizeBytes: 2 * GB,
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
      subtitlePresets: ["tiktok"],
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
      subtitlePresets: ["tiktok"],
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
      subtitlePresets: ["tiktok", "minimal", "bold"],
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
      subtitlePresets: ["tiktok", "minimal", "bold"],
      priorityQueue: true,
      concurrentJobsLimit: 3,
      maxSourceDurationMinutes: ABUSE_CAPS.maxSourceDurationMinutes,
      maxFileSizeBytes: ABUSE_CAPS.maxFileSizeBytes,
      maxJobsPerDay: 100,
      priceUsd: 89,
    },
  },
};

const NONE_LIMITS: PlanLimits = {
  minutesPerPeriod: 0,
  storageClips: 0,
  retentionDays: 0,
  subtitlePresets: [],
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
  const map: Record<string, { plan: Plan; cycle: BillingCycle }> = {
    [process.env.STRIPE_STARTER_WEEKLY_PRICE_ID ?? ""]: { plan: "STARTER", cycle: "WEEKLY" },
    [process.env.STRIPE_STARTER_MONTHLY_PRICE_ID ?? ""]: { plan: "STARTER", cycle: "MONTHLY" },
    [process.env.STRIPE_PLUS_MONTHLY_PRICE_ID ?? ""]: { plan: "PLUS", cycle: "MONTHLY" },
    [process.env.STRIPE_MAX_MONTHLY_PRICE_ID ?? ""]: { plan: "MAX", cycle: "MONTHLY" },
  };
  delete map[""];
  return map[priceId] ?? null;
}

export const TOPUP_PACKS = {
  SMALL: { minutes: 100, priceUsd: 6, envKey: "STRIPE_TOPUP_SMALL_PRICE_ID" },
  LARGE: { minutes: 300, priceUsd: 15, envKey: "STRIPE_TOPUP_LARGE_PRICE_ID" },
} as const;

export type TopupPack = keyof typeof TOPUP_PACKS;
