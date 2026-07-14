import { describe, it, expect, beforeEach, vi } from "vitest";

const mockStripe = {
  subscriptions: { retrieve: vi.fn() },
};

vi.mock("../billing.service", () => ({
  getStripe: () => mockStripe,
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: { findMany: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "../../lib/prisma";
import {
  mapStripeStatus,
  reconcileSubscriptions,
} from "../subscription-reconcile.service";

describe("mapStripeStatus", () => {
  it("maps active/trialing to ACTIVE", () => {
    expect(mapStripeStatus("active")).toBe("ACTIVE");
    expect(mapStripeStatus("trialing")).toBe("ACTIVE");
  });
  it("maps past_due/unpaid to DUNNING", () => {
    expect(mapStripeStatus("past_due")).toBe("DUNNING");
    expect(mapStripeStatus("unpaid")).toBe("DUNNING");
  });
  it("maps canceled/incomplete_expired to CANCELED", () => {
    expect(mapStripeStatus("canceled")).toBe("CANCELED");
    expect(mapStripeStatus("incomplete_expired")).toBe("CANCELED");
  });
  it("returns null for unknown/transient statuses", () => {
    expect(mapStripeStatus("incomplete")).toBeNull();
    expect(mapStripeStatus("paused")).toBeNull();
  });
});

describe("reconcileSubscriptions", () => {
  beforeEach(() => vi.clearAllMocks());
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = new Date("2026-05-30T12:00:00Z");

  it("advances a Stripe user whose webhook was missed (still active)", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u1",
        stripeSubscriptionId: "sub_1",
        tributeSubscriptionId: null,
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
      },
    ]);
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      status: "active",
      current_period_start: 1780000000,
      current_period_end: 1782600000,
    });

    const res = await reconcileSubscriptions(NOW);

    expect(res.reconciled).toBe(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({
        subscriptionStatus: "ACTIVE",
        dunningSince: null,
        currentPeriodStart: new Date(1780000000 * 1000),
        currentPeriodEnd: new Date(1782600000 * 1000),
      }),
    });
  });

  it("moves a Stripe past_due user to DUNNING", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u2",
        stripeSubscriptionId: "sub_2",
        tributeSubscriptionId: null,
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
      },
    ]);
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      status: "past_due",
      current_period_start: 1780000000,
      current_period_end: 1782600000,
    });

    await reconcileSubscriptions(NOW);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u2" },
      data: expect.objectContaining({
        subscriptionStatus: "DUNNING",
        dunningSince: expect.any(Date),
      }),
    });
  });

  it("does not restamp dunningSince for an already-DUNNING Stripe user", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u2b",
        stripeSubscriptionId: "sub_2b",
        tributeSubscriptionId: null,
        subscriptionStatus: "DUNNING",
        currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
      },
    ]);
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      status: "past_due",
      current_period_start: 1780000000,
      current_period_end: 1782600000,
    });

    await reconcileSubscriptions(NOW);

    const arg = (prisma.user.update as any).mock.calls[0][0];
    expect(arg.where).toEqual({ id: "u2b" });
    expect(arg.data.subscriptionStatus).toBe("DUNNING");
    expect("dunningSince" in arg.data).toBe(false);
  });

  it("date-expires a Tribute user past grace to CANCELED", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u3",
        stripeSubscriptionId: null,
        tributeSubscriptionId: "trb_1",
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 10 * DAY),
      },
    ]);

    const res = await reconcileSubscriptions(NOW);

    expect(res.reconciled).toBe(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u3" },
      data: { subscriptionStatus: "CANCELED", graceEndsAt: null },
    });
    expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("leaves a Tribute user still within grace untouched", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u4",
        stripeSubscriptionId: null,
        tributeSubscriptionId: "trb_2",
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
      },
    ]);

    const res = await reconcileSubscriptions(NOW);

    expect(res.reconciled).toBe(0);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("date-expires a provider-less user past grace to CANCELED", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u6",
        stripeSubscriptionId: null,
        tributeSubscriptionId: null,
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 10 * DAY),
      },
    ]);

    const res = await reconcileSubscriptions(NOW);

    expect(res.reconciled).toBe(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u6" },
      data: { subscriptionStatus: "CANCELED", graceEndsAt: null },
    });
    expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("leaves a provider-less user still within grace untouched", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u7",
        stripeSubscriptionId: null,
        tributeSubscriptionId: null,
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
      },
    ]);

    const res = await reconcileSubscriptions(NOW);

    expect(res.reconciled).toBe(0);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("skips a Stripe user when retrieve throws (logs, continues)", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u5",
        stripeSubscriptionId: "sub_5",
        tributeSubscriptionId: null,
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
      },
    ]);
    mockStripe.subscriptions.retrieve.mockRejectedValue(new Error("stripe down"));

    const res = await reconcileSubscriptions(NOW);

    expect(res.reconciled).toBe(0);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
