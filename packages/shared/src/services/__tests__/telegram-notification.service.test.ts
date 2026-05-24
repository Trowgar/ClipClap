import { describe, expect, it } from "vitest";
import { renderPaymentNotification } from "../telegram-notification.service";

describe("renderPaymentNotification", () => {
  const periodEnd = new Date("2026-06-24T00:00:00Z");
  const graceEndsAt = new Date("2026-06-01T00:00:00Z");

  it("renders subscription_activated in EN with plan and period", () => {
    const text = renderPaymentNotification("en", {
      kind: "subscription_activated",
      plan: "MAX",
      periodEnd,
    });
    expect(text).toContain("🎉");
    expect(text).toContain("MAX");
    expect(text).toContain("2026-06-24");
    expect(text).toContain("Send a video");
  });

  it("renders subscription_activated in RU with plan and period", () => {
    const text = renderPaymentNotification("ru", {
      kind: "subscription_activated",
      plan: "STARTER",
      periodEnd,
    });
    expect(text).toContain("🎉");
    expect(text).toContain("STARTER");
    expect(text).toContain("2026-06-24");
    expect(text).toContain("Пришли видео");
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
