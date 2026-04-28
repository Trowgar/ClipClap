import Stripe from "stripe";
import { prisma } from "../lib/prisma";
import type { Plan, BillingCycle } from "@prisma/client";
import { getPlanFromPriceId } from "../config/plans";

// 4xx-class: caller picked an invalid plan/cycle combination. Safe to surface
// to end users.
export class UnsupportedPlanCycleError extends Error {
  constructor(plan: Plan, cycle: BillingCycle) {
    super(
      `Plan ${plan} does not support ${cycle.toLowerCase()} billing. ` +
        `Choose a different combination.`
    );
    this.name = "UnsupportedPlanCycleError";
  }
}

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
  throw new UnsupportedPlanCycleError(plan, cycle);
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
    // Propagate metadata to the resulting Subscription so webhook events for
    // renewals, plan changes, and cancellations carry user context. Without
    // this, customer.subscription.* events arrive with empty metadata and the
    // webhook would have to look up the user by stripeSubscriptionId.
    subscription_data: {
      metadata: { userId, plan, cycle },
    },
  });

  return session.url!;
}

// Webhook handler — routes Stripe lifecycle events that mutate User state:
// DUNNING on payment failure, ACTIVE on payment success, 7-day grace on
// cancellation, plan/cycle changes on subscription updates.
export async function handleWebhook(
  body: string,
  signature: string
): Promise<void> {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is required");

  const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);

  switch (event.type) {
    case "checkout.session.completed": {
      const sess = event.data.object as Stripe.Checkout.Session;
      // Top-up purchases use mode="payment"; subscriptions are mode="subscription".
      if (sess.mode !== "subscription") break;

      const userId = sess.metadata?.userId;
      if (!userId) break;

      const subscriptionId =
        typeof sess.subscription === "string"
          ? sess.subscription
          : sess.subscription?.id;
      if (!subscriptionId) break;

      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const priceId = subscription.items.data[0]?.price?.id;
      const mapped = priceId ? getPlanFromPriceId(priceId) : null;
      if (!mapped) break;

      await prisma.user.updateMany({
        where: { id: userId },
        data: {
          plan: mapped.plan,
          billingCycle: mapped.cycle,
          subscriptionStatus: "ACTIVE",
          stripeSubscriptionId: subscriptionId,
          dunningSince: null,
          graceEndsAt: null,
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        },
      });
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id;
      if (!subscriptionId) break;
      // Don't immediately cancel — Stripe Smart Retries reattempts at
      // days 3/7/12. We only flip to DUNNING and stamp dunningSince.
      await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: {
          subscriptionStatus: "DUNNING",
          dunningSince: new Date(),
        },
      });
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id;
      if (!subscriptionId) break;

      // Pull authoritative current_period_end from the subscription itself
      // (invoice.period_end is the line-item period, which can differ from
      // the subscription's renewal anchor in proration scenarios).
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: {
          subscriptionStatus: "ACTIVE",
          dunningSince: null,
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        },
      });
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      // 7-day grace: clips remain accessible read-only until B3 cleanup job.
      const graceEnd = new Date();
      graceEnd.setDate(graceEnd.getDate() + 7);
      await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscription.id },
        data: {
          subscriptionStatus: "CANCELED_GRACE",
          graceEndsAt: graceEnd,
        },
      });
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const priceId = subscription.items.data[0]?.price?.id;
      const mapped = priceId ? getPlanFromPriceId(priceId) : null;
      if (!mapped) break;
      await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscription.id },
        data: {
          plan: mapped.plan,
          billingCycle: mapped.cycle,
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        },
      });
      break;
    }
  }
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
