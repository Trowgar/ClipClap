import { describe, expect, it } from "vitest";
import { t } from "../i18n";
import { matchReferralAction } from "../handlers";

describe("referral withdrawal", () => {
  it("has the withdraw button + stub in both locales", () => {
    expect(t("en").referralWithdrawBtn).toContain("Request withdrawal");
    expect(t("ru").referralWithdrawBtn).toContain("Запросить вывод");
    expect(t("en").referralWithdrawStub).toContain("enough funds");
    expect(t("ru").referralWithdrawStub).toContain("недостаточно средств");
  });

  it("no longer points to the website payouts page", () => {
    const en = t("en").referralInfo("w", "t", "0.00", "0.00");
    const ru = t("ru").referralInfo("w", "t", "0.00", "0.00");
    expect(en).not.toContain("payouts");
    expect(ru).not.toContain("payouts");
  });

  it("matchReferralAction maps the withdraw button in both locales", () => {
    expect(matchReferralAction(t("en").referralWithdrawBtn)).toBe("withdraw");
    expect(matchReferralAction(t("ru").referralWithdrawBtn)).toBe("withdraw");
    expect(matchReferralAction("something else")).toBeNull();
  });
});
