import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.20.0",
  });
}

const mocks = vi.hoisted(() => ({
  eventCreate: vi.fn(),
  eventFindUnique: vi.fn(),
  eventUpdateMany: vi.fn(),
  eventUpdate: vi.fn(),
  orderFindUnique: vi.fn(),
  orderUpdate: vi.fn(),
  userFindUnique: vi.fn(),
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
    tributeOrder: {
      findUnique: mocks.orderFindUnique,
      update: mocks.orderUpdate,
    },
    user: {
      findUnique: mocks.userFindUnique,
      update: mocks.userUpdate,
    },
  },
}));

vi.mock("../telegram-notification.service", () => ({ notifyPaymentEvent: mocks.notify }));
vi.mock("../referral.service", () => ({ recordCommission: mocks.recordCommission }));

import {
  canonicalTributeEventName,
  dispatchTributeEvent,
  hashTributeEvent,
  processTributeEvent,
  verifyTributeSignature,
  type TributeShopWebhookEnvelope,
} from "../tribute.service";

const API_KEY = "shop-secret";

function envelope(
  name: string,
  payload: Partial<TributeShopWebhookEnvelope["payload"]> = {}
): TributeShopWebhookEnvelope {
  return {
    name,
    created_at: "2026-07-14T10:00:00.000Z",
    sent_at: "2026-07-14T10:00:01.000Z",
    payload: { uuid: "ord-1", ...payload },
  };
}

function signed(body: string): string {
  return createHmac("sha256", API_KEY).update(body).digest("hex");
}

const ORDER = {
  orderUuid: "ord-1",
  userId: "user-1",
  telegramId: "42",
  plan: "STARTER",
  billingCycle: "WEEKLY",
  amount: 300,
  currency: "eur",
  status: "PENDING",
};

beforeEach(() => {
  vi.clearAllMocks();
  // default inbox path: create succeeds, claim succeeds
  mocks.eventCreate.mockResolvedValue({});
  mocks.eventUpdateMany.mockResolvedValue({ count: 1 });
  mocks.eventUpdate.mockResolvedValue({});
});

describe("verifyTributeSignature", () => {
  it("accepts a valid signature", () => {
    const body = JSON.stringify(envelope("shopOrder"));
    expect(verifyTributeSignature(body, signed(body), API_KEY)).toBe(true);
  });
  it("rejects a tampered body", () => {
    const body = JSON.stringify(envelope("shopOrder"));
    expect(verifyTributeSignature(body + " ", signed(body), API_KEY)).toBe(false);
  });
});

describe("canonicalTributeEventName", () => {
  it("normalizes snake_case and camelCase to the same token", () => {
    expect(canonicalTributeEventName("shop_order_charge_success")).toBe("shoporderchargesuccess");
    expect(canonicalTributeEventName("shopOrderChargeSuccess")).toBe("shoporderchargesuccess");
  });
});

describe("hashTributeEvent", () => {
  it("member events key on uuid + memberExpiresAt (dedups retries, distinguishes periods)", () => {
    const a = hashTributeEvent(envelope("shopOrderChargeSuccess", { memberExpiresAt: "2026-07-25T00:00:00Z" }));
    const aRetry = hashTributeEvent({ ...envelope("shopOrderChargeSuccess", { memberExpiresAt: "2026-07-25T00:00:00Z" }), sent_at: "later" });
    const b = hashTributeEvent(envelope("shopOrderChargeSuccess", { memberExpiresAt: "2026-08-01T00:00:00Z" }));
    expect(a).toBe(aRetry);
    expect(a).not.toBe(b);
  });
});

describe("dispatchTributeEvent - activation", () => {
  it("maps by uuid, sets ACTIVE with currentPeriodEnd = memberExpiresAt", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER });
    mocks.userFindUnique.mockResolvedValue({ id: "user-1", currentPeriodEnd: null });
    mocks.userUpdate.mockResolvedValue({ id: "user-1" });

    const out = await dispatchTributeEvent(
      envelope("shopOrder", { memberExpiresAt: "2026-07-21T00:00:00.000Z" })
    );

    expect(out).toEqual({ status: "activated", userId: "user-1", plan: "STARTER" });
    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({
          plan: "STARTER",
          subscriptionStatus: "ACTIVE",
          tributeSubscriptionId: "ord-1",
          currentPeriodEnd: new Date("2026-07-21T00:00:00.000Z"),
        }),
      })
    );
    expect(mocks.recordCommission).toHaveBeenCalled();
  });

  it("returns unknown_order when no TributeOrder exists", async () => {
    mocks.orderFindUnique.mockResolvedValue(null);
    const out = await dispatchTributeEvent(envelope("shopOrder", { memberExpiresAt: "2026-07-21T00:00:00Z" }));
    expect(out).toEqual({ status: "unknown_order", orderUuid: "ord-1" });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("does not regress currentPeriodEnd on an out-of-order older event", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER });
    mocks.userFindUnique.mockResolvedValue({ id: "user-1", currentPeriodEnd: new Date("2026-08-01T00:00:00Z") });
    const out = await dispatchTributeEvent(envelope("shopOrderChargeSuccess", { memberExpiresAt: "2026-07-25T00:00:00Z" }));
    expect(out).toEqual({ status: "stale_order", orderUuid: "ord-1" });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});

describe("dispatchTributeEvent - charge failed", () => {
  it("sets DUNNING on the active order and stamps dunningSince on transition", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER, status: "PAID" });
    mocks.userFindUnique.mockResolvedValue({
      id: "user-1", subscriptionStatus: "ACTIVE", tributeSubscriptionId: "ord-1", currentPeriodEnd: new Date("2026-07-25T00:00:00Z"),
    });
    const out = await dispatchTributeEvent(envelope("shopOrderChargeFailed", {}));
    expect(out).toEqual({ status: "dunning", userId: "user-1" });
    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ subscriptionStatus: "DUNNING" }) })
    );
    const data = mocks.userUpdate.mock.calls[0][0].data;
    expect(data.dunningSince).toBeInstanceOf(Date);
  });

  it("is audit-only (stale_order) when the order is not the user's active one", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER, status: "PAID" });
    mocks.userFindUnique.mockResolvedValue({
      id: "user-1", subscriptionStatus: "ACTIVE", tributeSubscriptionId: "ord-DIFFERENT", currentPeriodEnd: new Date("2026-07-25T00:00:00Z"),
    });
    const out = await dispatchTributeEvent(envelope("shopOrderChargeFailed", {}));
    expect(out).toEqual({ status: "stale_order", orderUuid: "ord-1" });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});

describe("dispatchTributeEvent - cancellation", () => {
  it("sets CANCELED_GRACE while the paid period is still live", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER, status: "PAID" });
    mocks.userFindUnique.mockResolvedValue({ id: "user-1", tributeSubscriptionId: "ord-1" });
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const out = await dispatchTributeEvent(envelope("shopOrderCancelled", { memberExpiresAt: future }));
    expect(out).toEqual({ status: "cancelled", userId: "user-1" });
    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ subscriptionStatus: "CANCELED_GRACE" }) })
    );
  });
});

describe("dispatchTributeEvent - refund (audit-only)", () => {
  it("records but never changes User access or referral", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER, status: "PAID" });
    const out = await dispatchTributeEvent(envelope("shopOrderRefunded", { transactionId: 555, amount: 300 }));
    expect(out).toEqual({ status: "refund_recorded", orderUuid: "ord-1" });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.orderUpdate).not.toHaveBeenCalled();
    expect(mocks.recordCommission).not.toHaveBeenCalled();
  });
});

describe("dispatchTributeEvent - payment failed", () => {
  it("marks a PENDING order FAILED and leaves User untouched", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER, status: "PENDING" });
    const out = await dispatchTributeEvent(envelope("shopOrderPaymentFailed", {}));
    expect(out).toEqual({ status: "payment_failed", orderUuid: "ord-1" });
    expect(mocks.orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "FAILED" } })
    );
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});

describe("dispatchTributeEvent - legacy channel events", () => {
  it("ignores post-cutover legacy events", async () => {
    const out = await dispatchTributeEvent(envelope("new_subscription", {}));
    expect(out).toEqual({ status: "ignored_event", name: "new_subscription" });
  });
});

describe("processTributeEvent - idempotency", () => {
  it("treats an already-APPLIED event as a duplicate no-op", async () => {
    mocks.eventCreate.mockRejectedValue(p2002());
    mocks.eventFindUnique.mockResolvedValue({ status: "APPLIED" });
    const out = await processTributeEvent(envelope("shopOrder", { memberExpiresAt: "2026-07-21T00:00:00Z" }));
    expect(out).toEqual({ status: "duplicate" });
    expect(mocks.eventUpdateMany).not.toHaveBeenCalled();
  });
});
