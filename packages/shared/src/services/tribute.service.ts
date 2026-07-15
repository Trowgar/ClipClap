import { createHash, createHmac, timingSafeEqual } from "crypto";
import { prisma } from "../lib/prisma";
import { notifyPaymentEvent } from "./telegram-notification.service";
import type { Plan, TributeOrder, TributeWebhookStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";

export const TRIBUTE_SIGNATURE_HEADER = "trbt-signature";

export function canonicalTributeEventName(name: string): string {
  // "shop_order_charge_success" | "shopOrderChargeSuccess" -> "shoporderchargesuccess"
  return name.toLowerCase().replace(/[_\s-]/g, "");
}

export interface TributeShopPayload {
  uuid: string;
  status?: string;
  period?: string;
  memberStatus?: string;
  memberExpiresAt?: string;
  transactionId?: number | string;
  amount?: number;
  currency?: string;
  customerId?: string;
  cancelReason?: string;
  [key: string]: unknown;
}

export interface TributeShopWebhookEnvelope {
  name: string;
  created_at: string;
  sent_at: string;
  payload: TributeShopPayload;
}

export type TributeProcessOutcome =
  | { status: "duplicate" }
  | { status: "unknown_order"; orderUuid: string }
  | { status: "ignored_event"; name: string }
  | { status: "activated"; userId: string; plan: Plan }
  | { status: "renewed"; userId: string; plan: Plan }
  | { status: "dunning"; userId: string }
  | { status: "cancelled"; userId: string }
  | { status: "refund_recorded"; orderUuid: string }
  | { status: "payment_failed"; orderUuid: string }
  | { status: "stale_order"; orderUuid: string };

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

export function hashTributeEvent(envelope: TributeShopWebhookEnvelope): string {
  const p = envelope.payload;
  const canon = canonicalTributeEventName(envelope.name);
  // Stable across delivery retries (excludes sent_at). Each key carries a
  // per-occurrence discriminator so two genuine events never collide.
  let discriminator: string;
  if (canon === "shoporderrefunded") {
    discriminator = `tx:${p.transactionId ?? ""}`;
  } else if (canon === "shoporderchargefailed" || canon === "shoporderpaymentfailed") {
    discriminator = `at:${envelope.created_at ?? ""}`;
  } else {
    discriminator = `exp:${p.memberExpiresAt ?? ""}`;
  }
  const key = [canon, String(p.uuid ?? ""), discriminator].join("|");
  return createHash("sha256").update(key).digest("hex");
}

// A PROCESSING row whose handler crashed mid-flight is reclaimable after this lease.
const PROCESSING_LEASE_MS = 15 * 60_000;

function terminalStatusFor(outcome: TributeProcessOutcome): TributeWebhookStatus {
  switch (outcome.status) {
    case "activated":
    case "renewed":
    case "dunning":
    case "cancelled":
    case "refund_recorded":
    case "payment_failed":
    case "stale_order":
      return "APPLIED";
    case "ignored_event":
      return "IGNORED";
    case "unknown_order":
    case "duplicate": // not reached here; kept for exhaustiveness
      return "FAILED";
  }
}

export async function processTributeEvent(
  envelope: TributeShopWebhookEnvelope
): Promise<TributeProcessOutcome> {
  const eventHash = hashTributeEvent(envelope);

  // 1. Ensure an inbox row exists (RECEIVED). Only a P2002 conflict means "already received".
  let inserted = true;
  try {
    await prisma.tributeWebhookEvent.create({
      data: { eventHash, name: envelope.name, payload: envelope as unknown as object, status: "RECEIVED" },
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
      throw err;
    }
    inserted = false;
  }

  if (!inserted) {
    const existing = await prisma.tributeWebhookEvent.findUnique({ where: { eventHash } });
    if (!existing || existing.status === "APPLIED" || existing.status === "IGNORED") {
      return { status: "duplicate" };
    }
  }

  // 2. Atomically claim RECEIVED/FAILED (or a PROCESSING row past the lease) -> PROCESSING.
  const staleCutoff = new Date(Date.now() - PROCESSING_LEASE_MS);
  const claim = await prisma.tributeWebhookEvent.updateMany({
    where: {
      eventHash,
      OR: [
        { status: { in: ["RECEIVED", "FAILED"] } },
        { status: "PROCESSING", updatedAt: { lt: staleCutoff } },
      ],
    },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });
  if (claim.count !== 1) {
    return { status: "duplicate" };
  }

  // 3. Dispatch to business handlers.
  let outcome: TributeProcessOutcome;
  try {
    outcome = await dispatchTributeEvent(envelope);
  } catch (err) {
    await prisma.tributeWebhookEvent.update({
      where: { eventHash },
      data: { status: "FAILED", lastError: err instanceof Error ? err.message : String(err) },
    });
    throw err; // route returns 5xx -> Tribute retries
  }

  // 4. Persist terminal status.
  const status = terminalStatusFor(outcome);
  await prisma.tributeWebhookEvent.update({
    where: { eventHash },
    data: {
      status,
      outcome: outcome.status,
      processedAt: status === "APPLIED" || status === "IGNORED" ? new Date() : null,
      lastError: status === "FAILED" ? `outcome=${outcome.status}` : null,
    },
  });

  return outcome;
}

async function accrueReferral(order: TributeOrder, expiresAt: Date): Promise<void> {
  // Non-critical: never let referral accrual fail an activation.
  try {
    if (order.amount > 0) {
      const currency = order.currency.toLowerCase();
      const externalPaymentId = `${order.orderUuid}:${expiresAt.toISOString()}`;
      const { recordCommission } = await import("./referral.service");
      const { exchangeRateToUsd, REFERRAL_CONFIG } = await import("../config/referral");
      const rate = exchangeRateToUsd(currency);
      const grossAmountUsd = (order.amount / 100) * rate;
      const feeRateBps = REFERRAL_CONFIG.feeRateBps.TRIBUTE ?? 0;
      const processorFeeUsd = (grossAmountUsd * feeRateBps) / 10000;
      await recordCommission({
        payerUserId: order.userId,
        source: "TRIBUTE",
        externalPaymentId,
        originalCurrency: currency,
        originalAmount: order.amount / 100,
        exchangeRateToUsd: rate,
        grossAmountUsd,
        processorFeeUsd,
        paidAt: new Date(),
      });
    }
  } catch (err) {
    console.error("[referral] accrual failed:", err);
  }
}

async function applyOrderPayment(
  envelope: TributeShopWebhookEnvelope,
  isRenewal: boolean
): Promise<TributeProcessOutcome> {
  const p = envelope.payload;
  const orderUuid = String(p.uuid ?? "");
  const order = await prisma.tributeOrder.findUnique({ where: { orderUuid } });
  if (!order) return { status: "unknown_order", orderUuid };
  if (!p.memberExpiresAt) {
    throw new Error(`payment event for ${orderUuid} missing memberExpiresAt`);
  }
  const expiresAt = new Date(p.memberExpiresAt);

  const user = await prisma.user.findUnique({
    where: { id: order.userId },
    select: { id: true, currentPeriodEnd: true },
  });
  if (!user) return { status: "unknown_order", orderUuid };
  // Assign (never increment); reject an out-of-order older event.
  if (user.currentPeriodEnd && expiresAt < user.currentPeriodEnd) {
    return { status: "stale_order", orderUuid };
  }

  await prisma.user.update({
    where: { id: order.userId },
    data: {
      plan: order.plan,
      billingCycle: order.billingCycle,
      currentPeriodEnd: expiresAt,
      subscriptionStatus: "ACTIVE",
      tributeSubscriptionId: orderUuid,
      dunningSince: null,
      graceEndsAt: null,
    },
  });
  if (order.status !== "PAID") {
    await prisma.tributeOrder.update({ where: { orderUuid }, data: { status: "PAID" } });
  }

  await accrueReferral(order, expiresAt);

  try {
    await notifyPaymentEvent(order.userId, {
      kind: isRenewal ? "subscription_renewed" : "subscription_activated",
      plan: order.plan,
      periodEnd: expiresAt,
    });
  } catch (err) {
    console.warn("[tribute] notification failed (activation stands):", err instanceof Error ? err.message : err);
  }

  return { status: isRenewal ? "renewed" : "activated", userId: order.userId, plan: order.plan };
}

async function applyChargeFailed(
  envelope: TributeShopWebhookEnvelope
): Promise<TributeProcessOutcome> {
  const p = envelope.payload;
  const orderUuid = String(p.uuid ?? "");
  const order = await prisma.tributeOrder.findUnique({ where: { orderUuid } });
  if (!order) return { status: "unknown_order", orderUuid };
  const user = await prisma.user.findUnique({
    where: { id: order.userId },
    select: { id: true, subscriptionStatus: true, tributeSubscriptionId: true, currentPeriodEnd: true },
  });
  if (!user) return { status: "unknown_order", orderUuid };

  // Stale-order guard: only the user's active order affects access.
  if (user.tributeSubscriptionId !== orderUuid) return { status: "stale_order", orderUuid };
  // Out-of-order guard: a newer charge_success already advanced coverage.
  if (p.memberExpiresAt && user.currentPeriodEnd && new Date(p.memberExpiresAt) < user.currentPeriodEnd) {
    return { status: "stale_order", orderUuid };
  }

  const data: { subscriptionStatus: "DUNNING"; dunningSince?: Date } = { subscriptionStatus: "DUNNING" };
  // DUNNING is a live phase (canSubmitJob keeps access until currentPeriodEnd);
  // stamp dunningSince on the transition only.
  if (user.subscriptionStatus !== "DUNNING") data.dunningSince = new Date();
  await prisma.user.update({ where: { id: order.userId }, data });
  if (order.status !== "DUNNING") {
    await prisma.tributeOrder.update({ where: { orderUuid }, data: { status: "DUNNING" } });
  }
  return { status: "dunning", userId: order.userId };
}

async function applyCancellation(
  envelope: TributeShopWebhookEnvelope
): Promise<TributeProcessOutcome> {
  const p = envelope.payload;
  const orderUuid = String(p.uuid ?? "");
  const order = await prisma.tributeOrder.findUnique({ where: { orderUuid } });
  if (!order) return { status: "unknown_order", orderUuid };
  const user = await prisma.user.findUnique({ where: { id: order.userId } });
  if (!user) return { status: "unknown_order", orderUuid };

  if (order.status !== "CANCELED") {
    await prisma.tributeOrder.update({ where: { orderUuid }, data: { status: "CANCELED" } });
  }
  // Stale-order guard: audit-only for a superseded order.
  if (user.tributeSubscriptionId !== orderUuid) return { status: "stale_order", orderUuid };

  // Fall back to the already-known paid-through date so a cancellation webhook
  // that omits memberExpiresAt never forfeits access the user already paid for.
  const expiresAt = p.memberExpiresAt ? new Date(p.memberExpiresAt) : user.currentPeriodEnd;
  const stillActive = expiresAt ? expiresAt > new Date() : false;
  await prisma.user.update({
    where: { id: order.userId },
    data: {
      subscriptionStatus: stillActive ? "CANCELED_GRACE" : "CANCELED",
      graceEndsAt: stillActive ? expiresAt : null,
    },
  });

  try {
    await notifyPaymentEvent(order.userId, {
      kind: "subscription_canceled",
      graceEndsAt: stillActive ? expiresAt : null,
    });
  } catch (err) {
    console.warn("[tribute] cancel notification failed:", err instanceof Error ? err.message : err);
  }

  return { status: "cancelled", userId: order.userId };
}

async function recordRefund(
  envelope: TributeShopWebhookEnvelope
): Promise<TributeProcessOutcome> {
  const p = envelope.payload;
  const orderUuid = String(p.uuid ?? "");
  const order = await prisma.tributeOrder.findUnique({ where: { orderUuid } });
  // Audit-only: refunds are per-transaction; access + referral are NOT changed.
  console.warn("[tribute] refund received (audit-only, manual review required)", {
    orderUuid,
    transactionId: p.transactionId,
    amount: p.amount,
    currency: p.currency,
    known: Boolean(order),
  });
  if (!order) return { status: "ignored_event", name: envelope.name };
  return { status: "refund_recorded", orderUuid };
}

async function markPaymentFailed(
  envelope: TributeShopWebhookEnvelope
): Promise<TributeProcessOutcome> {
  const p = envelope.payload;
  const orderUuid = String(p.uuid ?? "");
  const order = await prisma.tributeOrder.findUnique({ where: { orderUuid } });
  if (!order) return { status: "ignored_event", name: envelope.name };
  if (order.status === "PENDING") {
    await prisma.tributeOrder.update({ where: { orderUuid }, data: { status: "FAILED" } });
  }
  return { status: "payment_failed", orderUuid };
}

export async function dispatchTributeEvent(
  envelope: TributeShopWebhookEnvelope
): Promise<TributeProcessOutcome> {
  switch (canonicalTributeEventName(envelope.name)) {
    case "shoporder":
    case "shoporderpaymentreceived":
      return applyOrderPayment(envelope, false);
    case "shoporderchargesuccess":
      return applyOrderPayment(envelope, true);
    case "shoporderchargefailed":
      return applyChargeFailed(envelope);
    case "shopordercancelled":
    case "shopordercanceled":
      return applyCancellation(envelope);
    case "shoporderrefunded":
      return recordRefund(envelope);
    case "shoporderpaymentfailed":
      return markPaymentFailed(envelope);
    case "newsubscription":
    case "renewedsubscription":
    case "cancelledsubscription":
      console.info("[tribute] legacy channel event ignored post-cutover", { name: envelope.name });
      return { status: "ignored_event", name: envelope.name };
    default:
      return { status: "ignored_event", name: envelope.name };
  }
}
