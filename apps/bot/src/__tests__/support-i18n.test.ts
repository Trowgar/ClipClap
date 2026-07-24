import { describe, expect, it } from "vitest";
import { t } from "../i18n";

describe("support + help i18n", () => {
  it("has the help sub-menu labels in both locales", () => {
    expect(t("en").helpHowBtn).toContain("How it works");
    expect(t("ru").helpHowBtn).toContain("Как это работает");
    expect(t("en").helpSupportBtn).toContain("Support");
    expect(t("ru").helpSupportBtn).toContain("Поддержка");
  });

  it("has the support session strings in both locales", () => {
    for (const loc of ["en", "ru"] as const) {
      const d = t(loc);
      expect(d.supportPrompt.length).toBeGreaterThan(0);
      expect(d.supportCloseBtn.length).toBeGreaterThan(0);
      expect(d.supportClosed.length).toBeGreaterThan(0);
      expect(d.supportReplyPrefix.length).toBeGreaterThan(0);
      expect(d.supportUnavailable.length).toBeGreaterThan(0);
      expect(d.supportVideoInSession.length).toBeGreaterThan(0);
      expect(d.supportMediaUnsupported.length).toBeGreaterThan(0);
      expect(d.helpMenuPrompt.length).toBeGreaterThan(0);
    }
  });
});
