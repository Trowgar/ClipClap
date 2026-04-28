import Stripe from "stripe";
import { prisma } from "../lib/prisma";
import type { Plan, BillingCycle } from "@prisma/client";

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is required");
  return new Stripe(key);
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

function priceIdFor(plan: Exclude<Plan, "NONE">, cycle: BillingCycle): string {
  if (plan === "STARTER" && cycle === "WEEKLY") {
    return requireEnv("STRIPE_STARTER_WEEKLY_PRICE_ID");
  }
  if (plan === "STARTER" && cycle === "MONTHLY") {
    return requireEnv("STRIPE_STARTER_MONTHLY_PRICE_ID");
  }
  if (plan === "PLUS" && cycle === "MONTHLY") {
    return requireEnv("STRIPE_PLUS_MONTHLY_PRICE_ID");
  }
  if (plan === "MAX" && cycle === "MONTHLY") {
    return requireEnv("STRIPE_MAX_MONTHLY_PRICE_ID");
  }
  throw new Error(
    `Unsupported plan/cycle combination: ${plan}/${cycle}. ` +
      `PLUS and MAX have no weekly cycle.`
  );
}

export async function createCheckoutSession(
  userId: string,
  plan: Exclude<Plan, "NONE">,
  cycle: BillingCycle,
  successUrl: string,
  cancelUrl: string
): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const stripe = getStripe();

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { userId },
    });
    customerId = customer.id;
    await prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: customerId },
    });
  }

  const priceId = priceIdFor(plan, cycle);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { userId, plan, cycle },
  });

  return session.url!;
}

// Webhook handler — minimal stub. Full lifecycle handling (DUNNING, grace,
// plan changes, top-up credits) is implemented in Block B2.
export async function handleWebhook(
  body: string,
  signature: string
): Promise<void> {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is required");

  // Verify signature; events are not yet routed.
  stripe.webhooks.constructEvent(body, signature, webhookSecret);
}

export async function getSubscription(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  if (!user.stripeSubscriptionId) {
    return { plan: user.plan, subscription: null };
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(
    user.stripeSubscriptionId
  );

  return {
    plan: user.plan,
    subscription: {
      status: subscription.status,
      currentPeriodEnd: new Date(
        subscription.current_period_end * 1000
      ).toISOString(),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    },
  };
}
