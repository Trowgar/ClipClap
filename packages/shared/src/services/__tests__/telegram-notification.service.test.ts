import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notifyAdminPaymentEvent,
  renderPaymentNotification,
} from "../telegram-notification.service";

describe("renderPaymentNotification", () => {
  const periodEnd = new Date("2026-06-24T00:00:00Z");
  const graceEndsAt = new Date("2026-06-01T00:00:00Z");

  it("renders subscription_activated in EN with plan title, period, minutes and instructions", () => {
    const text = renderPaymentNotification(
      "en",
      { kind: "subscription_activated", plan: "MAX", periodEnd },
      { minutes: 3500 }
    );
    expect(text).toContain("🎉");
    expect(text).toContain("Max"); // title-cased, not "MAX"
    expect(text).toContain("2026-06-24");
    expect(text).toContain("3500");
    expect(text).toContain("Available");
    expect(text).toContain("send a video");
  });

  it("renders subscription_activated in RU with plan title, period, minutes and instructions", () => {
    const text = renderPaymentNotification(
      "ru",
      { kind: "subscription_activated", plan: "STARTER", periodEnd },
      { minutes: 75 }
    );
    expect(text).toContain("🎉");
    expect(text).toContain("Starter");
    expect(text).toContain("2026-06-24");
    expect(text).toContain("75");
    expect(text).toContain("Доступно");
    expect(text).toContain("пришли видео");
  });

  it("omits the quota line when minutes are unavailable", () => {
    const text = renderPaymentNotification("en", {
      kind: "subscription_activated",
      plan: "PLUS",
      periodEnd,
    });
    expect(text).toContain("Plus");
    expect(text).not.toContain("Available:");
  });

  it("renders subscription_renewed in both locales", () => {
    expect(
      renderPaymentNotification("en", {
        kind: "subscription_renewed",
        plan: "PLUS",
        periodEnd,
      })
    ).toContain("renewed until 2026-06-24");

    expect(
      renderPaymentNotification("ru", {
        kind: "subscription_renewed",
        plan: "PLUS",
        periodEnd,
      })
    ).toContain("продлена до 2026-06-24");
  });

  it("renders payment_failed with manage URL", () => {
    const en = renderPaymentNotification("en", {
      kind: "payment_failed",
      manageUrl: "https://clipclap.io/dashboard/plans",
    });
    expect(en).toContain("⚠️");
    expect(en).toContain("Payment failed");
    expect(en).toContain("https://clipclap.io/dashboard/plans");

    const ru = renderPaymentNotification("ru", {
      kind: "payment_failed",
      manageUrl: "https://clipclap.io/dashboard/plans",
    });
    expect(ru).toContain("⚠️");
    expect(ru).toContain("Оплата не прошла");
    expect(ru).toContain("https://clipclap.io/dashboard/plans");
  });

  it("renders subscription_canceled with grace period", () => {
    const en = renderPaymentNotification("en", {
      kind: "subscription_canceled",
      graceEndsAt,
    });
    expect(en).toContain("canceled");
    expect(en).toContain("2026-06-01");

    const ru = renderPaymentNotification("ru", {
      kind: "subscription_canceled",
      graceEndsAt,
    });
    expect(ru).toContain("отменена");
    expect(ru).toContain("2026-06-01");
  });

  it("renders subscription_canceled without grace as 'access disabled'", () => {
    const en = renderPaymentNotification("en", {
      kind: "subscription_canceled",
      graceEndsAt: null,
    });
    expect(en).toContain("Processing access is now disabled");

    const ru = renderPaymentNotification("ru", {
      kind: "subscription_canceled",
      graceEndsAt: null,
    });
    expect(ru).toContain("Доступ к обработке прекращён");
  });
});

describe("notifyAdminPaymentEvent", () => {
  afterEach(() => {
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
    vi.unstubAllGlobals();
  });

  it("sends a payment summary to every configured admin", async () => {
    process.env.REFERRAL_ADMIN_TELEGRAM_IDS = "575308044,999";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await notifyAdminPaymentEvent({
      kind: "subscription_activated",
      telegramId: "123456",
      plan: "STARTER",
      billingCycle: "WEEKLY",
      amount: 300,
      currency: "eur",
      periodEnd: new Date("2026-09-10T00:00:00Z"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies[0].chat_id).toBe("575308044");
    expect(bodies[1].chat_id).toBe("999");
    expect(bodies[0].text).toContain("Новая подписка");
    expect(bodies[0].text).toContain("Starter — €3 / неделя");
    expect(bodies[0].text).toContain("123456");
    expect(bodies[0].text).toContain("2026-09-10");
  });

  it("does nothing when no admin is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await notifyAdminPaymentEvent({
      kind: "subscription_renewed",
      telegramId: "123456",
      plan: "PLUS",
      billingCycle: "MONTHLY",
      amount: 2900,
      currency: "eur",
      periodEnd: new Date("2026-10-01T00:00:00Z"),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
