import { getPlanLimits } from "../config/plans";
import type { Plan, BillingCycle } from "@prisma/client";

/**
 * Compute the expiration timestamp for a newly created clip based on the
 * user's plan retention. Used at clip-insert time so the retention cleanup
 * job (Plan 2) can scan WHERE expiresAt <= NOW() AND deletedAt IS NULL.
 *
 * For NONE plan (which should never create clips, but defensive): returns
 * a 24h expiration so any orphaned clips get cleaned up promptly.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeClipExpiresAt(
  plan: Plan,
  cycle: BillingCycle | null,
  createdAt: Date = new Date()
): Date {
  // Use UTC ms math so retention windows don't drift by 1h across DST
  // transitions on servers in TZ-aware locales.
  const days = plan === "NONE" ? 1 : getPlanLimits(plan, cycle ?? "MONTHLY").retentionDays;
  return new Date(createdAt.getTime() + days * MS_PER_DAY);
}
