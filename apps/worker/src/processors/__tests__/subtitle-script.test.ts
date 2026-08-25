import { describe, expect, it } from "vitest";
import {
  ARABIC_FONT_NAME,
  DEFAULT_FONT_NAME,
  DEVANAGARI_FONT_NAME,
  JP_FONT_NAME,
  KR_FONT_NAME,
  SC_FONT_NAME,
  fontForLanguage,
  isCjkLanguage,
} from "../subtitle-script";

describe("fontForLanguage", () => {
  it("uses the Arabic face for every language written in Arabic script", () => {
    for (const code of ["ar", "fa", "ur", "ps"]) {
      expect(fontForLanguage(code)).toBe(ARABIC_FONT_NAME);
    }
  });

  it("uses the Devanagari face for Hindi, Marathi, Nepali and Sanskrit", () => {
    for (const code of ["hi", "mr", "ne", "sa"]) {
      expect(fontForLanguage(code)).toBe(DEVANAGARI_FONT_NAME);
    }
  });

  it("uses the Japanese face for ja", () => {
    expect(fontForLanguage("ja")).toBe(JP_FONT_NAME);
  });

  it("uses the Korean face for ko", () => {
    expect(fontForLanguage("ko")).toBe(KR_FONT_NAME);
  });

  it("uses the (Simplified) Chinese face for zh and its macrolanguage codes", () => {
    for (const code of ["zh", "yue", "cmn"]) {
      expect(fontForLanguage(code)).toBe(SC_FONT_NAME);
    }
  });

  // Recorded v1 compromise (spec 2026-08-25-cjk-subtitles.md): Traditional
  // readers get Simplified glyph forms rather than no CJK face at all. Only
  // the PRIMARY subtag is ever consulted, so a script/region suffix on "zh"
  // does not change the outcome.
  it("routes Traditional-Chinese-tagged codes to the SC face too", () => {
    for (const code of ["zh-Hant", "zh-TW", "zh-HK"]) {
      expect(fontForLanguage(code)).toBe(SC_FONT_NAME);
    }
  });

  it("uses the default face for everything else", () => {
    for (const code of ["en", "ru", "uk", "es", "pt", "id", "km", "he"]) {
      expect(fontForLanguage(code)).toBe(DEFAULT_FONT_NAME);
    }
  });

  // Job.language is nullable and Whisper has returned region tags and mixed
  // case. An unknown value must land on today's behaviour, never throw.
  it("falls back to the default face for missing or unknown values", () => {
    expect(fontForLanguage(undefined)).toBe(DEFAULT_FONT_NAME);
    expect(fontForLanguage(null)).toBe(DEFAULT_FONT_NAME);
    expect(fontForLanguage("")).toBe(DEFAULT_FONT_NAME);
    expect(fontForLanguage("zzz")).toBe(DEFAULT_FONT_NAME);
  });

  it("normalises case and region subtags", () => {
    expect(fontForLanguage("AR")).toBe(ARABIC_FONT_NAME);
    expect(fontForLanguage("ar-SA")).toBe(ARABIC_FONT_NAME);
    expect(fontForLanguage("fa_IR")).toBe(ARABIC_FONT_NAME);
    expect(fontForLanguage("  ar  ")).toBe(ARABIC_FONT_NAME);
    expect(fontForLanguage("JA")).toBe(JP_FONT_NAME);
    expect(fontForLanguage("zh-CN")).toBe(SC_FONT_NAME);
    expect(fontForLanguage("ko_KR")).toBe(KR_FONT_NAME);
    expect(fontForLanguage("  hi  ")).toBe(DEVANAGARI_FONT_NAME);
  });
});

describe("isCjkLanguage", () => {
  it("is true for ja, every Chinese code, and ko", () => {
    for (const code of ["ja", "zh", "zh-Hant", "zh-TW", "yue", "cmn", "ko", "KO"]) {
      expect(isCjkLanguage(code)).toBe(true);
    }
  });

  // Devanagari gets its own face but is NOT CJK - its words are
  // space-delimited and multi-character, so it must keep the Latin chunking
  // params (subtitles.ts). Arabic and the Latin/Cyrillic default are not CJK
  // either.
  it("is false for Devanagari, Arabic, Latin/Cyrillic and unknown values", () => {
    for (const code of ["hi", "mr", "ne", "sa", "ar", "en", "ru", undefined, null, ""]) {
      expect(isCjkLanguage(code)).toBe(false);
    }
  });
});
