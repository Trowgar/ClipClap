import { prisma } from "../lib/prisma";
import { TOPUP_PACKS, getPlanLimits, type TopupPack } from "../config/plans";
import { getStripe, CHECKOUT_API_VERSION } from "./billing.service";
import { getSubscriptionState } from "./subscription-state";
import { getUsageForUser } from "./usage.service";
import { recordConversionEvent } from "./funnel.service";

// A customer ID alone can belong to an abandoned Checkout.
export class TopupRequiresSubscriptionError extends Error {
  constructor() {
    super("Subscribe to a plan before purchasing top-up minutes.");
    this.name = "TopupRequiresSubscriptionError";
  }
}

export class TopupSourceError extends Error {}

/**
 * Create a Stripe Checkout session for a one-time top-up minute pack.
 *
 * Top-ups are mode="payment" (not subscription); they require an existing
 * Stripe customer and a live, unexpired subscription.
 * On successful payment, the webhook reads metadata.minutes and credits
 * topUpMinutesRemaining via creditTopupMinutes.
 */
export async function createTopupCheckoutSession(
  userId: string,
  pack: TopupPack,
  successUrl: string,
  cancelUrl: string,
  durationSec?: number
): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const now = new Date();
  if (!user.stripeCustomerId || !getSubscriptionState(user, now).live ||
      !user.currentPeriodEnd || user.currentPeriodEnd <= now) {
    throw new TopupRequiresSubscriptionError();
  }
  if (durationSec !== undefined) {
    if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec <= 0) {
      throw new TopupSourceError("Source duration must be a finite positive number of seconds.");
    }
    const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");
    if (durationSec > limits.maxSourceDurationMinutes * 60) {
      throw new TopupSourceError(`Top-ups cannot raise the ${limits.maxSourceDurationMinutes}-minute source limit. Use a shorter source.`);
    }
    const usage = await getUsageForUser(userId);
    const remainingMinutes = usage.minutesLimit + usage.topUpMinutesRemaining - usage.minutesUsed;
    if (durationSec > (remainingMinutes + TOPUP_PACKS[pack].minutes) * 60) {
      throw new TopupSourceError("This top-up plus your remaining balance does not cover this source. Choose a larger pack.");
    }
  }
  const stripe = getStripe();
  const priceId = process.env[TOPUP_PACKS[pack].envKey];
  if (!priceId) throw new Error(`Missing env: ${TOPUP_PACKS[pack].envKey}`);

  const session = await stripe.checkout.sessions.create({
    customer: user.stripeCustomerId,
    mode: "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    invoice_creation: { enabled: true },
    metadata: {
      userId,
      topupPack: pack,
      minutes: String(TOPUP_PACKS[pack].minutes),
    },
  }, { apiVersion: CHECKOUT_API_VERSION });

  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  await recordConversionEvent("web", userId, "checkout_started",
    { provider: "stripe", sessionId: session.id, pack, durationSec },
    `stripe:checkout_started:${session.id}`);

  return session.url!;
}

/**
 * Increment the user's top-up minute balance. Called from the Stripe webhook
 * when a payment-mode checkout session completes.
 *
 * KNOWN ISSUE (deferred to Plan 2): re-delivered webhook events would credit
 * minutes twice. Proper fix is a WebhookEvent { stripeEventId @unique } table
 * for full idempotency across all event handlers, which is Plan 2 scope. In
 * practice Stripe re-delivers terminal events very rarely; the blast radius
 * here is bounded (extra minutes credited, never extra charges).
 */
export async function creditTopupMinutes(
  userId: string,
  minutes: number
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      topUpMinutesRemaining: { increment: minutes },
    },
  });
}
