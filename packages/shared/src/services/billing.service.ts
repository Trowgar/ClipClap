import Stripe from "stripe";
import { prisma } from "../lib/prisma";
import type { Plan, BillingCycle } from "@prisma/client";
import { getPlanFromPriceId } from "../config/plans";
import { notifyPaymentEvent } from "./telegram-notification.service";

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

// Webhook handler - routes Stripe lifecycle events that mutate User state:
// DUNNING on payment failure, ACTIVE on payment success, 7-day grace on
// cancellation, plan/cycle changes on subscription updates, and top-up
// minute credits on one-time payment completions.
export async function handleWebhook(
  body: string,
  signature: string
): Promise<void> {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is required");

  const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);

  // Idempotency: skip events already processed. Recorded AFTER the switch below
  // so an event that throws mid-processing is retried by Stripe, not skipped.
  const seen = await prisma.stripeWebhookEvent.findUnique({
    where: { eventId: event.id },
  });
  if (seen) return;

  switch (event.type) {
    case "checkout.session.completed": {
      const sess = event.data.object as Stripe.Checkout.Session;
      const userId = sess.metadata?.userId;
      if (!userId) break;

      // Top-up: one-time payment crediting minutes.
      if (sess.mode === "payment") {
        const minutes = Number(sess.metadata?.minutes ?? "0");
        if (minutes > 0) {
          // Dynamic import avoids a circular dependency: topup.service
          // imports getStripe from this module.
          const { creditTopupMinutes } = await import("./topup.service");
          await creditTopupMinutes(userId, minutes);
        }
        break;
      }

      // Subscription completion: activate plan with current period end.
      if (sess.mode !== "subscription") break;

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
          topUpMinutesRemaining: 0,
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        },
      });

      await notifyPaymentEvent(userId, {
        kind: "subscription_activated",
        plan: mapped.plan,
        periodEnd: new Date(subscription.current_period_end * 1000),
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
      // Don't immediately cancel - Stripe Smart Retries reattempts at
      // days 3/7/12. We only flip to DUNNING and stamp dunningSince.
      // Idempotent: only stamp dunningSince on the FIRST failure so a
      // re-delivered event doesn't re-stamp "yesterday" as "today".
      const updated = await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscriptionId, dunningSince: null },
        data: {
          subscriptionStatus: "DUNNING",
          dunningSince: new Date(),
        },
      });

      // Only notify on the first failure (matches the dunningSince guard).
      if (updated.count > 0) {
        const user = await prisma.user.findUnique({
          where: { stripeSubscriptionId: subscriptionId },
          select: { id: true },
        });
        if (user) {
          const manageUrl = `${
            process.env.APP_URL || process.env.NEXTAUTH_URL || "https://clipclap.io"
          }/dashboard/plans`;
          await notifyPaymentEvent(user.id, {
            kind: "payment_failed",
            manageUrl,
          });
        }
      }
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
          topUpMinutesRemaining: 0,
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        },
      });

      // Notify on renewal only - first invoice ("subscription_create") is
      // already covered by checkout.session.completed.
      if (invoice.billing_reason === "subscription_cycle") {
        const user = await prisma.user.findUnique({
          where: { stripeSubscriptionId: subscriptionId },
          select: { id: true, plan: true },
        });
        if (user && user.plan !== "NONE") {
          await notifyPaymentEvent(user.id, {
            kind: "subscription_renewed",
            plan: user.plan,
            periodEnd: new Date(subscription.current_period_end * 1000),
          });
        }
      }

      // Referral accrual: attribute 30% of net to the payer's referrer.
      try {
        const payer = await prisma.user.findUnique({
          where: { stripeSubscriptionId: subscriptionId },
          select: { id: true },
        });
        if (payer && invoice.amount_paid > 0) {
          // Real processor fee from the balance transaction when available.
          let feeUsd = 0;
          const bt = invoice.charge
            ? await stripe.charges
                .retrieve(
                  typeof invoice.charge === "string" ? invoice.charge : invoice.charge.id,
                  { expand: ["balance_transaction"] }
                )
                .then((c) => c.balance_transaction)
                .catch((err) => { console.warn("[referral] charges.retrieve failed, fee defaulted to 0:", err); return null; })
            : null;
          // Stripe prices for this product are USD-only
          if (bt && typeof bt !== "string") feeUsd = bt.fee / 100;

          const paidAtSec =
            invoice.status_transitions?.paid_at ?? invoice.created;
          const { recordCommission } = await import("./referral.service");
          await recordCommission({
            payerUserId: payer.id,
            source: "STRIPE",
            externalPaymentId: invoice.id,
            originalCurrency: invoice.currency ?? "usd",
            originalAmount: invoice.amount_paid / 100,
            exchangeRateToUsd: 1, // Stripe prices for this product are USD-only
            grossAmountUsd: invoice.amount_paid / 100,
            processorFeeUsd: feeUsd,
            paidAt: new Date(paidAtSec * 1000),
          });
        }
      } catch (err) {
        console.error("[referral] accrual failed:", err);
        // Do NOT rethrow - referral is non-critical relative to billing.
      }
      break;
    }

    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const invoiceId =
        typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id;
      try {
        if (invoiceId) {
          const { voidCommission } = await import("./referral.service");
          await voidCommission("STRIPE", invoiceId, "charge.refunded");
        }
      } catch (err) {
        console.error("[referral] clawback (charge.refunded) failed:", err);
        // Do NOT rethrow - referral is non-critical relative to billing.
      }
      break;
    }

    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      const chargeId =
        typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
      try {
        if (chargeId) {
          const charge = await stripe.charges.retrieve(chargeId).catch(() => null);
          const rawInvoice = charge?.invoice ?? null;
          const invoiceId =
            typeof rawInvoice === "string"
              ? rawInvoice
              : typeof rawInvoice === "object" && rawInvoice !== null
                ? rawInvoice.id
                : undefined;
          if (invoiceId) {
            const { voidCommission } = await import("./referral.service");
            await voidCommission("STRIPE", invoiceId, "charge.dispute.created");
          }
        }
      } catch (err) {
        console.error("[referral] clawback (charge.dispute.created) failed:", err);
        // Do NOT rethrow - referral is non-critical relative to billing.
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      // 7-day grace: clips remain accessible read-only until B3 cleanup job.
      // Idempotent: only set graceEndsAt on the FIRST delete event so a
      // re-delivered event doesn't push the deadline further into the future.
      const graceEnd = new Date();
      graceEnd.setDate(graceEnd.getDate() + 7);
      const updated = await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscription.id, graceEndsAt: null },
        data: {
          subscriptionStatus: "CANCELED_GRACE",
          graceEndsAt: graceEnd,
        },
      });

      if (updated.count > 0) {
        const user = await prisma.user.findUnique({
          where: { stripeSubscriptionId: subscription.id },
          select: { id: true },
        });
        if (user) {
          await notifyPaymentEvent(user.id, {
            kind: "subscription_canceled",
            graceEndsAt: graceEnd,
          });
        }
      }
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

  // Mark processed. try/catch absorbs the unique-violation from a rare
  // concurrent double-delivery (both passed the findUnique check above).
  try {
    await prisma.stripeWebhookEvent.create({
      data: { eventId: event.id, type: event.type },
    });
  } catch {
    // already recorded concurrently - treat as duplicate, nothing to do
  }
}

export interface InvoiceRow {
  id: string;
  number: string | null;
  createdAt: string;
  description: string;
  amount: number;
  currency: string;
  status: string;
  invoicePdf: string | null;
  hostedUrl: string | null;
}

export interface InvoicePage {
  invoices: InvoiceRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

export async function listInvoices(
  userId: string,
  opts: { cursor?: string; limit?: number } = {}
): Promise<InvoicePage> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.stripeCustomerId) {
    return { invoices: [], hasMore: false, nextCursor: null };
  }

  const limit = opts.limit ?? 20;
  const stripe = getStripe();
  const list = await stripe.invoices.list({
    customer: user.stripeCustomerId,
    limit,
    ...(opts.cursor ? { starting_after: opts.cursor } : {}),
  });

  const invoices = list.data.map((inv) => {
    const firstLine = inv.lines.data[0];
    const description =
      firstLine?.description ?? inv.description ?? "Charge";
    return {
      id: inv.id,
      number: inv.number,
      createdAt: new Date(inv.created * 1000).toISOString(),
      description,
      amount: inv.total / 100,
      currency: inv.currency.toUpperCase(),
      status: inv.status ?? "unknown",
      invoicePdf: inv.invoice_pdf ?? null,
      hostedUrl: inv.hosted_invoice_url ?? null,
    };
  });

  return {
    invoices,
    hasMore: list.has_more,
    nextCursor: list.has_more ? invoices[invoices.length - 1]?.id ?? null : null,
  };
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
