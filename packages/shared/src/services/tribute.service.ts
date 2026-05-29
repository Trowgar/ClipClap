import { createHash, createHmac, timingSafeEqual } from "crypto";
import { prisma } from "../lib/prisma";
import { notifyPaymentEvent } from "./telegram-notification.service";
import type { Plan, BillingCycle } from "@prisma/client";

export const TRIBUTE_SIGNATURE_HEADER = "trbt-signature";

export type TributeEventName =
  | "newSubscription"
  | "renewedSubscription"
  | "cancelledSubscription"
  | string;

export interface TributeSubscriptionPayload {
  subscription_name?: string;
  subscription_id: string;
  period_id?: string;
  period?: string;
  price?: number;
  amount?: number;
  currency?: string;
  trb_user_id?: string;
  telegram_user_id: number | string;
  telegram_username?: string | null;
  channel_id?: string | null;
  channel_name?: string | null;
  expires_at: string;
  type?: string;
  cancel_reason?: string;
  email?: string | null;
  web_app_link?: string | null;
}

export interface TributeWebhookEnvelope {
  name: TributeEventName;
  created_at: string;
  sent_at: string;
  payload: TributeSubscriptionPayload;
}

export interface TributePlanBinding {
  plan: Plan;
  billingCycle: BillingCycle;
}

export type TributeProductMap = Readonly<Record<string, TributePlanBinding>>;

export type TributeProcessOutcome =
  | { status: "duplicate" }
  | { status: "unmapped_subscription"; subscriptionId: string }
  | { status: "ignored_event"; name: string }
  | { status: "applied"; userId: string; plan: Plan; eventName: string }
  | { status: "cancelled"; userId: string; eventName: string };

export function verifyTributeSignature(
  rawBody: string,
  signatureHeader: string | null,
  apiKey: string
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", apiKey).update(rawBody).digest("hex");
  const received = signatureHeader.trim().toLowerCase();
  if (expected.length !== received.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  } catch {
    return false;
  }
}

export function hashTributeEvent(envelope: TributeWebhookEnvelope): string {
  const key = [
    envelope.name,
    envelope.sent_at,
    envelope.payload?.subscription_id ?? "",
    envelope.payload?.period_id ?? "",
    envelope.payload?.telegram_user_id ?? "",
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}

export async function processTributeEvent(
  envelope: TributeWebhookEnvelope,
  productMap: TributeProductMap
): Promise<TributeProcessOutcome> {
  const eventHash = hashTributeEvent(envelope);

  const existing = await prisma.tributeWebhookEvent.findUnique({
    where: { eventHash },
  });
  if (existing) {
    return { status: "duplicate" };
  }

  try {
    await prisma.tributeWebhookEvent.create({
      data: {
        eventHash,
        name: envelope.name,
        payload: envelope as unknown as object,
      },
    });
  } catch {
    return { status: "duplicate" };
  }

  switch (envelope.name) {
    case "newSubscription":
    case "renewedSubscription":
      return applySubscription(envelope, productMap);
    case "cancelledSubscription":
      return applyCancellation(envelope);
    default:
      return { status: "ignored_event", name: envelope.name };
  }
}

async function applySubscription(
  envelope: TributeWebhookEnvelope,
  productMap: TributeProductMap
): Promise<TributeProcessOutcome> {
  const payload = envelope.payload;
  const binding =
    (payload.period_id ? productMap[payload.period_id] : undefined) ??
    productMap[payload.subscription_id];
  if (!binding) {
    return {
      status: "unmapped_subscription",
      subscriptionId: payload.period_id || payload.subscription_id,
    };
  }

  const telegramId = String(payload.telegram_user_id);
  const expiresAt = new Date(payload.expires_at);
  const tributeSubscriptionId = String(payload.subscription_id);

  const user = await prisma.user.upsert({
    where: { telegramId },
    update: {
      plan: binding.plan,
      billingCycle: binding.billingCycle,
      currentPeriodEnd: expiresAt,
      subscriptionStatus: "ACTIVE",
      tributeSubscriptionId,
      dunningSince: null,
      graceEndsAt: null,
    },
    create: {
      telegramId,
      name: payload.telegram_username ?? `Telegram ${telegramId}`,
      plan: binding.plan,
      billingCycle: binding.billingCycle,
      currentPeriodEnd: expiresAt,
      subscriptionStatus: "ACTIVE",
      tributeSubscriptionId,
    },
  });

  await notifyPaymentEvent(user.id, {
    kind:
      envelope.name === "newSubscription"
        ? "subscription_activated"
        : "subscription_renewed",
    plan: binding.plan,
    periodEnd: expiresAt,
  });

  const amount = payload.amount ?? payload.price ?? 0;
  if (amount > 0) {
    const currency = (payload.currency ?? "usd").toLowerCase();
    const externalPaymentId =
      payload.period_id ?? `${tributeSubscriptionId}:${payload.expires_at}`;
    const { recordCommission } = await import("./referral.service");
    const { exchangeRateToUsd, REFERRAL_CONFIG } = await import("../config/referral");
    const rate = exchangeRateToUsd(currency);
    const grossAmountUsd = (amount / 100) * rate; // Tribute amounts are in minor units
    const feeRateBps = REFERRAL_CONFIG.feeRateBps.TRIBUTE ?? 0;
    const processorFeeUsd = (grossAmountUsd * feeRateBps) / 10000;
    await recordCommission({
      payerUserId: user.id,
      source: "TRIBUTE",
      externalPaymentId,
      originalCurrency: currency,
      originalAmount: amount / 100,
      exchangeRateToUsd: rate,
      grossAmountUsd,
      processorFeeUsd,
      paidAt: new Date(),
    });
  }

  return {
    status: "applied",
    userId: user.id,
    plan: binding.plan,
    eventName: envelope.name,
  };
}

async function applyCancellation(
  envelope: TributeWebhookEnvelope
): Promise<TributeProcessOutcome> {
  const telegramId = String(envelope.payload.telegram_user_id);
  const expiresAt = new Date(envelope.payload.expires_at);

  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) {
    return { status: "ignored_event", name: envelope.name };
  }

  const now = new Date();
  const stillActive = expiresAt > now;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      subscriptionStatus: stillActive ? "CANCELED_GRACE" : "CANCELED",
      graceEndsAt: stillActive ? expiresAt : null,
    },
  });

  // Cancellation ends future Tribute billing; there is no past payment to claw
  // back here. Future renewals simply stop arriving. (Refund events, if Tribute
  // ever sends them, would be handled separately.)

  await notifyPaymentEvent(user.id, {
    kind: "subscription_canceled",
    graceEndsAt: stillActive ? expiresAt : null,
  });

  return { status: "cancelled", userId: user.id, eventName: envelope.name };
}

export function loadTributeProductMapFromEnv(env: NodeJS.ProcessEnv): TributeProductMap {
  const map: Record<string, TributePlanBinding> = {};
  const tiers: Array<{ envKey: string; plan: Plan; billingCycle: BillingCycle }> = [
    { envKey: "TRIBUTE_PRODUCT_STARTER_WEEKLY_ID", plan: "STARTER", billingCycle: "WEEKLY" },
    { envKey: "TRIBUTE_PRODUCT_STARTER_MONTHLY_ID", plan: "STARTER", billingCycle: "MONTHLY" },
    { envKey: "TRIBUTE_PRODUCT_PLUS_MONTHLY_ID", plan: "PLUS", billingCycle: "MONTHLY" },
    { envKey: "TRIBUTE_PRODUCT_MAX_MONTHLY_ID", plan: "MAX", billingCycle: "MONTHLY" },
  ];
  for (const tier of tiers) {
    const id = env[tier.envKey];
    if (id) {
      map[id] = { plan: tier.plan, billingCycle: tier.billingCycle };
    }
  }
  return map;
}
