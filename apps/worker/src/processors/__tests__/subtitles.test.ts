import { describe, it, expect } from "vitest";
import { generateAss } from "../subtitles";
import type { WhisperSegment } from "@clipfast/shared";

const segments: WhisperSegment[] = [
  { start: 10.0, end: 13.5, text: "Hello everyone" },
  { start: 13.5, end: 18.0, text: "Welcome to the stream" },
  { start: 18.0, end: 25.0, text: "Today we are going to talk about AI" },
  { start: 50.0, end: 55.0, text: "This is outside the clip range" },
];

describe("generateAss", () => {
  it("generates valid ASS with tiktok preset", () => {
    const ass = generateAss(segments, 10.0, 25.0, "tiktok");

    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("Style: Default,Arial,18");
    expect(ass).toContain("Bold,-1");
  });

  it("adjusts segment times relative to clip start", () => {
    const ass = generateAss(segments, 10.0, 25.0, "tiktok");

    // "Hello everyone" starts at 10.0 in source, clip starts at 10.0
    // so relative start = 0.0
    expect(ass).toContain("0:00:00.00,0:00:03.50");
    // "Welcome to the stream" starts at 13.5 - 10.0 = 3.5
    expect(ass).toContain("0:00:03.50,0:00:08.00");
  });

  it("filters out segments outside clip range", () => {
    const ass = generateAss(segments, 10.0, 25.0, "tiktok");

    expect(ass).not.toContain("outside the clip range");
  });

  it("applies bold preset style", () => {
    const ass = generateAss(segments, 10.0, 25.0, "bold");

    expect(ass).toContain("Impact");
    expect(ass).toContain("&H0000FFFF"); // yellow
  });

  it("applies minimal preset style", () => {
    const ass = generateAss(segments, 10.0, 25.0, "minimal");

    expect(ass).toContain("Bold,0"); // not bold
    expect(ass).toContain(",14,"); // smaller font
  });
});
