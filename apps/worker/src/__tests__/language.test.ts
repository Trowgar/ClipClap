import { describe, expect, it } from "vitest";
import {
  whisperLanguageToIso,
  isoToLanguageName,
  dominantScript,
  scriptMismatch,
} from "../analyze-v2/language";

describe("whisperLanguageToIso", () => {
  it("maps known Whisper language names to ISO-639-1", () => {
    expect(whisperLanguageToIso("russian")).toBe("ru");
    expect(whisperLanguageToIso("English")).toBe("en");
    expect(whisperLanguageToIso("ukrainian")).toBe("uk");
  });
  it("returns null for unknown names (Job.language stays ISO-only)", () => {
    expect(whisperLanguageToIso("klingon")).toBeNull();
  });

  // These were the silent gap: Whisper emits them, the map did not have them,
  // so Job.language stayed null and ANALYZE lost the explicit output-language
  // instruction. Persian and Malay have real users today.
  it("maps the languages the shortlist used to drop", () => {
    expect(whisperLanguageToIso("persian")).toBe("fa");
    expect(whisperLanguageToIso("malay")).toBe("ms");
    expect(whisperLanguageToIso("urdu")).toBe("ur");
    expect(whisperLanguageToIso("tagalog")).toBe("tl");
    expect(whisperLanguageToIso("bengali")).toBe("bn");
    expect(whisperLanguageToIso("tamil")).toBe("ta");
  });

  it("resolves Whisper's alternative spellings", () => {
    expect(whisperLanguageToIso("castilian")).toBe("es");
    expect(whisperLanguageToIso("mandarin")).toBe("zh");
    expect(whisperLanguageToIso("burmese")).toBe("my");
    expect(whisperLanguageToIso("moldovan")).toBe("ro");
  });
});

describe("isoToLanguageName", () => {
  it("round-trips for prompt interpolation", () => {
    expect(isoToLanguageName("ru")).toBe("Russian");
    expect(isoToLanguageName("en")).toBe("English");
    expect(isoToLanguageName("xx")).toBe("the transcript language");
    expect(isoToLanguageName("fa")).toBe("Persian");
    expect(isoToLanguageName("id")).toBe("Indonesian");
  });

  // An alias must never win the reverse lookup: the prompt should say
  // "Spanish", not "Castilian", and "Chinese", not "Mandarin".
  it("names a language by its canonical name, never an alias", () => {
    expect(isoToLanguageName("es")).toBe("Spanish");
    expect(isoToLanguageName("zh")).toBe("Chinese");
    expect(isoToLanguageName("my")).toBe("Myanmar");
  });

  // Every name in the map must survive the round trip, or some language is
  // detected but then described to the model as "the transcript language".
  it("round-trips every mapped language", () => {
    for (const name of ["persian", "malay", "urdu", "tagalog", "swahili", "hawaiian"]) {
      const iso = whisperLanguageToIso(name);
      expect(iso).not.toBeNull();
      expect(isoToLanguageName(iso!).toLowerCase()).toBe(name);
    }
  });
});

describe("script checks", () => {
  it("detects dominant script", () => {
    expect(dominantScript("Привет как дела")).toBe("cyrillic");
    expect(dominantScript("Hello there")).toBe("latin");
    expect(dominantScript("123 !!!")).toBe("none");
  });
  it("flags a Latin title on a Cyrillic clip and passes matching pairs", () => {
    expect(scriptMismatch("He was shocked", "он был в шоке от этого")).toBe(true);
    expect(scriptMismatch("Он был в шоке", "он был в шоке от этого")).toBe(false);
    expect(scriptMismatch("12345", "он был в шоке")).toBe(false); // no detectable script -> no gate
  });
});
