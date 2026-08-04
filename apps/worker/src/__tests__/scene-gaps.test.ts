import { describe, expect, it } from "vitest";
import { sceneEndAfter } from "../analyze-v2/scene-gaps";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({ SCENE_GAP_SEC: "8" });

/** Nodes 2s long, back to back, with an optional silent hole before one of them. */
function nodesWithHole(count: number, holeBefore?: number, holeSec = 12): SentenceNode[] {
  const out: SentenceNode[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    if (i === holeBefore) t += holeSec;
    out.push({
      index: i,
      start: t,
      end: t + 2,
      text: `line ${i}`,
      hasWords: true,
      trailingStrength: 1,
      leadingStrength: 1,
    });
    t += 2;
  }
  return out;
}

describe("sceneEndAfter", () => {
  it("returns the last node before the next hole", () => {
    expect(sceneEndAfter(nodesWithHole(10, 6), 2, cfg)).toBe(5);
  });

  it("returns the last node when no hole follows", () => {
    expect(sceneEndAfter(nodesWithHole(10), 2, cfg)).toBe(9);
  });

  it("ignores a hole that is already behind the start index", () => {
    expect(sceneEndAfter(nodesWithHole(10, 3), 5, cfg)).toBe(9);
  });

  it("does not fire on a gap below the threshold", () => {
    expect(sceneEndAfter(nodesWithHole(10, 6, 4), 2, cfg)).toBe(9);
  });
});

describe("the sceneGapSec default", () => {
  // Not a taste knob: measured on all four eval fixtures 2026-08-04. The two
  // podcasts have no cuts and their largest node-to-node hole is 4.26s, so 4
  // gives each of them a boundary and 5 is the smallest integer that leaves
  // both at zero. Anyone moving this should re-measure, not re-guess.
  it("is the measured 5s, overridable for a job that needs it", () => {
    expect(loadAnalyzeConfig({}).sceneGapSec).toBe(5);
    expect(loadAnalyzeConfig({ SCENE_GAP_SEC: "12" }).sceneGapSec).toBe(12);
  });
});
