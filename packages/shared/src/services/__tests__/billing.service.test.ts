import { describe, it, expect, beforeEach, vi } from "vitest";

const mockStripe = {
  customers: { create: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
  subscriptions: { retrieve: vi.fn() },
  webhooks: { constructEvent: vi.fn() },
};

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => mockStripe),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { prisma } from "../../lib/prisma";
import { createCheckoutSession, UnsupportedPlanCycleError, handleWebhook } from "../billing.service";

describe("billing.service — createCheckoutSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test");
    vi.stubEnv("STRIPE_STARTER_WEEKLY_PRICE_ID", "price_sw");
    vi.stubEnv("STRIPE_STARTER_MONTHLY_PRICE_ID", "price_sm");
    vi.stubEnv("STRIPE_PLUS_MONTHLY_PRICE_ID", "price_pm");
    vi.stubEnv("STRIPE_MAX_MONTHLY_PRICE_ID", "price_mm");
  });

  it("routes STARTER+WEEKLY to correct price and propagates metadata to subscription", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      email: "a@b.c",
      stripeCustomerId: "cus_1",
    });
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout" });

    await createCheckoutSession("u1", "STARTER", "WEEKLY", "https://x", "https://y");

    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_sw", quantity: 1 }],
        mode: "subscription",
        metadata: expect.objectContaining({ userId: "u1", plan: "STARTER", cycle: "WEEKLY" }),
        subscription_data: expect.objectContaining({
          metadata: expect.objectContaining({ userId: "u1", plan: "STARTER", cycle: "WEEKLY" }),
        }),
      })
    );
  });

  it("routes PLUS+MONTHLY to plus price", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      email: "a@b.c",
      stripeCustomerId: "cus_1",
    });
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout" });

    await createCheckoutSession("u1", "PLUS", "MONTHLY", "https://x", "https://y");

    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_pm", quantity: 1 }],
      })
    );
  });

  it("routes MAX+MONTHLY to max price", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      email: "a@b.c",
      stripeCustomerId: "cus_1",
    });
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout" });

    await createCheckoutSession("u1", "MAX", "MONTHLY", "https://x", "https://y");

    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_mm", quantity: 1 }],
      })
    );
  });

  it("rejects PLUS+WEEKLY with UnsupportedPlanCycleError (typed for 4xx routing)", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      email: "a@b.c",
      stripeCustomerId: "cus_1",
    });

    await expect(
      createCheckoutSession("u1", "PLUS", "WEEKLY", "https://x", "https://y")
    ).rejects.toBeInstanceOf(UnsupportedPlanCycleError);
  });

  it("rejects MAX+WEEKLY", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      email: "a@b.c",
      stripeCustomerId: "cus_1",
    });

    await expect(
      createCheckoutSession("u1", "MAX", "WEEKLY", "https://x", "https://y")
    ).rejects.toThrow(/weekly|unsupported/i);
  });

  it("creates Stripe customer if user has none", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      email: "a@b.c",
      stripeCustomerId: null,
    });
    mockStripe.customers.create.mockResolvedValue({ id: "cus_new" });
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout" });

    await createCheckoutSession("u1", "STARTER", "MONTHLY", "https://x", "https://y");

    expect(mockStripe.customers.create).toHaveBeenCalledWith({
      email: "a@b.c",
      metadata: { userId: "u1" },
    });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { stripeCustomerId: "cus_new" },
      })
    );
  });

  it("throws when required env var is missing", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test");
    // STRIPE_STARTER_MONTHLY_PRICE_ID intentionally not set

    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      email: "a@b.c",
      stripeCustomerId: "cus_1",
    });

    await expect(
      createCheckoutSession("u1", "STARTER", "MONTHLY", "https://x", "https://y")
    ).rejects.toThrow(/STRIPE_STARTER_MONTHLY_PRICE_ID/i);
  });
});

describe("billing.service — handleWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
    vi.stubEnv("STRIPE_STARTER_WEEKLY_PRICE_ID", "price_sw");
    vi.stubEnv("STRIPE_STARTER_MONTHLY_PRICE_ID", "price_sm");
    vi.stubEnv("STRIPE_PLUS_MONTHLY_PRICE_ID", "price_pm");
    vi.stubEnv("STRIPE_MAX_MONTHLY_PRICE_ID", "price_mm");
  });

  it("checkout.session.completed (subscription mode) activates subscription with plan, cycle, and currentPeriodEnd", async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          metadata: { userId: "u1", plan: "PLUS", cycle: "MONTHLY" },
          subscription: "sub_1",
        },
      },
    });
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: "sub_1",
      items: { data: [{ price: { id: "price_pm" } }] },
      current_period_end: 1781000000,
    });

    await handleWebhook("body", "sig");

    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u1" },
        data: expect.objectContaining({
          plan: "PLUS",
          billingCycle: "MONTHLY",
          subscriptionStatus: "ACTIVE",
          stripeSubscriptionId: "sub_1",
          dunningSince: null,
          graceEndsAt: null,
          currentPeriodEnd: new Date(1781000000 * 1000),
        }),
      })
    );
  });

  it("invoice.payment_failed sets DUNNING with dunningSince", async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: "invoice.payment_failed",
      data: {
        object: {
          subscription: "sub_1",
          customer: "cus_1",
        },
      },
    });

    await handleWebhook("body", "sig");

    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: "sub_1" },
        data: expect.objectContaining({
          subscriptionStatus: "DUNNING",
          dunningSince: expect.any(Date),
        }),
      })
    );
  });

  it("invoice.payment_succeeded clears DUNNING and updates currentPeriodEnd", async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: "invoice.payment_succeeded",
      data: {
        object: {
          subscription: "sub_1",
          period_end: 1782000000,
        },
      },
    });
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: "sub_1",
      current_period_end: 1782000000,
    });

    await handleWebhook("body", "sig");

    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: "sub_1" },
        data: expect.objectContaining({
          subscriptionStatus: "ACTIVE",
          dunningSince: null,
          currentPeriodEnd: new Date(1782000000 * 1000),
        }),
      })
    );
  });

  it("customer.subscription.deleted enters 7-day grace", async () => {
    const before = Date.now();
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: "customer.subscription.deleted",
      data: {
        object: { id: "sub_1" },
      },
    });

    await handleWebhook("body", "sig");

    const callArgs = (prisma.user.updateMany as any).mock.calls[0][0];
    expect(callArgs.where).toEqual({ stripeSubscriptionId: "sub_1" });
    expect(callArgs.data.subscriptionStatus).toBe("CANCELED_GRACE");
    const grace = callArgs.data.graceEndsAt as Date;
    const expectedMin = before + 7 * 24 * 60 * 60 * 1000 - 1000;
    const expectedMax = Date.now() + 7 * 24 * 60 * 60 * 1000 + 1000;
    expect(grace.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(grace.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  it("customer.subscription.updated with new price changes plan and cycle", async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          items: { data: [{ price: { id: "price_mm" } }] },
          current_period_end: 1781000000,
        },
      },
    });

    await handleWebhook("body", "sig");

    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: "sub_1" },
        data: expect.objectContaining({
          plan: "MAX",
          billingCycle: "MONTHLY",
          currentPeriodEnd: new Date(1781000000 * 1000),
        }),
      })
    );
  });

  it("ignores events with no recognizable type", async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: "ping",
      data: { object: {} },
    });

    await handleWebhook("body", "sig");

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});
