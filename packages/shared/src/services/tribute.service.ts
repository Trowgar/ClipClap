import { createHash, createHmac, timingSafeEqual } from "crypto";
import { prisma } from "../lib/prisma";
import { notifyPaymentEvent } from "./telegram-notification.service";
import type { Plan, BillingCycle, TributeWebhookStatus } from "@prisma/client";

export const TRIBUTE_SIGNATURE_HEADER = "trbt-signature";

export function canonicalTributeEventName(name: string): string {
  // "new_subscription" | "newSubscription" | "New-Subscription" -> "newsubscription"
  return name.toLowerCase().replace(/[_\s-]/g, "");
}

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

export interface TributeProductIndex {
  byStartappId: Map<string, TributePlanBinding>;
  byNormalizedName: Map<string, TributePlanBinding>;
}

export type ProductResolvedBy = "startapp_exact" | "startapp_stripped" | "subscription_name";

export function extractStartapp(webAppLink?: string | null): string | undefined {
  if (!webAppLink?.trim()) return undefined;
  try {
    return new URL(webAppLink).searchParams.get("startapp")?.trim() || undefined;
  } catch {
    return undefined; // malformed URL -> caller falls back to subscription_name
  }
}

export function normalizeProductName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const TRIBUTE_TIERS: Array<{ idKey: string; nameKey: string; plan: Plan; billingCycle: BillingCycle }> = [
  { idKey: "TRIBUTE_PRODUCT_STARTER_WEEKLY_ID", nameKey: "TRIBUTE_PRODUCT_STARTER_WEEKLY_NAME", plan: "STARTER", billingCycle: "WEEKLY" },
  { idKey: "TRIBUTE_PRODUCT_STARTER_MONTHLY_ID", nameKey: "TRIBUTE_PRODUCT_STARTER_MONTHLY_NAME", plan: "STARTER", billingCycle: "MONTHLY" },
  { idKey: "TRIBUTE_PRODUCT_PLUS_MONTHLY_ID", nameKey: "TRIBUTE_PRODUCT_PLUS_MONTHLY_NAME", plan: "PLUS", billingCycle: "MONTHLY" },
  { idKey: "TRIBUTE_PRODUCT_MAX_MONTHLY_ID", nameKey: "TRIBUTE_PRODUCT_MAX_MONTHLY_NAME", plan: "MAX", billingCycle: "MONTHLY" },
];

export function loadTributeProductIndexFromEnv(env: NodeJS.ProcessEnv): TributeProductIndex {
  const byStartappId = new Map<string, TributePlanBinding>();
  const byNormalizedName = new Map<string, TributePlanBinding>();
  const isProd = env.NODE_ENV === "production";

  const add = (map: Map<string, TributePlanBinding>, key: string, binding: TributePlanBinding, label: string) => {
    const existing = map.get(key);
    if (existing && (existing.plan !== binding.plan || existing.billingCycle !== binding.billingCycle)) {
      throw new Error(`Duplicate Tribute product mapping key "${key}" (${label})`);
    }
    map.set(key, binding);
  };

  for (const tier of TRIBUTE_TIERS) {
    const id = env[tier.idKey]?.trim();
    const name = env[tier.nameKey]?.trim();
    if (!id) continue; // tier not configured
    const binding: TributePlanBinding = { plan: tier.plan, billingCycle: tier.billingCycle };
    add(byStartappId, id, binding, `${tier.plan}/${tier.billingCycle}`);
    if (name) {
      add(byNormalizedName, normalizeProductName(name), binding, `${tier.plan}/${tier.billingCycle}`);
    } else if (isProd) {
      throw new Error(`Tribute product ${tier.plan}/${tier.billingCycle} is missing ${tier.nameKey} (required in production)`);
    }
  }

  return { byStartappId, byNormalizedName };
}

export function resolveProductBinding(
  payload: TributeSubscriptionPayload,
  index: TributeProductIndex
): { binding: TributePlanBinding; resolvedBy: ProductResolvedBy } | undefined {
  const startapp = extractStartapp(payload.web_app_link);
  if (startapp) {
    const exact = index.byStartappId.get(startapp);
    if (exact) return { binding: exact, resolvedBy: "startapp_exact" };
    if (startapp.startsWith("s")) {
      const stripped = index.byStartappId.get(startapp.slice(1));
      if (stripped) return { binding: stripped, resolvedBy: "startapp_stripped" };
    }
  }
  if (payload.subscription_name) {
    const byName = index.byNormalizedName.get(normalizeProductName(payload.subscription_name));
    if (byName) return { binding: byName, resolvedBy: "subscription_name" };
  }
  return undefined;
}

export type TributeProcessOutcome =
  | { status: "duplicate" }
  | { status: "unmapped_subscription"; subscriptionId: string }
  | { status: "ignored_event"; name: string }
  | { status: "applied"; userId: string; plan: Plan; eventName: string }
  | { status: "cancelled"; userId: string; eventName: string }
  | { status: "stale_event"; userId: string }
  | { status: "stale_cancellation"; userId: string };

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
  const p = envelope.payload;
  // Stable across Tribute retries: excludes sent_at (which changes per retry),
  // keyed on the canonical event + subscriber + period + event creation time.
  const key = [
    canonicalTributeEventName(envelope.name),
    p.telegram_user_id ?? "",
    p.subscription_id ?? "",
    p.period_id ?? "",
    envelope.created_at ?? "",
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}

function terminalStatusFor(outcome: TributeProcessOutcome): TributeWebhookStatus {
  switch (outcome.status) {
    case "applied":
    case "cancelled":
    case "stale_event":
    case "stale_cancellation":
      return "APPLIED";
    case "ignored_event":
      return "IGNORED";
    case "unmapped_subscription":
    case "duplicate": // not reachable here; kept for exhaustiveness
      return "FAILED";
  }
}

export async function processTributeEvent(
  envelope: TributeWebhookEnvelope,
  index: TributeProductIndex
): Promise<TributeProcessOutcome> {
  const eventHash = hashTributeEvent(envelope);

  // 1. Ensure an inbox row exists (status RECEIVED). Insert; on unique conflict, inspect.
  let inserted = true;
  try {
    await prisma.tributeWebhookEvent.create({
      data: { eventHash, name: envelope.name, payload: envelope as unknown as object, status: "RECEIVED" },
    });
  } catch {
    inserted = false;
  }

  if (!inserted) {
    const existing = await prisma.tributeWebhookEvent.findUnique({ where: { eventHash } });
    // Terminal or in-flight -> idempotent no-op. Only RECEIVED/FAILED are (re)claimable.
    if (!existing || existing.status === "APPLIED" || existing.status === "IGNORED" || existing.status === "PROCESSING") {
      return { status: "duplicate" };
    }
  }

  // 2. Atomically claim: RECEIVED/FAILED -> PROCESSING (and bump attempts).
  const claim = await prisma.tributeWebhookEvent.updateMany({
    where: { eventHash, status: { in: ["RECEIVED", "FAILED"] } },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });
  if (claim.count !== 1) {
    return { status: "duplicate" }; // another delivery claimed it first
  }

  // 3. Dispatch to business handlers.
  let outcome: TributeProcessOutcome;
  try {
    outcome = await dispatchTributeEvent(envelope, index);
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

async function applySubscription(
  envelope: TributeWebhookEnvelope,
  index: TributeProductIndex
): Promise<TributeProcessOutcome> {
  const payload = envelope.payload;
  const resolved = resolveProductBinding(payload, index);
  if (!resolved) {
    console.error("[tribute] product mapping failed", {
      eventName: envelope.name,
      telegramUserId: payload.telegram_user_id,
      subscriptionId: payload.subscription_id,
      periodId: payload.period_id,
      channelId: payload.channel_id,
      subscriptionName: payload.subscription_name,
      startapp: extractStartapp(payload.web_app_link),
    });
    return { status: "unmapped_subscription", subscriptionId: String(payload.subscription_id) };
  }
  const { binding, resolvedBy } = resolved;
  if (resolvedBy === "subscription_name") {
    console.info("[tribute] product resolved via subscription_name (startapp mapping missed)", {
      subscriptionName: payload.subscription_name,
    });
  }

  const telegramId = String(payload.telegram_user_id);
  const expiresAt = new Date(payload.expires_at);
  const tributeSubscriptionId = String(payload.subscription_id);

  const existing = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, currentPeriodEnd: true },
  });
  if (existing?.currentPeriodEnd && expiresAt < existing.currentPeriodEnd) {
    return { status: "stale_event", userId: existing.id };
  }

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

  // Referral accrual is non-critical: never let it fail the activation.
  try {
    const amount = payload.amount ?? payload.price ?? 0;
    if (amount > 0) {
      const currency = (payload.currency ?? "usd").toLowerCase();
      const externalPaymentId = payload.period_id ?? `${tributeSubscriptionId}:${payload.expires_at}`;
      const { recordCommission } = await import("./referral.service");
      const { exchangeRateToUsd, REFERRAL_CONFIG } = await import("../config/referral");
      const rate = exchangeRateToUsd(currency);
      const grossAmountUsd = (amount / 100) * rate;
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
  } catch (err) {
    console.error("[referral] accrual failed:", err);
  }

  // Notification is best-effort: a Telegram failure must NOT roll back paid access.
  try {
    await notifyPaymentEvent(user.id, {
      kind: envelope.name && canonicalTributeEventName(envelope.name) === "newsubscription"
        ? "subscription_activated"
        : "subscription_renewed",
      plan: binding.plan,
      periodEnd: expiresAt,
    });
  } catch (err) {
    console.warn("[tribute] notification failed (activation stands):", err instanceof Error ? err.message : err);
  }

  return { status: "applied", userId: user.id, plan: binding.plan, eventName: envelope.name };
}

async function applyCancellation(
  envelope: TributeWebhookEnvelope
): Promise<TributeProcessOutcome> {
  const payload = envelope.payload;
  const telegramId = String(payload.telegram_user_id);
  const expiresAt = new Date(payload.expires_at);

  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) {
    return { status: "ignored_event", name: envelope.name };
  }
  // A late cancellation for a superseded subscription must not cancel a newer one.
  if (
    user.tributeSubscriptionId &&
    String(user.tributeSubscriptionId) !== String(payload.subscription_id)
  ) {
    return { status: "stale_cancellation", userId: user.id };
  }

  const stillActive = expiresAt > new Date();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      subscriptionStatus: stillActive ? "CANCELED_GRACE" : "CANCELED",
      graceEndsAt: stillActive ? expiresAt : null,
    },
  });

  try {
    await notifyPaymentEvent(user.id, {
      kind: "subscription_canceled",
      graceEndsAt: stillActive ? expiresAt : null,
    });
  } catch (err) {
    console.warn("[tribute] cancel notification failed:", err instanceof Error ? err.message : err);
  }

  return { status: "cancelled", userId: user.id, eventName: envelope.name };
}

export async function dispatchTributeEvent(
  envelope: TributeWebhookEnvelope,
  index: TributeProductIndex
): Promise<TributeProcessOutcome> {
  switch (canonicalTributeEventName(envelope.name)) {
    case "newsubscription":
    case "renewedsubscription":
      return applySubscription(envelope, index);
    case "cancelledsubscription":
    case "canceledsubscription":
      return applyCancellation(envelope);
    default:
      return { status: "ignored_event", name: envelope.name };
  }
}
