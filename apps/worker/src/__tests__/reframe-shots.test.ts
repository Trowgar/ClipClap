import { describe, expect, it } from "vitest";
import { cutsToShots } from "../reframe/shots";

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
