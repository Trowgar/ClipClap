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

import { vi } from "vitest";
import { subtitlesKeyboard } from "../handlers";

describe("subtitlesKeyboard", () => {
  it("renders the toggle with the current state + toggle callback", () => {
    const on = JSON.stringify(subtitlesKeyboard(t("en"), true));
    expect(on).toContain("subs_toggle");
    expect(on).toContain("on");
    const off = JSON.stringify(subtitlesKeyboard(t("ru"), false));
    expect(off).toContain("subs_toggle");
    expect(off).toContain("выкл");
  });
});

const toggleMocks = vi.hoisted(() => ({
  findOrCreateTelegramUser: vi.fn(),
  userUpdate: vi.fn(),
}));
vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    findOrCreateTelegramUser: toggleMocks.findOrCreateTelegramUser,
    prisma: { user: { update: toggleMocks.userUpdate } },
  };
});

import { handleSubtitlesToggle } from "../handlers";

describe("handleSubtitlesToggle", () => {
  it("flips subtitlesEnabled and edits the message to the new state", async () => {
    toggleMocks.findOrCreateTelegramUser.mockResolvedValue({ id: "u1", subtitlesEnabled: true });
    toggleMocks.userUpdate.mockResolvedValue({});
    const client = { editMessageText: vi.fn().mockResolvedValue(undefined) } as never;
    const query = { id: "q", from: { id: 42 }, message: { chat: { id: 7 }, message_id: 3 } };

    await handleSubtitlesToggle(client, query as never, t("en"));

    expect(toggleMocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1" }, data: { subtitlesEnabled: false } })
    );
    const edit = (client as unknown as { editMessageText: ReturnType<typeof vi.fn> }).editMessageText.mock.calls[0];
    expect(JSON.stringify(edit)).toContain("off"); // toggled to off
  });
});

import { matchSettingsAction } from "../handlers";

describe("matchSettingsAction", () => {
  it("matches the three sub-menu buttons in both locales", () => {
    expect(matchSettingsAction("🌐 Language")).toBe("lang");
    expect(matchSettingsAction("🌐 Язык")).toBe("lang");
    expect(matchSettingsAction("🎬 Video settings")).toBe("video");
    expect(matchSettingsAction("🎬 Настройки видео")).toBe("video");
    expect(matchSettingsAction("⬅️ Menu")).toBe("menu");
    expect(matchSettingsAction("⬅️ Меню")).toBe("menu");
    expect(matchSettingsAction("something else")).toBeNull();
  });
});
