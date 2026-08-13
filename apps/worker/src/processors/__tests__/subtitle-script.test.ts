import { describe, expect, it } from "vitest";
import {
  ARABIC_FONT_NAME,
  DEFAULT_FONT_NAME,
  DEFAULT_MAX_CHUNK_CHARS,
  fontForLanguage,
  maxChunkCharsForLanguage,
} from "../subtitle-script";

describe("fontForLanguage", () => {
  it("uses the Arabic face for every language written in Arabic script", () => {
    for (const code of ["ar", "fa", "ur", "ps"]) {
      expect(fontForLanguage(code)).toBe(ARABIC_FONT_NAME);
    }
  });

  it("uses the default face for everything else", () => {
    for (const code of ["en", "ru", "uk", "es", "pt", "id", "hi", "km", "he"]) {
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
  });
});

describe("maxChunkCharsForLanguage", () => {
  it("keeps today's budget for non-Arabic languages", () => {
    expect(maxChunkCharsForLanguage("en")).toBe(DEFAULT_MAX_CHUNK_CHARS);
    expect(maxChunkCharsForLanguage("ru")).toBe(DEFAULT_MAX_CHUNK_CHARS);
    expect(maxChunkCharsForLanguage(null)).toBe(DEFAULT_MAX_CHUNK_CHARS);
  });

  // The number itself is set in Task 7 from a measurement. What this pins is
  // that Arabic gets a LARGER budget than the Cyrillic-calibrated default -
  // Arabic runs about half the width per character, so reusing 18 splits
  // phrases that would fit.
  it("gives Arabic script a wider budget than the default", () => {
    expect(maxChunkCharsForLanguage("ar")).toBeGreaterThan(DEFAULT_MAX_CHUNK_CHARS);
    expect(maxChunkCharsForLanguage("fa")).toBe(maxChunkCharsForLanguage("ar"));
  });
});
