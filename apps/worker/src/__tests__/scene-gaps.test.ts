import { describe, expect, it } from "vitest";
import { sceneEndAfter } from "../analyze-v2/scene-gaps";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({ SCENE_GAP_SEC: "8" });

/** Back-to-back nodes `nodeSec` long, with an optional silent hole before one
 *  of them. nodeSec is a parameter because a fixed node length cannot tell the
 *  hole apart from the node's own period - the two only diverge when they
 *  differ, which is what "measures the hole, not the node period" turns on. */
function nodesWithHole(
  count: number,
  holeBefore?: number,
  holeSec = 12,
  nodeSec = 2
): SentenceNode[] {
  const out: SentenceNode[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    if (i === holeBefore) t += holeSec;
    out.push({
      index: i,
      start: t,
      end: t + nodeSec,
      text: `line ${i}`,
      hasWords: true,
      trailingStrength: 1,
      leadingStrength: 1,
    });
    t += nodeSec;
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

  it("fires on a hole exactly equal to the threshold", () => {
    expect(sceneEndAfter(nodesWithHole(10, 6, 8), 2, cfg)).toBe(5);
  });

  // The result is a CEILING. Returning anything below fromIdx would shorten
  // the clip that asked, which is the one thing a guard against over-extension
  // must never do.
  it("never returns an index before fromIdx when the hole is immediately behind it", () => {
    expect(sceneEndAfter(nodesWithHole(10, 6), 6, cfg)).toBe(9);
  });

  it("returns fromIdx itself when the very next node is across a cut", () => {
    expect(sceneEndAfter(nodesWithHole(10, 6), 5, cfg)).toBe(5);
  });

  it("honours cfg.sceneGapSec rather than the built-in default", () => {
    const n = nodesWithHole(10, 6, 6);
    expect(sceneEndAfter(n, 2, cfg)).toBe(9);
    expect(sceneEndAfter(n, 2, loadAnalyzeConfig({}))).toBe(5);
  });

  it("measures the hole, not the node period: a long node is not a cut", () => {
    expect(sceneEndAfter(nodesWithHole(10, undefined, 0, 12), 2, cfg)).toBe(9);
  });

  // The partial-rail property, pinned. A cut the audience laughs through gets a
  // segment from Whisper, so it arrives as an opaque NODE and leaves no silence
  // behind - and this guard is deliberately blind to it. Measuring word-bearing
  // nodes only would "fix" this case and break the whole metric: it reports a
  // 44.4s maximum on podcast fixtures that contain no cuts at all.
  it("counts an opaque node as scene material, so a laugh bridges the hole", () => {
    const n = nodesWithHole(10, 6, 12);
    n[6] = { ...n[6], hasWords: false, start: n[5].end };
    expect(sceneEndAfter(n, 2, cfg)).toBe(9);
  });
});

describe("the sceneGapSec default", () => {
  // Not a taste knob: 5 is the smallest integer that leaves both podcast
  // fixtures at zero boundaries. The derivation lives in analyze-v2/scene-gaps.ts;
  // anyone moving this should re-measure there, not re-guess here.
  it("is the measured 5s, overridable for a job that needs it", () => {
    expect(loadAnalyzeConfig({}).sceneGapSec).toBe(5);
    expect(loadAnalyzeConfig({ SCENE_GAP_SEC: "12" }).sceneGapSec).toBe(12);
  });
});
