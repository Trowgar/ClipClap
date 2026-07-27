import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  detectLocale,
  isLocale,
  plural,
} from "../i18n";

describe("locale registry", () => {
  it("has no duplicates and a default that is in the list", () => {
    expect(new Set(LOCALES).size).toBe(LOCALES.length);
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });

  // Telegram tags are IETF, not bare codes, so a locale whose code does not
  // survive lowercasing and primary-subtag extraction would never be detected
  // from language_code - the user would silently get English forever.
  it("detects every supported locale from its own code and region tags", () => {
    for (const loc of LOCALES) {
      expect(detectLocale(loc)).toBe(loc);
      expect(detectLocale(loc.toUpperCase())).toBe(loc);
      expect(detectLocale(`${loc}-XX`)).toBe(loc);
      expect(detectLocale(`${loc}_XX`)).toBe(loc);
      expect(isLocale(loc)).toBe(true);
    }
  });

  it("falls back to the default for unknown, empty or missing codes", () => {
    expect(detectLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(detectLocale(null)).toBe(DEFAULT_LOCALE);
    expect(detectLocale("")).toBe(DEFAULT_LOCALE);
    expect(detectLocale("   ")).toBe(DEFAULT_LOCALE);
    expect(detectLocale("de")).toBe(DEFAULT_LOCALE);
    expect(detectLocale("zz-ZZ")).toBe(DEFAULT_LOCALE);
    expect(isLocale("de")).toBe(false);
  });
});

describe("plural", () => {
  it("selects English one/other", () => {
    const forms = { one: "clip", other: "clips" };
    expect(plural("en", 1, forms)).toBe("clip");
    expect(plural("en", 0, forms)).toBe("clips");
    expect(plural("en", 5, forms)).toBe("clips");
  });

  // The case the old hand-rolled helper existed for. Kept as a test rather
  // than as arithmetic: it now asserts that the runtime's ICU data is the full
  // build, since a small-icu Node would silently apply English rules to ru.
  it("selects Russian one/few/many, including the teens exception", () => {
    const forms = { one: "клип", few: "клипа", many: "клипов", other: "клипов" };
    expect(plural("ru", 1, forms)).toBe("клип");
    expect(plural("ru", 2, forms)).toBe("клипа");
    expect(plural("ru", 5, forms)).toBe("клипов");
    expect(plural("ru", 11, forms)).toBe("клипов");
    expect(plural("ru", 21, forms)).toBe("клип");
    expect(plural("ru", 22, forms)).toBe("клипа");
    expect(plural("ru", 111, forms)).toBe("клипов");
  });

  it("falls back to `other` for a category the caller did not write", () => {
    expect(plural("ru", 2, { other: "клипов" })).toBe("клипов");
    expect(plural("ru", 1.5, { one: "клип", other: "клипа" })).toBe("клипа");
  });
});
