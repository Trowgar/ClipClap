import { describe, it, expect } from "vitest";
import { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "../../config/billing";
import { getSubscriptionState, isPeriodLive } from "../subscription-state";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-14T12:00:00Z");

function user(overrides: Record<string, unknown>) {
  return {
    plan: "MAX",
    subscriptionStatus: "ACTIVE",
    currentPeriodEnd: new Date(NOW.getTime() + 5 * DAY),
    ...overrides,
  } as any;
}

describe("isPeriodLive", () => {
  it("is false for a null period end", () => {
    expect(isPeriodLive(null, NOW)).toBe(false);
  });
  it("is true within grace after period end", () => {
    expect(isPeriodLive(new Date(NOW.getTime() - 1 * DAY), NOW)).toBe(true);
  });
  it("is false once grace has elapsed", () => {
    expect(
      isPeriodLive(
        new Date(NOW.getTime() - (SUBSCRIPTION_GRACE_BUFFER_DAYS + 1) * DAY),
        NOW
      )
    ).toBe(false);
  });
  it("is false exactly at the grace boundary (half-open interval)", () => {
    expect(
      isPeriodLive(
        new Date(NOW.getTime() - SUBSCRIPTION_GRACE_BUFFER_DAYS * DAY),
        NOW
      )
    ).toBe(false);
  });
});

describe("getSubscriptionState", () => {
  it("NONE plan -> phase NONE, not live", () => {
    expect(
      getSubscriptionState(user({ plan: "NONE", subscriptionStatus: "NONE" }), NOW)
    ).toEqual({ phase: "NONE", live: false });
  });
  it("status NONE -> phase NONE, not live", () => {
    expect(
      getSubscriptionState(user({ subscriptionStatus: "NONE" }), NOW)
    ).toEqual({ phase: "NONE", live: false });
  });
  it("CANCELED -> not live", () => {
    expect(
      getSubscriptionState(user({ subscriptionStatus: "CANCELED" }), NOW)
    ).toEqual({ phase: "CANCELED", live: false });
  });
  it("CANCELED_GRACE -> not live (matches the gate)", () => {
    expect(
      getSubscriptionState(user({ subscriptionStatus: "CANCELED_GRACE" }), NOW)
    ).toEqual({ phase: "CANCELED_GRACE", live: false });
  });
  it("ACTIVE with a future period -> live", () => {
    expect(
      getSubscriptionState(user({ subscriptionStatus: "ACTIVE" }), NOW)
    ).toEqual({ phase: "ACTIVE", live: true });
  });
  it("DUNNING within grace -> live", () => {
    expect(
      getSubscriptionState(
        user({
          subscriptionStatus: "DUNNING",
          currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
        }),
        NOW
      )
    ).toEqual({ phase: "DUNNING", live: true });
  });
  it("ACTIVE whose period ended past grace -> PERIOD_ENDED, not live (the reported bug)", () => {
    expect(
      getSubscriptionState(
        user({
          subscriptionStatus: "ACTIVE",
          currentPeriodEnd: new Date(
            NOW.getTime() - (SUBSCRIPTION_GRACE_BUFFER_DAYS + 1) * DAY
          ),
        }),
        NOW
      )
    ).toEqual({ phase: "PERIOD_ENDED", live: false });
  });
  it("ACTIVE with a null period end -> PERIOD_ENDED, not live", () => {
    expect(
      getSubscriptionState(
        user({ subscriptionStatus: "ACTIVE", currentPeriodEnd: null }),
        NOW
      )
    ).toEqual({ phase: "PERIOD_ENDED", live: false });
  });
});
