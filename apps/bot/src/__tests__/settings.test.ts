import { describe, expect, it } from "vitest";
import { t } from "../i18n";

describe("settings i18n", () => {
  it("has settings sub-menu labels in both locales", () => {
    expect(t("en").settingsLangBtn).toBe("🌐 Language");
    expect(t("ru").settingsLangBtn).toBe("🌐 Язык");
    expect(t("en").settingsVideoBtn).toBe("🎬 Video settings");
    expect(t("ru").settingsVideoBtn).toBe("🎬 Настройки видео");
    expect(t("en").settingsBackBtn).toBe("⬅️ Menu");
    expect(t("ru").settingsBackBtn).toBe("⬅️ Меню");
  });

  it("renders the subtitle toggle label and ack per state", () => {
    expect(t("en").subtitlesToggleBtn(true)).toContain("on");
    expect(t("en").subtitlesToggleBtn(false)).toContain("off");
    expect(t("ru").subtitlesToggleBtn(true)).toContain("вкл");
    expect(t("ru").subtitlesToggleBtn(false)).toContain("выкл");
    expect(t("ru").subtitlesAck(false)).toContain("выключены");
  });
});

import { languageKeyboard, parseLangCallback } from "../handlers";

describe("language without Auto", () => {
  it("parseLangCallback no longer accepts auto", () => {
    expect(parseLangCallback("lang_en")).toBe("en");
    expect(parseLangCallback("lang_ru")).toBe("ru");
    expect(parseLangCallback("lang_auto")).toBeNull();
  });

  it("languageKeyboard has only Russian and English", () => {
    const kb = JSON.stringify(languageKeyboard(t("en")));
    expect(kb).toContain("lang_en");
    expect(kb).toContain("lang_ru");
    expect(kb).not.toContain("lang_auto");
  });
});
