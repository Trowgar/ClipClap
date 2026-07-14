import type { Plan, SubscriptionStatus } from "@prisma/client";
import { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "../config/billing";

const GRACE_MS = SUBSCRIPTION_GRACE_BUFFER_DAYS * 24 * 60 * 60 * 1000;

export type SubscriptionPhase =
  | "NONE" // no plan / subscriptionStatus NONE
  | "ACTIVE" // period live, healthy
  | "DUNNING" // payment failing, still within grace/period
  | "CANCELED_GRACE" // canceled by user
  | "CANCELED" // canceled / terminated
  | "PERIOD_ENDED"; // ACTIVE/DUNNING but currentPeriodEnd + grace elapsed

export interface SubscriptionState {
  phase: SubscriptionPhase;
  live: boolean; // lifecycle access allowed; quota is checked separately
}

// True while the billing period plus the grace buffer has not elapsed. The
// interval is half-open (exactly at the boundary is NOT live) to match the
// original canSubmitJob check.
export function isPeriodLive(
  currentPeriodEnd: Date | null,
  now: Date
): boolean {
  return (
    currentPeriodEnd != null &&
    currentPeriodEnd.getTime() + GRACE_MS > now.getTime()
  );
}

// Single source of truth for the subscription lifecycle. `live` means lifecycle
// access is allowed (the minute quota is checked separately by canSubmitJob).
// Consumed by canSubmitJob (the gate), getUsageForUser (the account card), and
// the reconcile cron so no surface can disagree about whether a subscription is
// usable. Mirrors the original canSubmitJob allow/deny exactly.
export function getSubscriptionState(
  user: {
    plan: Plan;
    subscriptionStatus: SubscriptionStatus;
    currentPeriodEnd: Date | null;
  },
  now: Date
): SubscriptionState {
  if (user.plan === "NONE" || user.subscriptionStatus === "NONE") {
    return { phase: "NONE", live: false };
  }
  if (user.subscriptionStatus === "CANCELED") {
    return { phase: "CANCELED", live: false };
  }
  if (user.subscriptionStatus === "CANCELED_GRACE") {
    return { phase: "CANCELED_GRACE", live: false };
  }
  // ACTIVE or DUNNING from here.
  if (!isPeriodLive(user.currentPeriodEnd, now)) {
    return { phase: "PERIOD_ENDED", live: false };
  }
  return {
    phase: user.subscriptionStatus === "DUNNING" ? "DUNNING" : "ACTIVE",
    live: true,
  };
}
