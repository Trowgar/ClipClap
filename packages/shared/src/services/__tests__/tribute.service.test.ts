import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventCreate: vi.fn(),
  eventFindUnique: vi.fn(),
  eventUpdateMany: vi.fn(),
  eventUpdate: vi.fn(),
  userFindUnique: vi.fn(),
  userUpsert: vi.fn(),
  userUpdate: vi.fn(),
  notify: vi.fn(),
  recordCommission: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tributeWebhookEvent: {
      create: mocks.eventCreate,
      findUnique: mocks.eventFindUnique,
      updateMany: mocks.eventUpdateMany,
      update: mocks.eventUpdate,
    },
    user: {
      findUnique: mocks.userFindUnique,
      upsert: mocks.userUpsert,
      update: mocks.userUpdate,
    },
  },
}));

vi.mock("../telegram-notification.service", () => ({
  notifyPaymentEvent: mocks.notify,
}));

vi.mock("../referral.service", () => ({
  recordCommission: mocks.recordCommission,
}));

import {
  canonicalTributeEventName,
  extractStartapp,
  hashTributeEvent,
  loadTributeProductIndexFromEnv,
  normalizeProductName,
  resolveProductBinding,
  verifyTributeSignature,
  type TributeProductIndex,
  type TributeWebhookEnvelope,
} from "../tribute.service";

const API_KEY = "tribute-secret";

function signedBody(body: string): string {
  return createHmac("sha256", API_KEY).update(body).digest("hex");
}

// Mirrors the real production payload shape (snake_case names, web_app_link).
function makeEnvelope(
  partial: Partial<TributeWebhookEnvelope> = {}
): TributeWebhookEnvelope {
  return {
    name: "new_subscription",
    created_at: "2026-07-11T12:44:17.787225Z",
    sent_at: "2026-07-11T12:44:17.888898Z",
    payload: {
      type: "regular",
      subscription_name: "Starter Weekly",
      subscription_id: "219056",
      period_id: "396297",
      period: "weekly",
      price: 300,
      amount: 210,
      currency: "eur",
      channel_id: "479363",
      channel_name: "ClipCliap News",
      web_app_link: "https://t.me/tribute/app?startapp=sUZa",
      telegram_user_id: 332548055,
      telegram_username: "Maxkornilo",
      expires_at: "2026-07-18T12:44:17.751630949Z",
    },
    ...partial,
  };
}

describe("tribute.service signature", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"hello":"world"}';
    expect(verifyTributeSignature(body, signedBody(body), API_KEY)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = '{"hello":"world"}';
    const tampered = '{"hello":"tampered"}';
    expect(verifyTributeSignature(tampered, signedBody(body), API_KEY)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyTributeSignature("{}", null, API_KEY)).toBe(false);
  });

  it("accepts uppercase hex signatures (case-insensitive normalize)", () => {
    const body = '{"a":1}';
    expect(verifyTributeSignature(body, signedBody(body).toUpperCase(), API_KEY)).toBe(true);
  });
});

describe("canonicalTributeEventName", () => {
  it("normalizes snake_case, camelCase, and punctuation to one form", () => {
    expect(canonicalTributeEventName("new_subscription")).toBe("newsubscription");
    expect(canonicalTributeEventName("newSubscription")).toBe("newsubscription");
    expect(canonicalTributeEventName("New-Subscription")).toBe("newsubscription");
    expect(canonicalTributeEventName("cancelled_subscription")).toBe("cancelledsubscription");
  });
});

describe("hashTributeEvent", () => {
  it("is identical across retries with a different sent_at", () => {
    const a = makeEnvelope({ sent_at: "2026-07-11T12:44:17.888Z" });
    const b = makeEnvelope({ sent_at: "2026-07-11T12:49:17.100Z" }); // retry, new sent_at
    expect(hashTributeEvent(a)).toBe(hashTributeEvent(b));
  });

  it("is identical for snake_case and camelCase of the same event", () => {
    const a = makeEnvelope({ name: "new_subscription" });
    const b = makeEnvelope({ name: "newSubscription" });
    expect(hashTributeEvent(a)).toBe(hashTributeEvent(b));
  });

  it("differs across distinct periods of the same subscription", () => {
    const a = makeEnvelope();
    const b = makeEnvelope({ payload: { ...makeEnvelope().payload, period_id: "396298" } });
    expect(hashTributeEvent(a)).not.toBe(hashTributeEvent(b));
  });
});

const FULL_ENV = {
  TRIBUTE_PRODUCT_STARTER_WEEKLY_ID: "UZa",
  TRIBUTE_PRODUCT_STARTER_WEEKLY_NAME: "Starter Weekly",
  TRIBUTE_PRODUCT_STARTER_MONTHLY_ID: "UZd",
  TRIBUTE_PRODUCT_STARTER_MONTHLY_NAME: "Starter Monthly",
  TRIBUTE_PRODUCT_PLUS_MONTHLY_ID: "UZh",
  TRIBUTE_PRODUCT_PLUS_MONTHLY_NAME: "Plus Monthly",
  TRIBUTE_PRODUCT_MAX_MONTHLY_ID: "UZi",
  TRIBUTE_PRODUCT_MAX_MONTHLY_NAME: "Max Monthly",
} as unknown as NodeJS.ProcessEnv;

describe("extractStartapp", () => {
  it("returns the startapp param", () => {
    expect(extractStartapp("https://t.me/tribute/app?startapp=sUZa")).toBe("sUZa");
  });
  it("returns undefined for missing/empty/malformed links", () => {
    expect(extractStartapp(undefined)).toBeUndefined();
    expect(extractStartapp("")).toBeUndefined();
    expect(extractStartapp("https://t.me/tribute/app?startapp=")).toBeUndefined();
    expect(extractStartapp("not a url")).toBeUndefined();
  });
});

describe("normalizeProductName", () => {
  it("lowercases and strips punctuation/whitespace, keeping unicode letters", () => {
    expect(normalizeProductName("Starter Weekly")).toBe("starterweekly");
    expect(normalizeProductName("  Plus-Monthly ")).toBe("plusmonthly");
    expect(normalizeProductName("Стартер Недельный")).toBe("стартернедельный");
  });
});

describe("loadTributeProductIndexFromEnv", () => {
  it("indexes each tier by startapp id and normalized name", () => {
    const index = loadTributeProductIndexFromEnv(FULL_ENV);
    expect(index.byStartappId.get("UZa")).toEqual({ plan: "STARTER", billingCycle: "WEEKLY" });
    expect(index.byNormalizedName.get("startermonthly")).toEqual({ plan: "STARTER", billingCycle: "MONTHLY" });
  });

  it("throws when two tiers collide on the same id", () => {
    expect(() =>
      loadTributeProductIndexFromEnv({
        ...FULL_ENV,
        TRIBUTE_PRODUCT_PLUS_MONTHLY_ID: "UZa", // collides with STARTER_WEEKLY
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/duplicate/i);
  });

  it("throws in production when a configured tier is missing its _NAME", () => {
    const env = { ...FULL_ENV, NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
    delete (env as Record<string, unknown>).TRIBUTE_PRODUCT_STARTER_WEEKLY_NAME;
    expect(() => loadTributeProductIndexFromEnv(env)).toThrow(/production/i);
  });
});

describe("resolveProductBinding", () => {
  const index = loadTributeProductIndexFromEnv(FULL_ENV);
  const base = makeEnvelope().payload;

  it("resolves via the s-stripped startapp code", () => {
    expect(resolveProductBinding(base, index)).toEqual({
      binding: { plan: "STARTER", billingCycle: "WEEKLY" },
      resolvedBy: "startapp_stripped",
    });
  });

  it("resolves via an exact (non-prefixed) startapp code", () => {
    const payload = { ...base, web_app_link: "https://t.me/tribute/app?startapp=UZd" };
    expect(resolveProductBinding(payload, index)?.resolvedBy).toBe("startapp_exact");
  });

  it("falls back to subscription_name when web_app_link is absent", () => {
    const payload = { ...base, web_app_link: undefined, subscription_name: "Plus Monthly" };
    expect(resolveProductBinding(payload, index)).toEqual({
      binding: { plan: "PLUS", billingCycle: "MONTHLY" },
      resolvedBy: "subscription_name",
    });
  });

  it("falls back to subscription_name when web_app_link is malformed", () => {
    const payload = { ...base, web_app_link: "not a url", subscription_name: "Max Monthly" };
    expect(resolveProductBinding(payload, index)?.binding).toEqual({ plan: "MAX", billingCycle: "MONTHLY" });
  });

  it("is case-sensitive on the startapp id and returns undefined when nothing matches", () => {
    const payload = { ...base, web_app_link: "https://t.me/tribute/app?startapp=uza", subscription_name: "Unknown" };
    expect(resolveProductBinding(payload, index)).toBeUndefined();
  });
});
