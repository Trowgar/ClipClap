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
    const enLabels = [en.menuPlans, en.menuAccount, en.menuHelp, en.menuLanguage];
    const ruLabels = [ru.menuPlans, ru.menuAccount, ru.menuHelp, ru.menuLanguage];
    expect(new Set(enLabels).size).toBe(4);
    expect(new Set(ruLabels).size).toBe(4);
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
      expect(names).toEqual(["start", "plans", "account", "help", "lang", "link"]);
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
});
