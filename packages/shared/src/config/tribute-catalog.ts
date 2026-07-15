import type { Plan, BillingCycle } from "@prisma/client";

export type TributePeriod = "weekly" | "monthly";

export interface TributeCatalogEntry {
  amount: number; // minor units (cents)
  currency: "eur";
  period: TributePeriod;
  title: string;
  description: string;
}

const DESCRIPTION = "ClipClap subscription";

// Prices mirror the current Tribute products (EUR). MAX is EUR 89.
const CATALOG: Partial<
  Record<Exclude<Plan, "NONE">, Partial<Record<BillingCycle, TributeCatalogEntry>>>
> = {
  STARTER: {
    WEEKLY: { amount: 300, currency: "eur", period: "weekly", title: "ClipClap Starter (weekly)", description: DESCRIPTION },
    MONTHLY: { amount: 900, currency: "eur", period: "monthly", title: "ClipClap Starter (monthly)", description: DESCRIPTION },
  },
  PLUS: {
    MONTHLY: { amount: 2900, currency: "eur", period: "monthly", title: "ClipClap Plus (monthly)", description: DESCRIPTION },
  },
  MAX: {
    MONTHLY: { amount: 8900, currency: "eur", period: "monthly", title: "ClipClap Max (monthly)", description: DESCRIPTION },
  },
};

export function getTributeCatalogEntry(
  plan: Exclude<Plan, "NONE">,
  cycle: BillingCycle
): TributeCatalogEntry {
  const entry = CATALOG[plan]?.[cycle];
  if (!entry) throw new Error(`No Tribute catalog entry for ${plan}/${cycle}`);
  return entry;
}

// The exact plan/cycle pairs offered in the bot (mirrors the current matrix).
export const TRIBUTE_PLAN_OPTIONS: ReadonlyArray<{
  plan: Exclude<Plan, "NONE">;
  cycle: BillingCycle;
}> = [
  { plan: "STARTER", cycle: "WEEKLY" },
  { plan: "STARTER", cycle: "MONTHLY" },
  { plan: "PLUS", cycle: "MONTHLY" },
  { plan: "MAX", cycle: "MONTHLY" },
];
