import { beforeEach, expect, it, vi } from "vitest";
import { prisma } from "../../lib/prisma";
import { getStripe } from "../billing.service";
import { getUsageForUser } from "../usage.service";
import { recordConversionEvent } from "../funnel.service";
import { createTopupCheckoutSession } from "../topup.service";

vi.mock("../../lib/prisma", () => ({ prisma: { user: { findUniqueOrThrow: vi.fn() } } }));
vi.mock("../billing.service", () => ({ getStripe: vi.fn(), CHECKOUT_API_VERSION: "2025-03-31.basil" }));
vi.mock("../usage.service", () => ({ getUsageForUser: vi.fn() }));
vi.mock("../funnel.service", () => ({ recordConversionEvent: vi.fn() }));

const create = vi.fn();
const user = () => ({ plan: "STARTER", billingCycle: "WEEKLY", stripeCustomerId: "cus_1",
  subscriptionStatus: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 86400000) });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("STRIPE_TOPUP_SMALL_PRICE_ID", "price_small");
  vi.stubEnv("STRIPE_TOPUP_LARGE_PRICE_ID", "price_large");
  vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue(user() as any);
  vi.mocked(getUsageForUser).mockResolvedValue({ minutesLimit: 75, minutesUsed: 75, topUpMinutesRemaining: 0 } as any);
  vi.mocked(getStripe).mockReturnValue({ checkout: { sessions: { create } } } as any);
  create.mockResolvedValue({ id: "cs_topup", url: "https://checkout.example" });
});

it.each([
  { plan: "NONE", subscriptionStatus: "NONE" },
  { stripeCustomerId: null },
  { subscriptionStatus: "CANCELED" },
  { subscriptionStatus: "CANCELED_GRACE" },
  { currentPeriodEnd: null },
  { currentPeriodEnd: new Date(0) },
  // Lifecycle grace allows access, but must not authorize selling new minutes.
  { currentPeriodEnd: new Date(Date.now() - 1000) },
])("does not sell minutes to an ineligible subscription: %j", async (fields) => {
  vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({ ...user(), ...fields } as any);
  await expect(createTopupCheckoutSession("u1", "SMALL", "ok", "cancel")).rejects.toThrow(/subscri/i);
  expect(create).not.toHaveBeenCalled();
});

it.each([0, -1, NaN, Infinity, null, "60", 177 * 60, 180 * 60 + 1])("rejects invalid or uncovered duration %s", async (duration) => {
  await expect(createTopupCheckoutSession("u1", "SMALL", "ok", "cancel", duration as number)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  expect(recordConversionEvent).not.toHaveBeenCalled();
});

it("does not sell even a large pack above the source cap", async () => {
  await expect(createTopupCheckoutSession("u1", "LARGE", "ok", "cancel", 181 * 60)).rejects.toThrow(/source|180/i);
  expect(create).not.toHaveBeenCalled();
});

it("uses current subscription balance plus existing topups, without rounding seconds", async () => {
  vi.mocked(getUsageForUser).mockResolvedValue({ minutesLimit: 75, minutesUsed: 25, topUpMinutesRemaining: 27 } as any);
  await expect(createTopupCheckoutSession("u1", "SMALL", "ok", "cancel", 177 * 60)).resolves.toBe("https://checkout.example");
  await expect(createTopupCheckoutSession("u1", "SMALL", "ok", "cancel", 177 * 60 + 1)).rejects.toThrow();
  expect(create).toHaveBeenCalledTimes(1);
});

it("deducts existing overage before adding a pack", async () => {
  vi.mocked(getUsageForUser).mockResolvedValue({ minutesLimit: 75, minutesUsed: 105, topUpMinutesRemaining: 10 } as any);
  // Signed balance is -20: a 100-minute pack covers exactly 80 minutes.
  await expect(createTopupCheckoutSession("u1", "SMALL", "ok", "cancel", 80 * 60 + 1)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  await expect(createTopupCheckoutSession("u1", "SMALL", "ok", "cancel", 80 * 60)).resolves.toBe("https://checkout.example");
  expect(create).toHaveBeenCalledTimes(1);
});

it.each([undefined, 177 * 60, 180 * 60])("sells an eligible large pack and records the provider session: %s", async (durationSec) => {
  await createTopupCheckoutSession("u1", "LARGE", "ok", "cancel", durationSec);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({
    customer: "cus_1", mode: "payment", line_items: [{ price: "price_large", quantity: 1 }],
  }), { apiVersion: "2025-03-31.basil" });
  expect(recordConversionEvent).toHaveBeenCalledWith("web", "u1", "checkout_started",
    expect.objectContaining({ provider: "stripe", sessionId: "cs_topup", pack: "LARGE" }),
    "stripe:checkout_started:cs_topup");
});
