import { describe, it, expect } from "vitest";
import { sectionArg, toSeconds } from "../scripts/corpus-fetch";

describe("toSeconds", () => {
  it("parses HH:MM:SS", () => {
    expect(toSeconds("01:02:03")).toBe(3723);
  });
  it("parses MM:SS", () => {
    expect(toSeconds("02:30")).toBe(150);
  });
  it("parses plain seconds", () => {
    expect(toSeconds("90")).toBe(90);
  });
  it("throws on nonsense rather than yielding NaN", () => {
    expect(() => toSeconds("banana")).toThrow("unparseable time");
  });
});

describe("sectionArg", () => {
  const item = (inAt: string, len: number) => ({
    id: "x", url: "u", in: inAt, len, tests: "t",
  });

  it("emits an ABSOLUTE end, not a duration", () => {
    // yt-dlp rejects "*00:00:00-+90" outright. The end is absolute, so len
    // must be added to in - and at a non-zero start the two forms differ,
    // which is where the original bug would have silently produced a short clip.
    expect(sectionArg(item("00:02:00", 90))).toBe("*120-210");
  });

  it("is the same as a bare duration only when the start is zero", () => {
    expect(sectionArg(item("00:00:00", 90))).toBe("*0-90");
  });
});
