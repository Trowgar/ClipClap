import type { SubscriptionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getStripe } from "./billing.service";
import { isPeriodLive } from "./subscription-state";

// Maps a Stripe subscription.status to our local SubscriptionStatus.
// Returns null for transient states (incomplete, paused) we should not act on.
export function mapStripeStatus(
  stripeStatus: string
): SubscriptionStatus | null {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "ACTIVE";
    case "past_due":
    case "unpaid":
      return "DUNNING";
    case "canceled":
    case "incomplete_expired":
      return "CANCELED";
    default:
      return null;
  }
}

// Hourly reconcile: finds ACTIVE/DUNNING users whose period has lapsed and pulls
// the truth from the provider. Stripe is authoritative (retrieve + status map);
// Tribute is push-only, so a lapsed period past grace is date-expired to CANCELED.
export async function reconcileSubscriptions(
  now: Date
): Promise<{ reconciled: number }> {
  const skewMs = 5 * 60 * 1000;
  const cutoff = new Date(now.getTime() - skewMs);

  const users = await prisma.user.findMany({
    where: {
      subscriptionStatus: { in: ["ACTIVE", "DUNNING"] },
      currentPeriodEnd: { lt: cutoff },
    },
    select: {
      id: true,
      stripeSubscriptionId: true,
      tributeSubscriptionId: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
    },
  });

  let reconciled = 0;

  for (const user of users) {
    // Stripe takes precedence if a user somehow has both IDs set (a payment-channel
    // switch edge case; neither service clears the other's id).
    if (user.stripeSubscriptionId) {
      const stripe = getStripe();
      let sub;
      try {
        sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
      } catch (err) {
        console.error(
          `[reconcile] user=${user.id} stripe retrieve failed; skipping:`,
          err
        );
        continue;
      }

      const nextStatus = mapStripeStatus(sub.status);
      if (!nextStatus) continue;

      const data: {
        subscriptionStatus: SubscriptionStatus;
        currentPeriodStart: Date;
        currentPeriodEnd: Date;
        dunningSince?: Date | null;
      } = {
        subscriptionStatus: nextStatus,
        currentPeriodStart: new Date(sub.current_period_start * 1000),
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
      };
      if (nextStatus === "ACTIVE") data.dunningSince = null;
      // First path to detect the failure (missed invoice.payment_failed webhook):
      // stamp dunningSince on the transition only, mirroring the webhook's guard so
      // an already-DUNNING user keeps the original stamp.
      if (nextStatus === "DUNNING" && user.subscriptionStatus !== "DUNNING") {
        data.dunningSince = now;
      }

      if (nextStatus !== user.subscriptionStatus) {
        console.log(
          `[reconcile] user=${user.id} ${user.subscriptionStatus}→${nextStatus} reason=stripe_status=${sub.status}`
        );
      }
      await prisma.user.update({ where: { id: user.id }, data });
      reconciled++;
    } else if (user.tributeSubscriptionId) {
      if (!isPeriodLive(user.currentPeriodEnd, now)) {
        console.log(
          `[reconcile] user=${user.id} ${user.subscriptionStatus}→CANCELED reason=tribute_period_expired_grace_elapsed`
        );
        await prisma.user.update({
          where: { id: user.id },
          data: { subscriptionStatus: "CANCELED", graceEndsAt: null },
        });
        reconciled++;
      }
    } else {
      // No provider subscription attached (manual grant / stale row). A lapsed
      // period can never self-renew, so date-expire it once grace has elapsed -
      // mirrors the Tribute branch and stops a stuck ACTIVE row from lasting
      // forever (the account-card-vs-gate contradiction this fix targets).
      if (!isPeriodLive(user.currentPeriodEnd, now)) {
        console.log(
          `[reconcile] user=${user.id} ${user.subscriptionStatus}→CANCELED reason=provider_absent_period_expired`
        );
        await prisma.user.update({
          where: { id: user.id },
          data: { subscriptionStatus: "CANCELED", graceEndsAt: null },
        });
        reconciled++;
      }
    }
  }

  return { reconciled };
}
