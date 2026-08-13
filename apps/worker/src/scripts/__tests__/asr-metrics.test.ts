// apps/worker/src/scripts/__tests__/asr-metrics.test.ts
import { describe, expect, it } from "vitest";
import { loadTranscript } from "../asr-metrics";

const storedShape = {
  text: "раз два три четыре",
  language: "ru",
  languageRaw: "russian",
  segments: [
    { start: 0, end: 2, text: "раз два", words: [
      { text: "раз", start: 0, end: 1 }, { text: "два", start: 1, end: 2 } ] },
    { start: 2, end: 4, text: "три четыре" }, // opaque: no words
  ],
};

const rawShape = {
  text: "раз два три четыре",
  language: "Russian",
  segments: [
    { start: 0, end: 2, text: " раз два" },
    { start: 2, end: 4, text: "три четыре " },
  ],
  words: [
    { word: "раз", start: 0, end: 1 },
    { word: "два", start: 1.5, end: 2 },
    { word: "три", start: 1.9, end: 3 }, // starts before previous end: violation
    { word: "четыре", start: 3, end: 4 },
  ],
};

describe("loadTranscript", () => {
  it("tokenizes from segment text, not from words, so opaque segments still count", () => {
    expect(loadTranscript(storedShape).tokens).toEqual(["раз", "два", "три", "четыре"]);
    expect(loadTranscript(rawShape).tokens).toEqual(["раз", "два", "три", "четыре"]);
  });

  it("sums covered seconds over word-bearing segments only (the speechSec analogue)", () => {
    expect(loadTranscript(storedShape).coveredSec).toBe(2); // second segment is opaque
    expect(loadTranscript(rawShape).coveredSec).toBe(4);    // top-level words reach both
  });

  it("reports the total span", () => {
    expect(loadTranscript(storedShape).totalSpanSec).toBe(4);
  });

  it("counts word-timing monotonicity violations before any clamp", () => {
    expect(loadTranscript(rawShape).monotonicityViolations).toBe(1);
    expect(loadTranscript(storedShape).monotonicityViolations).toBe(0);
  });

  it("prefers the raw Whisper language name over the stored ISO code", () => {
    expect(loadTranscript(storedShape).languageRaw).toBe("russian");
    expect(loadTranscript(rawShape).languageRaw).toBe("Russian");
  });
});
