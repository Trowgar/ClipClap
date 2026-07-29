import type { Plan, BillingCycle } from "@prisma/client";
import { getTributeCatalogEntry } from "../config/tribute-catalog";

const DEFAULT_BASE = "https://tribute.tg/api/v1";

export interface CreateShopOrderInput {
  plan: Exclude<Plan, "NONE">;
  billingCycle: BillingCycle;
  telegramId: string;
  checkoutIntentId: string;
}

export interface ShopOrderResult {
  uuid: string;
  webappPaymentUrl: string;
}

function requireConfig(): { apiKey: string; base: string } {
  const apiKey = process.env.TRIBUTE_API_KEY;
  if (!apiKey) throw new Error("TRIBUTE_API_KEY is not configured");
  const base = process.env.TRIBUTE_API_BASE || DEFAULT_BASE;
  return { apiKey, base };
}

export async function createShopOrder(input: CreateShopOrderInput): Promise<ShopOrderResult> {
  const { apiKey, base } = requireConfig();
  const entry = getTributeCatalogEntry(input.plan, input.billingCycle);

  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  const returnUrl = botUsername ? `https://t.me/${botUsername}` : undefined;

  const body = {
    currency: entry.currency,
    amount: entry.amount,
    period: entry.period,
    title: entry.title,
    description: entry.description,
    customerId: input.telegramId,
    comment: `clipclap-checkout:${input.checkoutIntentId}`,
    ...(returnUrl ? { successUrl: returnUrl, failUrl: returnUrl } : {}),
  };

  const res = await fetch(`${base}/shop/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Key": apiKey },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tribute create order failed: ${res.status} ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { uuid?: unknown; webappPaymentUrl?: unknown };
  if (!data?.uuid || !data?.webappPaymentUrl) {
    throw new Error("Tribute order response missing uuid/webappPaymentUrl");
  }
  return { uuid: String(data.uuid), webappPaymentUrl: String(data.webappPaymentUrl) };
}

export async function cancelShopOrder(uuid: string): Promise<void> {
  const { apiKey, base } = requireConfig();
  const res = await fetch(`${base}/shop/orders/${uuid}/cancel`, {
    method: "POST",
    headers: { "Api-Key": apiKey },
  });
  if (!res.ok) throw new Error(`Tribute cancel order failed: ${res.status}`);
}

export interface ShopOrderView {
  status: "pending" | "prepaid" | "paid" | "failed";
  memberExpiresAt?: string;
  amount?: number;
  currency?: string;
  period?: string;
  memberInTrial?: boolean;
  memberTrialEndsAt?: string;
}

export async function getShopOrder(uuid: string): Promise<ShopOrderView> {
  const { apiKey, base } = requireConfig();
  const res = await fetch(`${base}/shop/orders/${uuid}`, {
    headers: { "Api-Key": apiKey },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tribute get order failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as ShopOrderView;
}
