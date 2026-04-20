import Stripe from "stripe";
import { prisma } from "../lib/prisma";
import type { Plan } from "@prisma/client";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is required");
  return new Stripe(key);
}

const PLAN_TO_PRICE_ID: Record<string, Plan> = {};

function getPriceIdToPlan(): Record<string, Plan> {
  return {
    [process.env.STRIPE_STARTER_PRICE_ID || ""]: "STARTER",
    [process.env.STRIPE_PRO_PRICE_ID || ""]: "PRO",
  };
}

export async function createCheckoutSession(
  userId: string,
  plan: "STARTER" | "PRO",
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

  const priceId =
    plan === "STARTER"
      ? process.env.STRIPE_STARTER_PRICE_ID
      : process.env.STRIPE_PRO_PRICE_ID;

  if (!priceId) throw new Error(`Price ID not configured for plan: ${plan}`);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { userId },
  });

  return session.url!;
}

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
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      if (!userId) break;

      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;

      // Get the plan from the subscription's price
      if (subscriptionId) {
        const subscription =
          await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = subscription.items.data[0]?.price?.id;
        const priceMap = getPriceIdToPlan();
        const plan = priceId ? priceMap[priceId] : undefined;

        if (plan) {
          await prisma.user.update({
            where: { id: userId },
            data: {
              plan,
              stripeSubscriptionId: subscriptionId,
            },
          });
        }
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data
        .object as Stripe.Subscription;
      await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscription.id },
        data: { plan: "FREE", stripeSubscriptionId: null },
      });
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data
        .object as Stripe.Subscription;
      const priceId = subscription.items.data[0]?.price?.id;
      const priceMap = getPriceIdToPlan();
      const plan = priceId ? priceMap[priceId] : undefined;

      if (plan) {
        await prisma.user.updateMany({
          where: { stripeSubscriptionId: subscription.id },
          data: { plan },
        });
      }
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
