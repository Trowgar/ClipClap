import { prisma } from "../lib/prisma";
import { TOPUP_PACKS, type TopupPack } from "../config/plans";
import { getStripe } from "./billing.service";

// 4xx-class: user must have an active Stripe customer (i.e. has subscribed
// at some point). Safe to surface as "subscribe first" guidance.
export class TopupRequiresSubscriptionError extends Error {
  constructor() {
    super("Subscribe to a plan before purchasing top-up minutes.");
    this.name = "TopupRequiresSubscriptionError";
  }
}

/**
 * Create a Stripe Checkout session for a one-time top-up minute pack.
 *
 * Top-ups are mode="payment" (not subscription); they require an existing
 * Stripe customer, so the user must have subscribed to a plan at least once.
 * On successful payment, the webhook reads metadata.minutes and credits
 * topUpMinutesRemaining via creditTopupMinutes.
 */
export async function createTopupCheckoutSession(
  userId: string,
  pack: TopupPack,
  successUrl: string,
  cancelUrl: string
): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.stripeCustomerId) {
    throw new TopupRequiresSubscriptionError();
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
    metadata: {
      userId,
      topupPack: pack,
      minutes: String(TOPUP_PACKS[pack].minutes),
    },
  });

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
