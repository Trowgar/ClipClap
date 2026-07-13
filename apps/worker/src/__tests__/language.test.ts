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
});

describe("isoToLanguageName", () => {
  it("round-trips for prompt interpolation", () => {
    expect(isoToLanguageName("ru")).toBe("Russian");
    expect(isoToLanguageName("en")).toBe("English");
    expect(isoToLanguageName("xx")).toBe("the transcript language");
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
