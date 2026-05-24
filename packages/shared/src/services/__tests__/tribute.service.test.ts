import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventFindUnique: vi.fn(),
  eventCreate: vi.fn(),
  userFindUnique: vi.fn(),
  userUpsert: vi.fn(),
  userUpdate: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tributeWebhookEvent: {
      findUnique: mocks.eventFindUnique,
      create: mocks.eventCreate,
    },
    user: {
      findUnique: mocks.userFindUnique,
      upsert: mocks.userUpsert,
      update: mocks.userUpdate,
    },
  },
}));

import {
  hashTributeEvent,
  loadTributeProductMapFromEnv,
  processTributeEvent,
  verifyTributeSignature,
  type TributeProductMap,
  type TributeWebhookEnvelope,
} from "../tribute.service";

const API_KEY = "tribute-secret";

function signedBody(body: string): string {
  return createHmac("sha256", API_KEY).update(body).digest("hex");
}

function makeEnvelope(
  partial: Partial<TributeWebhookEnvelope> = {}
): TributeWebhookEnvelope {
  return {
    name: "newSubscription",
    created_at: "2026-05-11T10:00:00Z",
    sent_at: "2026-05-11T10:00:01Z",
    payload: {
      subscription_id: "sub_starter",
      period_id: "p_monthly",
      period: "monthly",
      price: 900,
      amount: 810,
      currency: "USD",
      telegram_user_id: 575308044,
      telegram_username: "trowgar",
      expires_at: "2026-06-10T10:00:00Z",
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

  it("rejects a malformed signature", () => {
    expect(verifyTributeSignature("{}", "not-a-hex", API_KEY)).toBe(false);
  });

  it("accepts uppercase hex signatures (case-insensitive normalize)", () => {
    const body = '{"a":1}';
    const sig = signedBody(body).toUpperCase();
    expect(verifyTributeSignature(body, sig, API_KEY)).toBe(true);
  });
});

describe("hashTributeEvent", () => {
  it("produces the same hash for identical envelopes", () => {
    const e1 = makeEnvelope();
    const e2 = makeEnvelope();
    expect(hashTributeEvent(e1)).toBe(hashTributeEvent(e2));
  });

  it("differs when sent_at changes (retry attempts are NOT deduped)", () => {
    const a = makeEnvelope({ sent_at: "2026-05-11T10:00:01Z" });
    const b = makeEnvelope({ sent_at: "2026-05-11T10:05:01Z" });
    expect(hashTributeEvent(a)).not.toBe(hashTributeEvent(b));
  });

  it("differs when event name changes", () => {
    const a = makeEnvelope({ name: "newSubscription" });
    const b = makeEnvelope({ name: "renewedSubscription" });
    expect(hashTributeEvent(a)).not.toBe(hashTributeEvent(b));
  });
});

describe("processTributeEvent", () => {
  const productMap: TributeProductMap = {
    sub_starter: { plan: "STARTER", billingCycle: "MONTHLY" },
    sub_plus: { plan: "PLUS", billingCycle: "MONTHLY" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventFindUnique.mockResolvedValue(null);
    mocks.eventCreate.mockResolvedValue({});
  });

  it("returns duplicate when event hash is already stored", async () => {
    mocks.eventFindUnique.mockResolvedValueOnce({ id: "1" });
    const outcome = await processTributeEvent(makeEnvelope(), productMap);
    expect(outcome).toEqual({ status: "duplicate" });
    expect(mocks.userUpsert).not.toHaveBeenCalled();
  });

  it("returns duplicate when unique constraint races with another worker", async () => {
    mocks.eventFindUnique.mockResolvedValueOnce(null);
    mocks.eventCreate.mockRejectedValueOnce(new Error("P2002 unique"));
    const outcome = await processTributeEvent(makeEnvelope(), productMap);
    expect(outcome).toEqual({ status: "duplicate" });
  });

  it("upserts user and activates plan on newSubscription", async () => {
    mocks.userUpsert.mockResolvedValueOnce({ id: "user_1" });
    const outcome = await processTributeEvent(makeEnvelope(), productMap);
    expect(outcome).toEqual({
      status: "applied",
      userId: "user_1",
      plan: "STARTER",
      eventName: "newSubscription",
    });
    expect(mocks.userUpsert).toHaveBeenCalledWith({
      where: { telegramId: "575308044" },
      update: expect.objectContaining({
        plan: "STARTER",
        billingCycle: "MONTHLY",
        currentPeriodEnd: new Date("2026-06-10T10:00:00Z"),
        subscriptionStatus: "ACTIVE",
        tributeSubscriptionId: "sub_starter",
      }),
      create: expect.objectContaining({
        telegramId: "575308044",
        plan: "STARTER",
        billingCycle: "MONTHLY",
      }),
    });
  });

  it("extends currentPeriodEnd on renewedSubscription", async () => {
    mocks.userUpsert.mockResolvedValueOnce({ id: "user_1" });
    const outcome = await processTributeEvent(
      makeEnvelope({ name: "renewedSubscription" }),
      productMap
    );
    expect(outcome.status).toBe("applied");
  });

  it("returns unmapped_subscription when neither id is mapped", async () => {
    const outcome = await processTributeEvent(
      makeEnvelope({
        payload: {
          ...makeEnvelope().payload,
          subscription_id: "sub_unknown",
          period_id: "p_unknown",
        },
      }),
      productMap
    );
    expect(outcome).toEqual({
      status: "unmapped_subscription",
      subscriptionId: "p_unknown",
    });
    expect(mocks.userUpsert).not.toHaveBeenCalled();
  });

  it("matches via period_id when subscription_id is unknown", async () => {
    mocks.userUpsert.mockResolvedValueOnce({ id: "user_1" });
    const map: TributeProductMap = {
      UZd: { plan: "STARTER", billingCycle: "MONTHLY" },
    };
    const outcome = await processTributeEvent(
      makeEnvelope({
        payload: {
          ...makeEnvelope().payload,
          subscription_id: "sub_internal_42",
          period_id: "UZd",
        },
      }),
      map
    );
    expect(outcome).toMatchObject({ status: "applied", plan: "STARTER" });
  });

  it("matches via subscription_id when period_id is unknown", async () => {
    mocks.userUpsert.mockResolvedValueOnce({ id: "user_1" });
    const map: TributeProductMap = {
      sub_starter: { plan: "STARTER", billingCycle: "MONTHLY" },
    };
    const outcome = await processTributeEvent(
      makeEnvelope({
        payload: {
          ...makeEnvelope().payload,
          subscription_id: "sub_starter",
          period_id: "different_id",
        },
      }),
      map
    );
    expect(outcome).toMatchObject({ status: "applied", plan: "STARTER" });
  });

  it("marks subscription cancelled-with-grace when expires_at in future", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ id: "user_1" });
    mocks.userUpdate.mockResolvedValueOnce({});
    const outcome = await processTributeEvent(
      makeEnvelope({
        name: "cancelledSubscription",
        payload: {
          ...makeEnvelope().payload,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          cancel_reason: "user_request",
        },
      }),
      productMap
    );
    expect(outcome).toEqual({
      status: "cancelled",
      userId: "user_1",
      eventName: "cancelledSubscription",
    });
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: expect.objectContaining({
        subscriptionStatus: "CANCELED_GRACE",
        graceEndsAt: expect.any(Date),
      }),
    });
  });

  it("marks subscription fully cancelled when expires_at already in past", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ id: "user_1" });
    const outcome = await processTributeEvent(
      makeEnvelope({
        name: "cancelledSubscription",
        payload: {
          ...makeEnvelope().payload,
          expires_at: new Date(Date.now() - 86_400_000).toISOString(),
        },
      }),
      productMap
    );
    expect(outcome).toEqual({
      status: "cancelled",
      userId: "user_1",
      eventName: "cancelledSubscription",
    });
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: expect.objectContaining({
        subscriptionStatus: "CANCELED",
        graceEndsAt: null,
      }),
    });
  });

  it("ignores cancellation for unknown telegram user", async () => {
    mocks.userFindUnique.mockResolvedValueOnce(null);
    const outcome = await processTributeEvent(
      makeEnvelope({ name: "cancelledSubscription" }),
      productMap
    );
    expect(outcome).toEqual({
      status: "ignored_event",
      name: "cancelledSubscription",
    });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("ignores unrecognized event names", async () => {
    const outcome = await processTributeEvent(
      makeEnvelope({ name: "physicalOrderShipped" }),
      productMap
    );
    expect(outcome).toEqual({
      status: "ignored_event",
      name: "physicalOrderShipped",
    });
  });
});

describe("loadTributeProductMapFromEnv", () => {
  it("builds a map covering weekly + monthly tiers", () => {
    const map = loadTributeProductMapFromEnv({
      TRIBUTE_PRODUCT_STARTER_WEEKLY_ID: "sub_w",
      TRIBUTE_PRODUCT_STARTER_MONTHLY_ID: "sub_a",
      TRIBUTE_PRODUCT_PLUS_MONTHLY_ID: "sub_b",
      TRIBUTE_PRODUCT_MAX_MONTHLY_ID: "sub_c",
    } as unknown as NodeJS.ProcessEnv);
    expect(map).toEqual({
      sub_w: { plan: "STARTER", billingCycle: "WEEKLY" },
      sub_a: { plan: "STARTER", billingCycle: "MONTHLY" },
      sub_b: { plan: "PLUS", billingCycle: "MONTHLY" },
      sub_c: { plan: "MAX", billingCycle: "MONTHLY" },
    });
  });

  it("omits tiers without configured ids", () => {
    const map = loadTributeProductMapFromEnv({
      TRIBUTE_PRODUCT_STARTER_MONTHLY_ID: "sub_a",
    } as unknown as NodeJS.ProcessEnv);
    expect(map).toEqual({
      sub_a: { plan: "STARTER", billingCycle: "MONTHLY" },
    });
  });
});
