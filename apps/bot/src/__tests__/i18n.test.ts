import { describe, expect, it } from "vitest";
import { detectLocale, parseLangCommand, t } from "../i18n";

describe("bot i18n", () => {
  it("falls back to English for unknown language codes", () => {
    expect(detectLocale(undefined)).toBe("en");
    expect(detectLocale("")).toBe("en");
    expect(detectLocale("de")).toBe("en");
    expect(detectLocale("en-US")).toBe("en");
  });

  it("detects Russian from regional tags", () => {
    expect(detectLocale("ru")).toBe("ru");
    expect(detectLocale("ru-RU")).toBe("ru");
    expect(detectLocale("RU")).toBe("ru");
  });

  it("renders English link success without import count when zero", () => {
    expect(t("en").linkSuccess(0)).toBe("Telegram connected to your account.");
  });

  it("uses correct English plural for imported clips", () => {
    expect(t("en").linkSuccess(1)).toContain("1 clip from");
    expect(t("en").linkSuccess(5)).toContain("5 clips from");
  });

  it("uses correct Russian plural form for imported clips", () => {
    expect(t("ru").linkSuccess(1)).toContain("1 клип ");
    expect(t("ru").linkSuccess(2)).toContain("2 клипа ");
    expect(t("ru").linkSuccess(5)).toContain("5 клипов ");
    expect(t("ru").linkSuccess(21)).toContain("21 клип ");
  });

  it("renders done message with proper plural in both locales", () => {
    expect(t("en").done(1)).toBe("Done. 1 clip is ready.");
    expect(t("en").done(3)).toBe("Done. 3 clips are ready.");
    expect(t("ru").done(1)).toBe("Готово. 1 клип готов.");
    expect(t("ru").done(3)).toBe("Готово. 3 клипа готовы.");
    expect(t("ru").done(7)).toBe("Готово. 7 клипов готовы.");
    expect(t("ru").done(21)).toBe("Готово. 21 клип готов.");
    expect(t("ru").done(22)).toBe("Готово. 22 клипа готовы.");
    expect(t("ru").done(101)).toBe("Готово. 101 клип готов.");
    expect(t("ru").done(111)).toBe("Готово. 111 клипов готовы.");
  });

  it("returns null for non-/lang text", () => {
    expect(parseLangCommand("/start")).toBeNull();
    expect(parseLangCommand("hello")).toBeNull();
    expect(parseLangCommand("/language en")).toBeNull();
  });

  it("returns 'usage' for /lang without arg or with unknown arg", () => {
    expect(parseLangCommand("/lang")).toBe("usage");
    expect(parseLangCommand("/lang   ")).toBe("usage");
    expect(parseLangCommand("/lang fr")).toBe("usage");
    expect(parseLangCommand("/lang@clipclapbot")).toBe("usage");
  });

  it("parses explicit en/ru/auto in either language", () => {
    expect(parseLangCommand("/lang en")).toBe("en");
    expect(parseLangCommand("/lang EN")).toBe("en");
    expect(parseLangCommand("/lang английский")).toBe("en");
    expect(parseLangCommand("/lang ru")).toBe("ru");
    expect(parseLangCommand("/lang Русский")).toBe("ru");
    expect(parseLangCommand("/lang auto")).toBe("auto");
    expect(parseLangCommand("/lang авто")).toBe("auto");
    expect(parseLangCommand("/lang@clipclapbot en")).toBe("en");
  });

  it("renders the welcome choice in both locales", () => {
    expect(t("en").welcomeFirstChoice).toContain("New account");
    expect(t("en").welcomeFirstChoice).toContain("I already have");
    expect(t("ru").welcomeFirstChoice).toContain("Новый аккаунт");
    expect(t("ru").welcomeFirstChoice).toContain("Уже есть аккаунт");
  });

  it("has unique menu button labels per locale", () => {
    const en = t("en");
    const ru = t("ru");
    const enLabels = [en.menuAccount, en.menuHelp, en.menuSettings];
    const ruLabels = [ru.menuAccount, ru.menuHelp, ru.menuSettings];
    expect(new Set(enLabels).size).toBe(3);
    expect(new Set(ruLabels).size).toBe(3);
  });

  it("exposes settingsMenuPrompt in both locales", () => {
    expect(t("en").settingsMenuPrompt).toBe("Settings:");
    expect(t("ru").settingsMenuPrompt).toBe("Настройки:");
  });

  it("keeps bot description within Telegram's 512-char limit per locale", () => {
    expect(t("en").botDescription.length).toBeGreaterThan(0);
    expect(t("en").botDescription.length).toBeLessThanOrEqual(512);
    expect(t("ru").botDescription.length).toBeGreaterThan(0);
    expect(t("ru").botDescription.length).toBeLessThanOrEqual(512);
  });

  it("keeps bot short description within Telegram's 120-char limit per locale", () => {
    expect(t("en").botShortDescription.length).toBeGreaterThan(0);
    expect(t("en").botShortDescription.length).toBeLessThanOrEqual(120);
    expect(t("ru").botShortDescription.length).toBeGreaterThan(0);
    expect(t("ru").botShortDescription.length).toBeLessThanOrEqual(120);
  });

  it("exposes a well-formed commands list per locale", () => {
    for (const loc of ["en", "ru"] as const) {
      const cmds = t(loc).commands;
      expect(cmds.length).toBeGreaterThan(0);
      for (const c of cmds) {
        expect(c.command).toMatch(/^[a-z]+$/);
        expect(c.description.length).toBeGreaterThan(0);
        expect(c.description.length).toBeLessThanOrEqual(256);
      }
    }
  });

  it("includes the canonical command set in both locales", () => {
    for (const loc of ["en", "ru"] as const) {
      const names = t(loc).commands.map((c) => c.command);
      expect(names).toEqual([
        "start",
        "account",
        "help",
        "settings",
        "lang",
        "link",
        "referral",
      ]);
    }
  });

  it("renders a value-pitch welcome with numbered steps for new users", () => {
    expect(t("en").welcomeFirstChoice).toContain("vertical clips");
    expect(t("en").welcomeFirstChoice).toContain("1.");
    expect(t("en").welcomeFirstChoice).toContain("2.");
    expect(t("en").welcomeFirstChoice).toContain("3.");
    expect(t("en").welcomeFirstChoice).toContain("New account");
    expect(t("ru").welcomeFirstChoice).toContain("вертикальные клипы");
    expect(t("ru").welcomeFirstChoice).toContain("1.");
    expect(t("ru").welcomeFirstChoice).toContain("2.");
    expect(t("ru").welcomeFirstChoice).toContain("3.");
    expect(t("ru").welcomeFirstChoice).toContain("Новый аккаунт");
  });

  it("exposes localized language-button labels", () => {
    expect(t("en").langBtnEn).toContain("English");
    expect(t("en").langBtnRu).toContain("Русский");
    expect(t("en").langBtnAuto.toLowerCase()).toContain("auto");
    expect(t("ru").langBtnEn).toContain("English");
    expect(t("ru").langBtnRu).toContain("Русский");
    expect(t("ru").langBtnAuto.toLowerCase()).toContain("авто");
  });

  it("renders accountText NONE variant in both locales", () => {
    const en = t("en").accountText({
      plan: "NONE",
      billingCycle: null,
      periodEnd: null,
      daysUntilPeriodEnd: null,
      minutesUsed: 0,
      minutesLimit: 0,
      topUpMinutes: 0,
      clipsStored: 0,
      storageClipsLimit: 0,
      retentionDays: 0,
      clipsTotal: 0,
    });
    expect(en).toContain("Plan: no active plan");
    expect(en).toContain("Pick a plan");
    expect(en).toContain("Total clips created: 0");
    expect(en).not.toContain("Minutes:");
    expect(en).not.toContain("Storage:");

    const ru = t("ru").accountText({
      plan: "NONE",
      billingCycle: null,
      periodEnd: null,
      daysUntilPeriodEnd: null,
      minutesUsed: 0,
      minutesLimit: 0,
      topUpMinutes: 0,
      clipsStored: 0,
      storageClipsLimit: 0,
      retentionDays: 0,
      clipsTotal: 0,
    });
    expect(ru).toContain("Тариф: нет активного");
    expect(ru).toContain("Выбери тариф");
    expect(ru).toContain("Всего создано: 0");
    expect(ru).not.toContain("Минуты:");
    expect(ru).not.toContain("Хранилище:");
  });

  it("renders accountText active plan with top-up in EN", () => {
    const text = t("en").accountText({
      plan: "STARTER",
      billingCycle: "monthly",
      periodEnd: "2026-06-24",
      daysUntilPeriodEnd: 31,
      minutesUsed: 45,
      minutesLimit: 270,
      topUpMinutes: 100,
      clipsStored: 8,
      storageClipsLimit: 20,
      retentionDays: 7,
      clipsTotal: 42,
    });
    expect(text).toContain("Plan: STARTER (monthly)");
    expect(text).toContain("Renews: 2026-06-24 (in 31 days)");
    expect(text).toContain("Minutes: 45 / 270 this period (225 left)");
    expect(text).toContain("Top-up: 100 minutes");
    expect(text).toContain("Storage: 8 / 20 clips (kept for 7 days)");
    expect(text).toContain("Total clips created: 42");
  });

  it("renders accountText active plan with top-up in RU with correct plurals", () => {
    const text = t("ru").accountText({
      plan: "STARTER",
      billingCycle: "monthly",
      periodEnd: "2026-06-24",
      daysUntilPeriodEnd: 31,
      minutesUsed: 45,
      minutesLimit: 270,
      topUpMinutes: 100,
      clipsStored: 8,
      storageClipsLimit: 20,
      retentionDays: 7,
      clipsTotal: 42,
    });
    expect(text).toContain("Тариф: STARTER (месячный)");
    expect(text).toContain("Продление: 2026-06-24 (через 31 день)");
    expect(text).toContain("Минуты: 45 / 270 в этом периоде (осталось 225)");
    expect(text).toContain("Дополнительно: 100 минут");
    expect(text).toContain("Хранилище: 8 / 20 клипов (хранятся 7 дней)");
    expect(text).toContain("Всего создано: 42 клипа");
  });

  it("omits top-up line when topUpMinutes is 0", () => {
    const en = t("en").accountText({
      plan: "STARTER",
      billingCycle: "monthly",
      periodEnd: "2026-06-24",
      daysUntilPeriodEnd: 31,
      minutesUsed: 45,
      minutesLimit: 270,
      topUpMinutes: 0,
      clipsStored: 8,
      storageClipsLimit: 20,
      retentionDays: 7,
      clipsTotal: 42,
    });
    expect(en).not.toContain("Top-up");

    const ru = t("ru").accountText({
      plan: "STARTER",
      billingCycle: "monthly",
      periodEnd: "2026-06-24",
      daysUntilPeriodEnd: 31,
      minutesUsed: 45,
      minutesLimit: 270,
      topUpMinutes: 0,
      clipsStored: 8,
      storageClipsLimit: 20,
      retentionDays: 7,
      clipsTotal: 42,
    });
    expect(ru).not.toContain("Дополнительно");
  });

  it("renders correct Russian noun plurals for clips and days", () => {
    const base = {
      plan: "STARTER",
      billingCycle: "monthly",
      periodEnd: "2026-06-24",
      minutesUsed: 0,
      minutesLimit: 270,
      topUpMinutes: 0,
      storageClipsLimit: 20,
      retentionDays: 7,
    };
    expect(
      t("ru").accountText({
        ...base,
        daysUntilPeriodEnd: 1,
        clipsStored: 1,
        clipsTotal: 1,
      })
    ).toContain("через 1 день");

    expect(
      t("ru").accountText({
        ...base,
        daysUntilPeriodEnd: 3,
        clipsStored: 3,
        clipsTotal: 3,
      })
    ).toContain("через 3 дня");

    expect(
      t("ru").accountText({
        ...base,
        daysUntilPeriodEnd: 11,
        clipsStored: 5,
        clipsTotal: 5,
      })
    ).toContain("через 11 дней");

    expect(
      t("ru").accountText({
        ...base,
        daysUntilPeriodEnd: 21,
        clipsStored: 21,
        clipsTotal: 21,
      })
    ).toContain("через 21 день");

    const t5 = t("ru").accountText({
      ...base,
      daysUntilPeriodEnd: null,
      clipsStored: 5,
      clipsTotal: 5,
    });
    expect(t5).toContain("Хранилище: 5 / 20 клипов");
    expect(t5).toContain("Всего создано: 5 клипов");
  });

  it("exposes manageSubscriptionBtn in both locales", () => {
    expect(t("en").manageSubscriptionBtn).toBe("🔧 Manage subscription");
    expect(t("ru").manageSubscriptionBtn).toBe("🔧 Управление подпиской");
  });

  it("exposes checkingLink in both locales", () => {
    expect(t("en").checkingLink).toBe("Checking link…");
    expect(t("ru").checkingLink).toBe("Проверяю ссылку…");
  });

  it("exposes urlAccessFailed with platform-agnostic fallback hint in both locales", () => {
    expect(t("en").urlAccessFailed).toContain("Couldn't access");
    expect(t("en").urlAccessFailed).toContain("upload");
    expect(t("ru").urlAccessFailed).toContain("Не удалось");
    expect(t("ru").urlAccessFailed).toContain("загрузи");
  });

  it("helpText mentions URL support in both locales", () => {
    expect(t("en").helpText("https://clipclap.io").toLowerCase()).toContain("url");
    expect(t("ru").helpText("https://clipclap.io").toLowerCase()).toContain("ссылк");
  });

});
