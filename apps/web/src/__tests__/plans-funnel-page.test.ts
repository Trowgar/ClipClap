import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

const authMock = vi.hoisted(() => vi.fn());
const getUsageMock = vi.hoisted(() => vi.fn());
const recordFunnelEventMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/components/plan-card", () => ({ PlanCard: () => null }));
vi.mock("@/components/topup-button", () => ({ TopupButton: () => null }));

vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    userService: { getUsage: getUsageMock },
    recordFunnelEvent: recordFunnelEventMock,
  };
});

import { FUNNEL_EVENTS } from "@clipclap/shared";
import PlansPage from "../../app/(dashboard)/dashboard/plans/page";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "user-1" } });
  getUsageMock.mockResolvedValue({ plan: "NONE", billingCycle: null });
});

describe("Plans page funnel telemetry", () => {
  it("records a web plans_opened event for the signed-in user", async () => {
    await PlansPage();

    expect(recordFunnelEventMock).toHaveBeenCalledWith(
      "web",
      "user-1",
      FUNNEL_EVENTS.PLANS_OPENED
    );
  });
});
