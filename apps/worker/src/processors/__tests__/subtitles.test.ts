import { describe, it, expect } from "vitest";
import { generateAss, segmentsToCues, sliceCues } from "../subtitles";
import type { SubtitleCue, WhisperSegment } from "@clipfast/shared";

const segments: WhisperSegment[] = [
  { start: 10.0, end: 13.5, text: "Hello everyone" },
  {
    start: 13.5,
    end: 18.0,
    text: "Welcome to the stream",
    words: [
      { text: "Welcome", start: 13.5, end: 14.2 },
      { text: "to", start: 14.2, end: 14.4 },
      { text: "the", start: 14.4, end: 14.6 },
      { text: "stream", start: 14.6, end: 15.1 },
    ],
  },
  { start: 18.0, end: 25.0, text: "Today we are going to talk about AI" },
  { start: 50.0, end: 55.0, text: "This is outside the clip range" },
];

describe("segmentsToCues", () => {
  it("filters to the clip window and shifts times to clip-relative", () => {
    const cues = segmentsToCues(segments, 10.0, 25.0);
    // seg2 has 4 words -> two 3-word-max chunks, so 4 cues total
    expect(cues).toHaveLength(4);
    expect(cues[0]).toMatchObject({ start: 0, end: 3.5, text: "Hello everyone" });
    expect(cues[1].start).toBeCloseTo(3.5);
    expect(cues[1].end).toBeCloseTo(4.6); // held until the next chunk starts
    expect(cues[2].end).toBeCloseTo(8.0); // last chunk runs to segment end
  });

  it("shifts word timings along with the cue and assigns ids", () => {
    const cues = segmentsToCues(segments, 10.0, 25.0);
    expect(cues[1].words?.[0]?.text).toBe("Welcome");
    expect(cues[1].words?.[0]?.start).toBeCloseTo(3.5);
    expect(cues[1].words?.[0]?.end).toBeCloseTo(4.2);
    expect(new Set(cues.map((c) => c.id)).size).toBe(4);
  });

  it("chunks word-timed segments into short viral-style cues", () => {
    const long: WhisperSegment[] = [
      {
        start: 0,
        end: 6,
        text: "one two three four five six seven eight",
        words: [
          { text: "one", start: 0, end: 0.5 },
          { text: "two", start: 0.5, end: 1 },
          { text: "three", start: 1, end: 1.5 },
          { text: "four", start: 1.5, end: 2 },
          { text: "five", start: 2, end: 2.5 },
          { text: "six", start: 2.5, end: 3 },
          { text: "seven", start: 3, end: 3.5 },
          { text: "eight", start: 3.5, end: 6 },
        ],
      },
    ];
    const cues = segmentsToCues(long, 0, 6);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0].text).toBe("one two three");
    expect(cues[0].start).toBe(0);
    // chunk stays on screen until the next one starts (no flicker gaps)
    expect(cues[0].end).toBe(cues[1].start);
    expect(cues.at(-1)!.end).toBe(6);
    expect(cues[0].words).toHaveLength(3);
  });

  it("keeps segments without words as a single cue", () => {
    const cues = segmentsToCues(segments, 10.0, 25.0);
    expect(cues[0].text).toBe("Hello everyone");
  });

  it("clamps cues that straddle the clip edges", () => {
    const cues = segmentsToCues(segments, 12.0, 16.0);
    expect(cues[0].start).toBe(0);
    expect(cues.at(-1)!.end).toBeCloseTo(4.0);
  });
});

describe("sliceCues", () => {
  const cues: SubtitleCue[] = [
    { id: "a", start: 0, end: 3, text: "one" },
    {
      id: "b",
      start: 3,
      end: 6,
      text: "two words",
      words: [
        { text: "two", start: 3, end: 4 },
        { text: "words", start: 4, end: 5.5 },
      ],
    },
    { id: "c", start: 6, end: 9, text: "three" },
  ];

  it("re-windows clip-relative cues to a sub-range", () => {
    const out = sliceCues(cues, 2, 7);
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(out[0]).toMatchObject({ start: 0, end: 1 });
    expect(out[1]).toMatchObject({ start: 1, end: 4 });
    expect(out[1].words?.[1]).toEqual({ text: "words", start: 2, end: 3.5 });
    expect(out[2]).toMatchObject({ start: 4, end: 5 });
  });

  it("drops cues fully outside the range", () => {
    const out = sliceCues(cues, 3.2, 5.8);
    expect(out.map((c) => c.id)).toEqual(["b"]);
  });
});

describe("generateAss", () => {
  const cues = segmentsToCues(segments, 10.0, 25.0);

  it("emits the single default style (Montserrat Bold, white on black outline)", () => {
    const ass = generateAss(cues);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    const style = ass.split("\n").find((l) => l.startsWith("Style: Default,"));
    expect(style).toBeDefined();
    const fields = style!.replace("Style: ", "").split(",");
    expect(fields[1]).toBe("Montserrat");
    expect(Number(fields[2])).toBeGreaterThanOrEqual(96); // CC-size on 1080x1920
    expect(fields[3]).toBe("&H00FFFFFF"); // white primary
    expect(fields[7]).toBe("-1"); // bold
    expect(fields[21]).toBe("160"); // marginV
  });

  it("renders cue times relative to the clip", () => {
    const ass = generateAss(cues);
    expect(ass).toContain("0:00:00.00,0:00:03.50");
    expect(ass).not.toContain("outside the clip range");
  });

  it("emits karaoke word timing when words are present", () => {
    const ass = generateAss(cues);
    const karaokeLine = ass
      .split("\n")
      .find((l) => l.startsWith("Dialogue:") && l.includes("Welcome"));
    expect(karaokeLine).toContain("\\k70}Welcome");
    expect(karaokeLine).toContain("{\\1c&H00FFFF&}"); // active-word highlight colour
  });

  it("falls back to plain text when a cue has no words", () => {
    const ass = generateAss(cues);
    const plain = ass
      .split("\n")
      .find((l) => l.startsWith("Dialogue:") && l.includes("Hello everyone"));
    expect(plain).not.toContain("\\k");
  });

  it("escapes newlines and strips brace characters", () => {
    const ass = generateAss([
      { id: "x", start: 0, end: 1, text: "line1\nline2 {evil}" },
    ]);
    expect(ass).toContain("line1\\Nline2 (evil)");
  });
});
