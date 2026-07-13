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
  dispatchTributeEvent,
  extractStartapp,
  hashTributeEvent,
  loadTributeProductIndexFromEnv,
  normalizeProductName,
  processTributeEvent,
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

describe("dispatchTributeEvent", () => {
  const index = loadTributeProductIndexFromEnv(FULL_ENV);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notify.mockResolvedValue(undefined);
    mocks.recordCommission.mockResolvedValue(undefined);
  });

  it("activates the plan on new_subscription and asserts full-ms period end", async () => {
    mocks.userFindUnique.mockResolvedValueOnce(null);
    mocks.userUpsert.mockResolvedValueOnce({ id: "user_1" });
    const outcome = await dispatchTributeEvent(makeEnvelope(), index);
    expect(outcome).toEqual({ status: "applied", userId: "user_1", plan: "STARTER", eventName: "new_subscription" });
    expect(mocks.userUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { telegramId: "332548055" },
        update: expect.objectContaining({
          plan: "STARTER",
          billingCycle: "WEEKLY",
          currentPeriodEnd: new Date("2026-07-18T12:44:17.751Z"),
          subscriptionStatus: "ACTIVE",
          tributeSubscriptionId: "219056",
        }),
      })
    );
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("activates via subscription_name when web_app_link is missing", async () => {
    mocks.userFindUnique.mockResolvedValueOnce(null);
    mocks.userUpsert.mockResolvedValueOnce({ id: "user_1" });
    const env = makeEnvelope();
    const outcome = await dispatchTributeEvent(
      { ...env, payload: { ...env.payload, web_app_link: undefined } },
      index
    );
    expect(outcome).toMatchObject({ status: "applied", plan: "STARTER" });
  });

  it("returns unmapped_subscription and does not upsert when nothing matches", async () => {
    const env = makeEnvelope();
    const outcome = await dispatchTributeEvent(
      { ...env, payload: { ...env.payload, web_app_link: "https://t.me/tribute/app?startapp=zzz", subscription_name: "Nope" } },
      index
    );
    expect(outcome).toEqual({ status: "unmapped_subscription", subscriptionId: "219056" });
    expect(mocks.userUpsert).not.toHaveBeenCalled();
  });

  it("does not shrink currentPeriodEnd (stale renewal)", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ id: "user_1", currentPeriodEnd: new Date("2026-08-01T00:00:00Z") });
    const outcome = await dispatchTributeEvent(makeEnvelope({ name: "renewed_subscription" }), index);
    expect(outcome).toEqual({ status: "stale_event", userId: "user_1" });
    expect(mocks.userUpsert).not.toHaveBeenCalled();
  });

  it("does not roll back activation when the notification throws", async () => {
    mocks.userFindUnique.mockResolvedValueOnce(null);
    mocks.userUpsert.mockResolvedValueOnce({ id: "user_1" });
    mocks.notify.mockRejectedValueOnce(new Error("telegram down"));
    const outcome = await dispatchTributeEvent(makeEnvelope(), index);
    expect(outcome).toMatchObject({ status: "applied" });
  });

  it("cancels with grace when expires_at is in the future and the subscription matches", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ id: "user_1", tributeSubscriptionId: "219056" });
    mocks.userUpdate.mockResolvedValueOnce({});
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const env = makeEnvelope({ name: "cancelled_subscription" });
    const outcome = await dispatchTributeEvent(
      { ...env, payload: { ...env.payload, expires_at: future } },
      index
    );
    expect(outcome).toEqual({ status: "cancelled", userId: "user_1", eventName: "cancelled_subscription" });
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: expect.objectContaining({ subscriptionStatus: "CANCELED_GRACE" }),
    });
  });

  it("ignores a cancellation for a different subscription (stale)", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ id: "user_1", tributeSubscriptionId: "999999" });
    const outcome = await dispatchTributeEvent(makeEnvelope({ name: "cancelled_subscription" }), index);
    expect(outcome).toEqual({ status: "stale_cancellation", userId: "user_1" });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("ignores unrecognized event names", async () => {
    const outcome = await dispatchTributeEvent(makeEnvelope({ name: "physical_order_shipped" }), index);
    expect(outcome).toEqual({ status: "ignored_event", name: "physical_order_shipped" });
  });
});

describe("processTributeEvent (inbox state-machine)", () => {
  const index = loadTributeProductIndexFromEnv(FULL_ENV);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notify.mockResolvedValue(undefined);
    mocks.recordCommission.mockResolvedValue(undefined);
    mocks.eventCreate.mockResolvedValue({}); // fresh RECEIVED row inserted
    mocks.eventUpdateMany.mockResolvedValue({ count: 1 }); // claim succeeds
    mocks.eventUpdate.mockResolvedValue({});
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.userUpsert.mockResolvedValue({ id: "user_1" });
  });

  it("claims a fresh event, applies it, and marks the row APPLIED", async () => {
    const outcome = await processTributeEvent(makeEnvelope(), index);
    expect(outcome).toMatchObject({ status: "applied", plan: "STARTER" });
    expect(mocks.eventUpdateMany).toHaveBeenCalledWith({
      where: { eventHash: expect.any(String), status: { in: ["RECEIVED", "FAILED"] } },
      data: { status: "PROCESSING", attempts: { increment: 1 } },
    });
    expect(mocks.eventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) })
    );
  });

  it("returns duplicate for an already-APPLIED event and does not re-apply", async () => {
    mocks.eventCreate.mockRejectedValueOnce(new Error("P2002 unique"));
    mocks.eventFindUnique.mockResolvedValueOnce({ status: "APPLIED" });
    const outcome = await processTributeEvent(makeEnvelope(), index);
    expect(outcome).toEqual({ status: "duplicate" });
    expect(mocks.userUpsert).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("returns duplicate when another worker holds the claim (updateMany count 0)", async () => {
    mocks.eventCreate.mockRejectedValueOnce(new Error("P2002 unique"));
    mocks.eventFindUnique.mockResolvedValueOnce({ status: "RECEIVED" });
    mocks.eventUpdateMany.mockResolvedValueOnce({ count: 0 });
    const outcome = await processTributeEvent(makeEnvelope(), index);
    expect(outcome).toEqual({ status: "duplicate" });
    expect(mocks.userUpsert).not.toHaveBeenCalled();
  });

  it("re-processes a previously FAILED event once config is fixed", async () => {
    mocks.eventCreate.mockRejectedValueOnce(new Error("P2002 unique"));
    mocks.eventFindUnique.mockResolvedValueOnce({ status: "FAILED" });
    const outcome = await processTributeEvent(makeEnvelope(), index);
    expect(outcome).toMatchObject({ status: "applied" });
  });

  it("marks the row FAILED on an unmapped event", async () => {
    const env = makeEnvelope();
    const outcome = await processTributeEvent(
      { ...env, payload: { ...env.payload, web_app_link: "https://t.me/tribute/app?startapp=zzz", subscription_name: "Nope" } },
      index
    );
    expect(outcome).toMatchObject({ status: "unmapped_subscription" });
    expect(mocks.eventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );
  });

  it("marks the row IGNORED on an unrecognized event", async () => {
    const outcome = await processTributeEvent(makeEnvelope({ name: "physical_order_shipped" }), index);
    expect(outcome).toMatchObject({ status: "ignored_event" });
    expect(mocks.eventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "IGNORED" }) })
    );
  });
});
