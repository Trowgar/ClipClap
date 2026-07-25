import { getPlanLimits } from "../config/plans";
import type { Plan, BillingCycle } from "@prisma/client";

/**
 * Compute the expiration timestamp for a newly created clip based on the
 * user's plan retention. Used at clip-insert time so the retention cleanup
 * job (Plan 2) can scan WHERE expiresAt <= NOW() AND deletedAt IS NULL.
 *
 * NONE is a real case now, not a defensive one: the free allowance lets a new
 * account produce clips before paying, and those clips live for the NONE
 * plan's retentionDays like any others.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeClipExpiresAt(
  plan: Plan,
  cycle: BillingCycle | null,
  createdAt: Date = new Date()
): Date {
  // Use UTC ms math so retention windows don't drift by 1h across DST
  // transitions on servers in TZ-aware locales.
  const days = getPlanLimits(plan, cycle ?? "MONTHLY").retentionDays;
  return new Date(createdAt.getTime() + days * MS_PER_DAY);
}
