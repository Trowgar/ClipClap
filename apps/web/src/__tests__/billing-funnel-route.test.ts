import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => vi.fn());
const createCheckoutSessionMock = vi.hoisted(() => vi.fn());
const recordFunnelEventMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ auth: authMock }));

vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    billingService: { createCheckoutSession: createCheckoutSessionMock },
    recordFunnelEvent: recordFunnelEventMock,
  };
});

import { POST } from "../../app/api/billing/checkout/route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "user-1" } });
  createCheckoutSessionMock.mockResolvedValue("https://checkout.example/session");
});

describe("POST /api/billing/checkout funnel telemetry", () => {
  it("records checkout_started only after a checkout URL is created", async () => {
    const response = await POST(request({ plan: "STARTER", cycle: "WEEKLY" }));

    expect(response.status).toBe(200);
    expect(recordFunnelEventMock).toHaveBeenCalledWith(
      "web",
      "user-1",
      "checkout_started"
    );
  });

  it("records checkout_error when checkout creation fails", async () => {
    createCheckoutSessionMock.mockRejectedValue(new Error("Stripe unavailable"));

    const response = await POST(request({ plan: "STARTER", cycle: "WEEKLY" }));

    expect(response.status).toBe(500);
    expect(recordFunnelEventMock).toHaveBeenCalledWith(
      "web",
      "user-1",
      "checkout_error"
    );
  });
});
