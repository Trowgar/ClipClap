import { describe, expect, it } from "vitest";
import { t } from "../i18n";
import { matchHelpAction } from "../handlers";

describe("matchHelpAction", () => {
  it("maps the how/support labels in both locales", () => {
    expect(matchHelpAction(t("en").helpHowBtn)).toBe("how");
    expect(matchHelpAction(t("ru").helpHowBtn)).toBe("how");
    expect(matchHelpAction(t("en").helpSupportBtn)).toBe("support");
    expect(matchHelpAction(t("ru").helpSupportBtn)).toBe("support");
  });

  it("does not match the back button or unrelated text", () => {
    expect(matchHelpAction(t("en").settingsBackBtn)).toBeNull();
    expect(matchHelpAction("random")).toBeNull();
  });
});
