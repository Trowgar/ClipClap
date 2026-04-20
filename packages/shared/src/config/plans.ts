import { Plan } from "@prisma/client";

export interface PlanLimits {
  videosPerWeek: number;
  maxDurationMinutes: number;
  subtitlePresets: string[];
  telegramBot: boolean;
  watermark: boolean;
  priceWeekly: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: {
    videosPerWeek: 2,
    maxDurationMinutes: 10,
    subtitlePresets: ["tiktok"],
    telegramBot: false,
    watermark: true,
    priceWeekly: 0,
  },
  STARTER: {
    videosPerWeek: 10,
    maxDurationMinutes: 60,
    subtitlePresets: ["tiktok", "minimal", "bold"],
    telegramBot: true,
    watermark: false,
    priceWeekly: 3,
  },
  PRO: {
    videosPerWeek: 30,
    maxDurationMinutes: 180,
    subtitlePresets: ["tiktok", "minimal", "bold"],
    telegramBot: true,
    watermark: false,
    priceWeekly: 5,
  },
};

export function getPlanLimits(plan: Plan): PlanLimits {
  return PLAN_LIMITS[plan];
}
