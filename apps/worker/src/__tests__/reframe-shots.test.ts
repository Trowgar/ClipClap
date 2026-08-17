import { describe, expect, it } from "vitest";
import { classifyCuts, cutsToShots, parseSceneScores, CANDIDATE_FLOOR } from "../reframe/shots";

describe("cutsToShots", () => {
  it("splits the clip at scene cuts", () => {
    expect(cutsToShots([12.4, 31.0], 57.5, 1.0)).toEqual([
      { start: 0, end: 12.4 },
      { start: 12.4, end: 31.0 },
      { start: 31.0, end: 57.5 },
    ]);
  });

  it("returns a single shot when there are no cuts", () => {
    expect(cutsToShots([], 30, 1.0)).toEqual([{ start: 0, end: 30 }]);
  });

  it("merges micro-shots forward into the next segment", () => {
    // cuts at 5.0 and 5.4: the 0.4s middle segment folds into [5.0, 9.0]
    expect(cutsToShots([5.0, 5.4], 9.0, 1.0)).toEqual([
      { start: 0, end: 5.0 },
      { start: 5.0, end: 9.0 },
    ]);
  });

  it("merges a too-short tail backward into the last shot", () => {
    expect(cutsToShots([5.0], 5.6, 1.0)).toEqual([{ start: 0, end: 5.6 }]);
  });

  it("ignores cuts outside (0, duration) and duplicates", () => {
    expect(cutsToShots([0, 5, 5, 60], 30, 1.0)).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 30 },
    ]);
  });

  it("treats a clip shorter than minShotSec as one shot", () => {
    expect(cutsToShots([], 0.8, 1.0)).toEqual([{ start: 0, end: 0.8 }]);
  });

  it("returns empty for a non-positive duration", () => {
    expect(cutsToShots([], 0, 1.0)).toEqual([]);
  });
});

/** ffmpeg stderr as `metadata=print` writes it: a frame line, then the score line. */
const scoredStderr = (rows: Array<[number, number]>) =>
  rows
    .map(
      ([t, s]) =>
        `[Parsed_metadata_2 @ 0x1] frame:0    pts:1   pts_time:${t}\n` +
        `[Parsed_metadata_2 @ 0x1] lavfi.scene_score=${s}\n`
    )
    .join("");

describe("parseSceneScores", () => {
  it("pairs every selected frame with its scene score", () => {
    expect(parseSceneScores(scoredStderr([[4.95, 0.560405], [14.35, 0.471656]]))).toEqual([
      { t: 4.95, score: 0.560405 },
      { t: 14.35, score: 0.471656 },
    ]);
  });

  it("is not fooled by ffmpeg progress noise glued onto a frame line", () => {
    // Progress lines end in \r, so a metadata line can share a physical line
    // with "frame=  1 fps=..." - seen verbatim on the corpus.
    const raw =
      "frame=    1 fps=0.0 q=-0.0 size=N/A time=00:00:05.00 speed=  10x    " +
      "[Parsed_metadata_2 @ 0x1] frame:1    pts:183680  pts_time:14.35\n" +
      "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.471656\n";
    expect(parseSceneScores(raw)).toEqual([{ t: 14.35, score: 0.471656 }]);
  });

  it("returns nothing for an empty pass", () => {
    expect(parseSceneScores("")).toEqual([]);
  });

  it("fails the pass when a selected frame has no score", () => {
    // Without the score the frame cannot be classified as cut or candidate,
    // and a wrong cut list is worse than the legacy fallback (spec 2a).
    const raw =
      "[Parsed_metadata_2 @ 0x1] frame:0 pts:1 pts_time:10.0\n" +
      "[Parsed_metadata_2 @ 0x1] frame:1 pts:2 pts_time:20.0\n" +
      "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.5\n";
    expect(() => parseSceneScores(raw)).toThrow(/scdet_score_missing/);
    expect(() => parseSceneScores("[x] frame:0 pts:1 pts_time:10.0\n")).toThrow(
      /scdet_score_missing/
    );
  });

  it("fails the pass when a score arrives with no preceding frame time", () => {
    expect(() => parseSceneScores("[x] lavfi.scene_score=0.5\n")).toThrow(
      /scdet_score_missing/
    );
  });
});

describe("classifyCuts", () => {
  const scored = [
    { t: 4.95, score: 0.56 },
    { t: 18.27, score: 0.292 },
    { t: 20.71, score: 0.298 },
    { t: 23.31, score: 0.41 },
    { t: 42.59, score: 0.12 },
  ];

  it("keeps cuts at the configured threshold and reports the band below as candidates", () => {
    expect(classifyCuts(scored, 96, 0.3)).toEqual({
      cuts: [4.95, 23.31],
      candidates: [
        { t: 18.27, score: 0.292 },
        { t: 20.71, score: 0.298 },
      ],
    });
  });

  it("promotes the band to cuts on a long zero-cut window, leaving no candidates", () => {
    const noCut = scored.filter((s) => s.score < 0.3);
    expect(classifyCuts(noCut, 40, 0.3)).toEqual({
      cuts: [18.27, 20.71],
      candidates: [],
    });
  });

  it("does not lower the bar for a window shorter than the long-take bar", () => {
    const noCut = scored.filter((s) => s.score < 0.3);
    expect(classifyCuts(noCut, 14.9, 0.3)).toEqual({
      cuts: [],
      candidates: [
        { t: 18.27, score: 0.292 },
        { t: 20.71, score: 0.298 },
      ],
    });
  });

  it("halves a high threshold on the retry but never goes under the floor", () => {
    // 0.4 halves to 0.2 (clear of the floor): 0.25 is a cut, 0.16 is not.
    expect(classifyCuts([{ t: 10, score: 0.25 }, { t: 30, score: 0.16 }], 40, 0.4)).toEqual({
      cuts: [10],
      candidates: [{ t: 30, score: 0.16 }],
    });
    // 0.2 would halve to 0.1; the floor holds at 0.15, so 0.16 IS a cut...
    expect(classifyCuts([{ t: 10, score: 0.16 }], 40, 0.2)).toEqual({
      cuts: [10],
      candidates: [],
    });
    // ...and 0.12 is neither a cut nor a candidate. Without the floor the retry
    // would sit at 0.1 and make it a cut - this line is what catches that.
    expect(classifyCuts([{ t: 10, score: 0.12 }], 40, 0.2)).toEqual({
      cuts: [],
      candidates: [],
    });
  });

  it("never reports a candidate below the floor", () => {
    expect(classifyCuts([{ t: 5, score: CANDIDATE_FLOOR - 0.01 }], 10, 0.3).candidates).toEqual([]);
    expect(classifyCuts([{ t: 5, score: CANDIDATE_FLOOR }], 10, 0.3).candidates).toEqual([
      { t: 5, score: CANDIDATE_FLOOR },
    ]);
  });

  it("treats a score exactly at the threshold as a cut, like ffmpeg's gte", () => {
    expect(classifyCuts([{ t: 10, score: 0.3 }], 40, 0.3)).toEqual({
      cuts: [10],
      candidates: [],
    });
  });
});
