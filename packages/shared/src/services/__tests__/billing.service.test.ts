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
import { createCheckoutSession, UnsupportedPlanCycleError } from "../billing.service";

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
