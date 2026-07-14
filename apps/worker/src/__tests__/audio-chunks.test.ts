import { describe, expect, it } from "vitest";
import {
  parseSilences,
  planChunks,
  stitchTranscripts,
  type RawChunkTranscript,
} from "../processors/audio-chunks";

describe("parseSilences", () => {
  it("parses silencedetect stderr into intervals", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 1195.2",
      "[silencedetect @ 0x1] silence_end: 1196.1 | silence_duration: 0.9",
      "[silencedetect @ 0x1] silence_start: 2400.5",
      "[silencedetect @ 0x1] silence_end: 2401.0 | silence_duration: 0.5",
    ].join("\n");
    expect(parseSilences(stderr)).toEqual([
      { start: 1195.2, end: 1196.1 },
      { start: 2400.5, end: 2401.0 },
    ]);
  });
});

describe("planChunks", () => {
  it("returns a single full-range chunk for short audio", () => {
    expect(planChunks(1000, [], 1200, 15, 3)).toEqual([
      { start: 0, end: 1000, overlapStart: null },
    ]);
  });

  it("snaps chunk boundaries to nearby silence (no overlap needed)", () => {
    const silences = [{ start: 1195.2, end: 1196.1 }];
    const chunks = planChunks(3000, silences, 1200, 15, 3);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].end).toBeCloseTo(1195.65, 1); // silence midpoint
    expect(chunks[1].start).toBeCloseTo(1195.65, 1);
    expect(chunks[1].overlapStart).toBeNull();
  });

  it("falls back to a hard cut with overlap when no silence is near", () => {
    const chunks = planChunks(3000, [], 1200, 15, 3);
    expect(chunks[0].end).toBe(1200);
    expect(chunks[1].start).toBe(1197); // 1200 - 3s overlap
    expect(chunks[1].overlapStart).toBe(1197);
  });
});

describe("stitchTranscripts", () => {
  const chunk = (
    offset: number,
    words: Array<[string, number, number]>
  ): RawChunkTranscript => ({
    offsetSec: offset,
    text: words.map(([t]) => t).join(" "),
    segments: [
      {
        start: words[0][1],
        end: words[words.length - 1][2],
        text: words.map(([t]) => t).join(" "),
        words: words.map(([text, start, end]) => ({ text, start, end })),
      },
    ],
  });

  it("re-offsets chunk times into the source timeline", () => {
    const stitched = stitchTranscripts([
      chunk(0, [["a", 0, 1], ["b", 2, 3]]),
      chunk(100, [["c", 0, 1], ["d", 2, 3]]),
    ]);
    const allWords = stitched.segments.flatMap((s) => s.words ?? []);
    expect(allWords.map((w) => w.start)).toEqual([0, 2, 100, 102]);
  });

  it("dedups overlap by matching word sequences, keeping monotonic times", () => {
    // chunk 0 covers 0..12 and ends with "same words here"; chunk 1 starts at 9
    // and begins with the SAME words re-transcribed
    const stitched = stitchTranscripts([
      chunk(0, [["intro", 0, 1], ["same", 9, 10], ["words", 10, 11], ["here", 11, 12]]),
      chunk(9, [["same", 0, 1], ["words", 1, 2], ["here", 2, 3], ["tail", 4, 5]]),
    ]);
    const words = stitched.segments.flatMap((s) => s.words ?? []);
    const texts = words.map((w) => w.text);
    expect(texts.filter((t) => t === "same")).toHaveLength(1); // no duplicate
    for (let i = 1; i < words.length; i++) {
      expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start);
    }
    expect(texts).toContain("intro");
    expect(texts).toContain("tail");
  });

  it("computes coverage from missing ranges", () => {
    const stitched = stitchTranscripts(
      [chunk(0, [["a", 0, 1]]), chunk(200, [["b", 0, 1]])],
      { totalDurationSec: 300, missingRanges: [{ start: 100, end: 200, reason: "chunk_failed" }] }
    );
    expect(stitched.coverage).toBeCloseTo(2 / 3, 2);
    expect(stitched.missingRanges).toHaveLength(1);
  });
});
