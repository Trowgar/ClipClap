import { beforeEach, describe, expect, it } from "vitest";
import { t } from "../i18n";

describe("plans i18n", () => {
  it("has the Plans menu label in both locales", () => {
    expect(t("en").menuPlans).toBe("💳 Plans");
    expect(t("ru").menuPlans).toBe("💳 Тарифы");
  });

  it("plansText lists the real prices and minutes", () => {
    for (const loc of ["en", "ru"] as const) {
      const s = t(loc).plansText;
      expect(s).toContain("€3");
      expect(s).toContain("€9");
      expect(s).toContain("€29");
      expect(s).toContain("€89");
      expect(s).toContain("75");
      expect(s).toContain("1000");
      expect(s).toContain("3500");
    }
  });

  it("plansSubscribed shows the plan and renewal date", () => {
    expect(t("en").plansSubscribed("PLUS", "2026-08-14")).toContain("PLUS");
    expect(t("en").plansSubscribed("PLUS", "2026-08-14")).toContain("2026-08-14");
    expect(t("ru").plansSubscribed("MAX", null)).toContain("MAX");
  });

  it("billing copy no longer links to the website", () => {
    for (const loc of ["en", "ru"] as const) {
      const d = t(loc);
      expect(d.welcomeNeedsPlan).not.toMatch(/dashboard|clipclap\.io/);
      expect(d.welcomeFirstScreen).not.toMatch(/dashboard|clipclap\.io/);
      expect(d.blocked("limit reached")).not.toMatch(/dashboard|clipclap\.io/);
    }
  });
});

import { vi } from "vitest";

const flowMocks = vi.hoisted(() => ({ getUsageForUser: vi.fn() }));
vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getUsageForUser: flowMocks.getUsageForUser, prisma: { user: { findUnique: vi.fn() } } };
});

import { matchMenuAction, sendPlansView } from "../handlers";

function fakeClient() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
}

describe("plans menu wiring", () => {
  it("matches the Plans label to the plans action (EN + RU), others unchanged", () => {
    expect(matchMenuAction("💳 Plans")).toBe("plans");
    expect(matchMenuAction("💳 Тарифы")).toBe("plans");
    expect(matchMenuAction("📊 Account")).toBe("account");
  });
});

describe("sendPlansView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("no user: shows plan cards + sub:* buttons without calling getUsageForUser", async () => {
    const client = fakeClient();
    await sendPlansView(client, { chat: { id: 1 } } as never, t("en"), { appUrl: "https://x" }, null);
    expect(flowMocks.getUsageForUser).not.toHaveBeenCalled();
    const call = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0];
    expect(call[1]).toContain("€89");
    expect(JSON.stringify(call[2])).toContain("sub:MAX:MONTHLY");
  });

  it("no live plan: shows plan cards + sub:* buttons", async () => {
    flowMocks.getUsageForUser.mockResolvedValue({ plan: "NONE", subscriptionState: { phase: "NONE", live: false }, currentPeriodEnd: null, paymentProvider: null });
    const client = fakeClient();
    await sendPlansView(client, { chat: { id: 1 } } as never, t("en"), { appUrl: "https://x" }, { id: "u1" });
    const call = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0];
    expect(JSON.stringify(call[2])).toContain("sub:STARTER:WEEKLY");
  });

  it("subscribed (any provider): Manage always -> Tribute, never the site, no buy buttons", async () => {
    // paymentProvider null == a manual grant; the Manage button must still go to
    // Tribute, not the website (bot's only paid channel is Tribute).
    flowMocks.getUsageForUser.mockResolvedValue({ plan: "PLUS", subscriptionState: { phase: "ACTIVE", live: true }, currentPeriodEnd: new Date("2026-08-14T00:00:00.000Z"), paymentProvider: null });
    const client = fakeClient();
    await sendPlansView(client, { chat: { id: 1 } } as never, t("en"), { appUrl: "https://x" }, { id: "u1" });
    const call = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0];
    expect(call[1]).toContain("PLUS");
    expect(call[1]).toContain("2026-08-14");
    const opts = JSON.stringify(call[2]);
    expect(opts).toContain("https://t.me/tribute");
    expect(opts).not.toContain("dashboard");
    expect(opts).not.toContain("sub:");
  });
});

describe("account nudge copy", () => {
  it("noPlanNudge points at the Plans button, not the site", () => {
    expect(t("en").noPlanNudge).toContain("💳 Plans");
    expect(t("en").noPlanNudge).not.toMatch(/dashboard|clipclap\.io/);
    expect(t("ru").noPlanNudge).toContain("💳 Тарифы");
  });
});
