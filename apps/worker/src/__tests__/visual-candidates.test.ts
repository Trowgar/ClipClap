import { describe, expect, it } from "vitest";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { nominateVisualCandidates } from "../analyze-v2/visual-candidates";
import type { SentenceNode } from "../analyze-v2/types";

const cfg = (overrides: Record<string, string> = {}) =>
  loadAnalyzeConfig({ ...overrides });

function nodesAt(times: number[], words: boolean[] = []): SentenceNode[] {
  return times.map((start, index) => ({
    index,
    start,
    end: start + 0.8,
    text: `sentence ${index}`,
    hasWords: words[index] ?? true,
    trailingStrength: 1,
    leadingStrength: index === 0 ? 1 : 0.8,
  }));
}

function denseNodes(count = 80): SentenceNode[] {
  return nodesAt(Array.from({ length: count }, (_, index) => index));
}

describe("nominateVisualCandidates", () => {
  it("degrades empty and malformed envelopes to numeric no-signal telemetry", () => {
    for (const envelope of [[], null, undefined, [0, Number.NaN, Infinity, "20"]]) {
      const result = nominateVisualCandidates(denseNodes(), envelope, cfg());
      expect(result.candidates).toEqual([]);
      expect(result.telemetry.envelopeLength).toBe(0);
      for (const value of Object.values(result.telemetry)) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("rejects finite values outside the physical motion domain without non-finite telemetry", () => {
    const result = nominateVisualCandidates(
      denseNodes(),
      [0, Number.MAX_VALUE, 1],
      cfg(),
    );
    expect(result.candidates).toEqual([]);
    expect(result.telemetry.envelopeLength).toBe(0);
    for (const value of Object.values(result.telemetry)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(() => JSON.stringify(value)).not.toThrow();
    }
  });

  it("rejects a static envelope and computes a robust threshold for an outlier", () => {
    expect(nominateVisualCandidates(denseNodes(), [4, 4, 4, 4], cfg()).candidates).toEqual([]);
    const result = nominateVisualCandidates(
      denseNodes(),
      [0, 1, 2, 20, 3, 2, 1],
      cfg(),
    );
    expect(result.telemetry.median).toBe(2);
    expect(result.telemetry.mad).toBe(1);
    expect(result.telemetry.rawPeakCount).toBe(1);
    expect(result.telemetry.clusteredPeakCount).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ type: "visual_action", windowIndex: 0 });
    expect(result.candidates[0].interest).toBeGreaterThanOrEqual(0.55);
    expect(result.candidates[0].interest).toBeLessThanOrEqual(0.95);
    expect(result.telemetry.mappedCandidates).toBe(1);
    expect(result.nominations).toEqual([expect.objectContaining({
      source: "motion",
      startNode: 0,
      endNode: 21,
      payoffNode: 3,
      peakSec: 3,
      peakValue: 20,
    })]);
  });

  it("keeps only local maxima and clusters maxima within twelve seconds", () => {
    const envelope = Array.from({ length: 60 }, () => 0);
    envelope[5] = 12;
    envelope[20] = 15;
    envelope[26] = 13;
    envelope[45] = 10;
    const result = nominateVisualCandidates(
      denseNodes(),
      envelope,
      cfg(),
    );
    expect(result.telemetry.rawPeakCount).toBe(4);
    expect(result.telemetry.clusteredPeakCount).toBe(3);
    expect(result.candidates.map((candidate) => candidate.payoffNode)).toEqual([5, 20, 45]);
  });

  it("collapses a wide equal plateau to one deterministic midpoint peak", () => {
    const envelope = Array.from({ length: 100 }, () => 0);
    for (let index = 5; index <= 25; index++) envelope[index] = 30;
    const result = nominateVisualCandidates(denseNodes(), envelope, cfg());
    expect(result.telemetry.rawPeakCount).toBe(1);
    expect(result.telemetry.clusteredPeakCount).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].payoffNode).toBe(15);
  });

  it("maps a peak to a bounded speech range and the nearest payoff node", () => {
    const result = nominateVisualCandidates(
      denseNodes(),
      [...Array.from({ length: 20 }, () => 0), 20, 0, 0],
      cfg({ VISUAL_RECALL_PRE_SEC: "8", VISUAL_RECALL_POST_SEC: "18" }),
    );
    expect(result.candidates[0]).toMatchObject({
      startNode: 12,
      endNode: 38,
      payoffNode: 20,
      windowIndex: 0,
    });
  });

  it("skips peaks without nearby reliable speech nodes", () => {
    const result = nominateVisualCandidates(
      nodesAt([0, 100, 104], [false, false, false]),
      [0, 0, 30],
      cfg({ VISUAL_RECALL_MAX_NODE_DISTANCE_SEC: "5" }),
    );
    expect(result.candidates).toEqual([]);
    expect(result.telemetry.mappedCandidates).toBe(0);
    expect(result.telemetry.rejectedNoSpeech).toBe(1);
  });

  it("chooses the nearest reliable payoff node inside the bounded range", () => {
    const envelope = Array.from({ length: 51 }, () => 0);
    envelope[50] = 30;
    const result = nominateVisualCandidates(
      nodesAt([41, 50, 65], [true, false, true]),
      envelope,
      cfg({
        VISUAL_RECALL_PRE_SEC: "8",
        VISUAL_RECALL_POST_SEC: "18",
        VISUAL_RECALL_MAX_NODE_DISTANCE_SEC: "20",
      }),
    );
    expect(result.candidates[0]).toMatchObject({ startNode: 1, endNode: 2, payoffNode: 2 });

    const noSpeech = nominateVisualCandidates(
      nodesAt([50], [false]),
      envelope,
      cfg({ VISUAL_RECALL_PRE_SEC: "8", VISUAL_RECALL_POST_SEC: "18" }),
    );
    expect(noSpeech.candidates).toEqual([]);
    expect(noSpeech.telemetry.rejectedNoSpeech).toBe(1);
  });

  it("rejects malformed positional node contracts before mapping", () => {
    const envelope = [0, 30, 0];
    const nonfinite = nodesAt([0, 2, 4]);
    nonfinite[1] = { ...nonfinite[1], start: Number.NaN };
    const mismatchedIndex = nodesAt([0, 2, 4]);
    mismatchedIndex[1] = { ...mismatchedIndex[1], index: 99 };
    const malformed = [
      nodesAt([0, 2, 1]),
      nonfinite,
      mismatchedIndex,
    ];
    for (const nodes of malformed) {
      expect(() => nominateVisualCandidates(nodes, envelope, cfg())).not.toThrow();
      expect(nominateVisualCandidates(nodes, envelope, cfg()).candidates).toEqual([]);
    }
  });

  it("enforces temporal diversity and the global candidate cap", () => {
    const envelope = Array.from({ length: 210 }, () => 0);
    for (const index of [2, 20, 70, 130, 190]) envelope[index] = 30;
    const result = nominateVisualCandidates(
      denseNodes(220),
      envelope,
      cfg({ VISUAL_RECALL_MAX_CANDIDATES: "3" }),
    );
    expect(result.candidates).toHaveLength(3);
    expect(result.telemetry.capped).toBeGreaterThan(0);
    expect(result.telemetry.diversityDropped).toBeGreaterThan(0);
    expect(result.telemetry.diversityDropped + result.telemetry.capped).toBe(
      result.telemetry.clusteredPeakCount - result.telemetry.mappedCandidates - result.telemetry.rejectedNoSpeech,
    );
  });
});
