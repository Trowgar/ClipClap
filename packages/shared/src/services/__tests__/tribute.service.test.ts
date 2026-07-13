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
  hashTributeEvent,
  verifyTributeSignature,
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
