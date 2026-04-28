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
export function computeClipExpiresAt(
  plan: Plan,
  cycle: BillingCycle | null,
  createdAt: Date = new Date()
): Date {
  if (plan === "NONE") {
    return new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
  }
  const limits = getPlanLimits(plan, cycle ?? "MONTHLY");
  const out = new Date(createdAt);
  out.setDate(out.getDate() + limits.retentionDays);
  return out;
}
