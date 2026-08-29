import { describe, expect, it } from "vitest";
import {
  applyPostBoundaryHookGate,
  largestPreHookGap,
  type PostBoundaryHookGateOptions,
} from "../analyze-v2/post-boundary-hook-gate";
import type { SentenceNode, SnappedClip } from "../analyze-v2/types";

function clip(
  id = "c0",
  values: Partial<Pick<SnappedClip, "startSec" | "endSec" | "hookStartSec">> = {},
  verdict: Partial<SnappedClip["verdict"]> = {},
): SnappedClip {
  return {
    startSec: 0,
    endSec: 10,
    hookStartSec: 2,
    verdict: { id, score: 0.7, kind: "story", language: "en", ...verdict },
    ...values,
  } as SnappedClip;
}

function nodes(ranges: Array<[number, number]>): SentenceNode[] {
  return ranges.map(([start, end], index) => ({
    index,
    start,
    end,
    text: `node-${index}`,
    hasWords: true,
    trailingStrength: 1,
    leadingStrength: 1,
  }));
}

function options(
  mode: PostBoundaryHookGateOptions["mode"],
  limits: { maxDelaySec?: number; maxPreHookGapSec?: number } = {},
): PostBoundaryHookGateOptions {
  return {
    mode,
    scoreThreshold: 0.6,
    targetMinSec: 8,
    maxSec: 90,
    ...limits,
  };
}

describe("post-boundary hook gate", () => {
  it("drops in enforce when hook delay exceeds the strict limit", () => {
    const result = applyPostBoundaryHookGate(
      [clip("late", { startSec: 10, hookStartSec: 12.01 })],
      nodes([[10, 12.01]]),
      options("enforce", { maxDelaySec: 2, maxPreHookGapSec: 9 }),
    );

    expect(result.clips).toEqual([]);
    expect(result.drops).toEqual([{ id: "late", reasons: ["hook_delay"] }]);
  });

  it("merges adjacent sentence coverage and measures the largest half-open gap", () => {
    expect(largestPreHookGap(nodes([[0, 1], [1, 2], [4, 5]]), 0, 6)).toBe(2);
  });

  it("observes raw metrics without pass or drop decisions", () => {
    const input = [clip()];
    const result = applyPostBoundaryHookGate(input, nodes([[0, 1]]), options("observe"));

    expect(result.clips).toBe(input);
    expect(result.telemetry).toMatchObject({ evaluated: 1, notEvaluable: 0 });
    expect(result.telemetry).not.toHaveProperty("passed");
    expect(result.telemetry).not.toHaveProperty("wouldDrop");
    expect(result.telemetry).not.toHaveProperty("dropped");
    expect(result.telemetry).not.toHaveProperty("reasons");
  });

  it("returns the unchanged input and no telemetry when off", () => {
    const input = [clip()];
    const result = applyPostBoundaryHookGate(input, nodes([]), options("off"));

    expect(result).toEqual({ clips: input, drops: [] });
    expect(result.clips).toBe(input);
  });

  it("uses strict comparisons at both limits", () => {
    const exact = clip("exact", { hookStartSec: 2 });
    const overDelay = clip("over-delay", { hookStartSec: 2.01 });
    const exactGap = clip("exact-gap", { startSec: 10, hookStartSec: 12 });
    const overGap = clip("over-gap", { startSec: 20, hookStartSec: 22 });
    const result = applyPostBoundaryHookGate(
      [exact, overDelay, exactGap, overGap],
      nodes([[0, 2], [10, 12], [20, 20.99]]),
      options("enforce", { maxDelaySec: 2, maxPreHookGapSec: 1 }),
    );

    expect(result.clips).toEqual([exact, exactGap]);
    expect(result.drops).toEqual([
      { id: "over-delay", reasons: ["hook_delay"] },
      { id: "over-gap", reasons: ["pre_hook_gap"] },
    ]);
  });

  it("measures leading, interior, trailing, absent, and empty-interval gaps", () => {
    expect(largestPreHookGap(nodes([[1, 2], [3, 4]]), 0, 5)).toBe(1);
    expect(largestPreHookGap(nodes([]), 3, 8)).toBe(5);
    expect(largestPreHookGap(nodes([[0, 1]]), 4, 4)).toBe(0);
  });

  it("ignores invalid individual nodes but marks unavailable arrays not evaluable", () => {
    const invalid = [
      ...nodes([[0, 1]]),
      { start: Number.POSITIVE_INFINITY, end: 3 },
      { start: 4, end: 4 },
      { start: 5, end: 3 },
    ] as SentenceNode[];
    const validResult = applyPostBoundaryHookGate([clip()], invalid, options("observe"));
    const unavailableResult = applyPostBoundaryHookGate([clip()], undefined, options("observe"));

    expect(validResult.telemetry).toMatchObject({ evaluated: 1, notEvaluable: 0, maxPreHookGapSec: 1 });
    expect(unavailableResult.telemetry).toMatchObject({ evaluated: 0, notEvaluable: 1 });
  });

  it("marks malformed clip timing not evaluable without removing it", () => {
    const malformed = clip("bad", { startSec: -1 });
    const result = applyPostBoundaryHookGate(
      [malformed],
      nodes([]),
      options("enforce", { maxDelaySec: 0, maxPreHookGapSec: 0 }),
    );

    expect(result.clips).toEqual([malformed]);
    expect(result.telemetry).toMatchObject({ evaluated: 0, notEvaluable: 1, passed: 0, dropped: 0 });
  });

  it("reports both threshold reasons once and shadow preserves object order", () => {
    const passing = clip("passing", { hookStartSec: 1 });
    const failing = clip("failing", { hookStartSec: 3 });
    const input = [passing, failing];
    const result = applyPostBoundaryHookGate(
      input,
      nodes([]),
      options("shadow", { maxDelaySec: 2, maxPreHookGapSec: 2 }),
    );

    expect(result.clips).toBe(input);
    expect(result.drops).toEqual([]);
    expect(result.telemetry).toMatchObject({
      evaluated: 2,
      passed: 1,
      wouldDrop: 1,
      reasons: { hook_delay: 1, pre_hook_gap: 1 },
    });
    expect(result.telemetry).toMatchObject({
      diagnostics: [expect.objectContaining({ id: "failing", reasons: ["hook_delay", "pre_hook_gap"] })],
    });
  });

  it("reports threshold-free bands and caller-provided provenance", () => {
    const repaired = clip("repaired", { endSec: 8, hookStartSec: 1 }, { score: 0.59 });
    const target = clip("target", { endSec: 90, hookStartSec: 1 }, { score: 0.8 });
    const long = clip("long", { endSec: 91, hookStartSec: 1 }, { score: 0.81 });
    const result = applyPostBoundaryHookGate(
      [repaired, target, long],
      nodes([[0, 1]]),
      {
        ...options("observe"),
        provenanceForClip: (candidate) => ({
          startRepairApplied: candidate.verdict.id === "repaired",
          endExtensionApplied: candidate.verdict.id === "target",
        }),
      },
    );

    expect(result.telemetry).toMatchObject({
      distributions: {
        scoreBand: { below_threshold: 1, threshold_to_0_8: 1, above_0_8: 1 },
        durationBand: { short: 0, target: 2, long: 1 },
        provenance: { startRepairApplied: 1, endExtensionApplied: 1 },
      },
    });
  });

  it("bounds diagnostics to the twenty greatest delay and gap outliers with stable ID ties", () => {
    const delayClips = Array.from({ length: 25 }, (_, index) =>
      clip(`delay-${String(index).padStart(2, "0")}`, { hookStartSec: 100 + index }),
    );
    const gapClips = Array.from({ length: 25 }, (_, index) =>
      clip(`gap-${String(index).padStart(2, "0")}`, { startSec: 200 + index * 2, hookStartSec: 220 + index * 2 }),
    );
    const coverage = [
      ...nodes([[0, 130]]),
      ...gapClips.map((candidate, index) => ({
        ...nodes([[candidate.startSec, candidate.startSec + 0.1]])[0],
        index: index + 100,
      })),
    ];
    const result = applyPostBoundaryHookGate([...delayClips, ...gapClips], coverage, options("observe"));

    expect(result.telemetry?.diagnostics).toHaveLength(40);
    expect(result.telemetry?.diagnostics.slice(0, 20).map((row) => row.id)).toEqual(
      delayClips.slice(5).reverse().map((candidate) => candidate.verdict.id),
    );
  });
});
