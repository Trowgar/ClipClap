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

// Timing geometry only: this synthetic fixture intentionally carries no
// transcript content, source URL, user identifier, or storage key.
const caramelClip = clip("caramel", {
  startSec: 562.99,
  endSec: 582.3,
  hookStartSec: 572.3,
});
const caramelNodes: SentenceNode[] = [
  {
    index: 0,
    start: 569.27,
    end: 572.3,
    text: "",
    hasWords: true,
    trailingStrength: 1,
    leadingStrength: 1,
  },
];

describe("post-boundary hook gate", () => {
  it("drops in enforce when hook delay exceeds the strict limit", () => {
    const result = applyPostBoundaryHookGate(
      [clip("late", { startSec: 10, endSec: 12.01, hookStartSec: 12.01 })],
      nodes([[10, 12.01]]),
      options("enforce", { maxDelaySec: 2, maxPreHookGapSec: 9 }),
    );

    expect(result.clips).toEqual([]);
    expect(result.drops).toEqual([{ id: "late", reasons: ["hook_delay"] }]);
  });

  it("observes the synthetic caramel opening and drops it below strict limits", () => {
    const shadow = applyPostBoundaryHookGate(
      [caramelClip],
      caramelNodes,
      options("shadow", { maxDelaySec: 9, maxPreHookGapSec: 6 }),
    );

    expect(shadow.telemetry?.maxHookDelaySec).toBeCloseTo(9.31, 2);
    expect(shadow.telemetry?.maxPreHookGapSec).toBeCloseTo(6.28, 2);
    expect(shadow.telemetry).toMatchObject({
      mode: "shadow",
      wouldDrop: 1,
      diagnostics: [
        expect.objectContaining({
          id: "caramel",
          hookDelaySec: expect.closeTo(9.31, 2),
          preHookGapSec: expect.closeTo(6.28, 2),
        }),
      ],
    });

    const enforced = applyPostBoundaryHookGate(
      [caramelClip],
      caramelNodes,
      options("enforce", { maxDelaySec: 9, maxPreHookGapSec: 6 }),
    );
    expect(enforced.clips).toEqual([]);
    expect(enforced.drops).toEqual([
      { id: "caramel", reasons: ["hook_delay", "pre_hook_gap"] },
    ]);
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
    const exactGap = clip("exact-gap", { startSec: 10, endSec: 12, hookStartSec: 12 });
    const overGap = clip("over-gap", { startSec: 20, endSec: 22, hookStartSec: 22 });
    const result = applyPostBoundaryHookGate(
      [exact, overDelay, exactGap, overGap],
      nodes([[0, 2], [10, 11], [20, 20.99]]),
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
    expect(largestPreHookGap(nodes([[0, 2], [1, 4]]), 0, 5)).toBe(1);
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
        byScoreBand: {
          below_threshold: { count: 1 },
          threshold_to_0_8: { count: 1 },
          above_0_8: { count: 1 },
        },
        byDurationBand: { short: { count: 0 }, target: { count: 2 }, long: { count: 1 } },
        provenance: {
          startRepairApplied: { yes: { count: 1 }, no: { count: 2 } },
          endExtensionApplied: { yes: { count: 1 }, no: { count: 2 } },
        },
      },
    });
  });

  it("splits raw delay and gap distributions and maxima across every report dimension", () => {
    const repaired = clip("repaired", { endSec: 8, hookStartSec: 2 }, { score: 0.59, kind: "story", language: "en" });
    const extended = clip("extended", { startSec: 10, endSec: 101, hookStartSec: 13 }, { score: 0.81, kind: "reaction", language: "ru" });
    const result = applyPostBoundaryHookGate(
      [repaired, extended],
      nodes([[0, 2]]),
      {
        ...options("observe"),
        provenanceForClip: (candidate) => ({
          startRepairApplied: candidate.verdict.id === "repaired",
          endExtensionApplied: candidate.verdict.id === "extended",
        }),
      },
    );

    expect(result.telemetry).toMatchObject({
      distributions: {
        byKind: {
          story: { hookDelaySec: [2], preHookGapSec: [0], maxHookDelaySec: 2, maxPreHookGapSec: 0 },
          reaction: { hookDelaySec: [3], preHookGapSec: [3], maxHookDelaySec: 3, maxPreHookGapSec: 3 },
        },
        byLanguage: {
          en: { hookDelaySec: [2], preHookGapSec: [0] },
          ru: { hookDelaySec: [3], preHookGapSec: [3] },
        },
        byScoreBand: {
          below_threshold: { count: 1, hookDelaySec: [2] },
          above_0_8: { count: 1, preHookGapSec: [3] },
        },
        byDurationBand: {
          target: { count: 1, maxHookDelaySec: 2 },
          long: { count: 1, maxPreHookGapSec: 3 },
        },
        provenance: {
          startRepairApplied: { yes: { count: 1, hookDelaySec: [2] }, no: { count: 1, hookDelaySec: [3] } },
          endExtensionApplied: { yes: { count: 1, preHookGapSec: [3] }, no: { count: 1, preHookGapSec: [0] } },
        },
      },
    });
  });

  it("keeps prototype-like kind and language values as own distribution keys", () => {
    const reserved = clip("reserved", { hookStartSec: 1 }, { kind: "__proto__", language: "constructor" });
    const result = applyPostBoundaryHookGate([reserved], nodes([[0, 1]]), options("observe"));
    const distributions = result.telemetry?.distributions;

    expect(Object.hasOwn(distributions?.byKind ?? {}, "__proto__")).toBe(true);
    expect(Object.hasOwn(distributions?.byLanguage ?? {}, "constructor")).toBe(true);
    expect(distributions?.byKind.__proto__).toMatchObject({ count: 1, hookDelaySec: [1] });
    expect(distributions?.byLanguage.constructor).toMatchObject({ count: 1, preHookGapSec: [0] });
  });

  it("reports threshold exceedance rates and every threshold diagnostic without language", () => {
    const input = Array.from({ length: 45 }, (_, index) =>
      clip(`drop-${String(index).padStart(2, "0")}`, { endSec: index + 2, hookStartSec: index + 1 }),
    );
    const result = applyPostBoundaryHookGate(
      input,
      nodes([]),
      options("shadow", { maxDelaySec: 0, maxPreHookGapSec: 0 }),
    );

    expect(result.telemetry).toMatchObject({
      wouldDrop: 45,
      exceeds: {
        hook_delay: { count: 45, rate: 1 },
        pre_hook_gap: { count: 45, rate: 1 },
      },
      estimatedOutputCountLoss: 45,
    });
    expect(result.telemetry?.diagnostics).toHaveLength(45);
    expect(result.telemetry?.diagnostics.map((diagnostic) => diagnostic.id)).toEqual(
      input.map((candidate) => candidate.verdict.id),
    );
    expect(result.telemetry?.diagnostics[0]).not.toHaveProperty("language");
  });

  it("enforces repaired and extended failures with dual reasons and explicit provenance", () => {
    const repaired = clip("repaired", { hookStartSec: 3 });
    const extended = clip("extended", { startSec: 10, endSec: 11, hookStartSec: 11 });
    const passing = clip("passing", { startSec: 20, endSec: 21, hookStartSec: 21 });
    const result = applyPostBoundaryHookGate(
      [repaired, extended, passing],
      nodes([[20, 21]]),
      {
        ...options("enforce", { maxDelaySec: 2, maxPreHookGapSec: 0.5 }),
        provenanceForClip: (candidate) => ({
          startRepairApplied: candidate.verdict.id === "repaired",
          endExtensionApplied: candidate.verdict.id === "extended",
        }),
      },
    );

    expect(result.clips).toEqual([passing]);
    expect(result.drops).toEqual([
      { id: "repaired", reasons: ["hook_delay", "pre_hook_gap"] },
      { id: "extended", reasons: ["pre_hook_gap"] },
    ]);
    expect(result.telemetry).toMatchObject({
      dropped: 2,
      diagnostics: [
        expect.objectContaining({ id: "repaired", startRepairApplied: true, reasons: ["hook_delay", "pre_hook_gap"] }),
        expect.objectContaining({ id: "extended", endExtensionApplied: true, reasons: ["pre_hook_gap"] }),
      ],
    });
    expect(result.telemetry?.diagnostics[0]).not.toHaveProperty("language");
  });

  it("passes before a start repair and drops after the repaired boundary delays the hook", () => {
    const beforeRepair = clip("candidate", { startSec: 1, hookStartSec: 3 });
    const afterRepair = clip("candidate", { startSec: 0, hookStartSec: 3 });
    const gateOptions = {
      ...options("enforce", { maxDelaySec: 2, maxPreHookGapSec: 1 }),
      provenanceForClip: () => ({ startRepairApplied: true }),
    };

    const before = applyPostBoundaryHookGate([beforeRepair], nodes([[1, 3]]), gateOptions);
    const after = applyPostBoundaryHookGate([afterRepair], nodes([[1, 3]]), gateOptions);

    expect(before.clips).toEqual([beforeRepair]);
    expect(before.telemetry).toMatchObject({ passed: 1, dropped: 0 });
    expect(after.clips).toEqual([]);
    expect(after.drops).toEqual([{ id: "candidate", reasons: ["hook_delay"] }]);
    expect(after.telemetry).toMatchObject({
      passed: 0,
      dropped: 1,
      diagnostics: [expect.objectContaining({ startRepairApplied: true, hookDelaySec: 3 })],
    });
  });

  it("evaluates a zero-length hook interval as a zero-gap passing decision", () => {
    const zeroLength = clip("zero", { startSec: 5, hookStartSec: 5 });
    const result = applyPostBoundaryHookGate(
      [zeroLength],
      nodes([]),
      options("enforce", { maxDelaySec: 0, maxPreHookGapSec: 0 }),
    );

    expect(result.clips).toEqual([zeroLength]);
    expect(result.drops).toEqual([]);
    expect(result.telemetry).toMatchObject({
      evaluated: 1,
      notEvaluable: 0,
      passed: 1,
      dropped: 0,
      maxHookDelaySec: 0,
      maxPreHookGapSec: 0,
      distributions: { overall: { hookDelaySec: [0], preHookGapSec: [0] } },
    });
  });

  it("evaluates beyond the final end and enforces hook delay from the start-to-hook interval", () => {
    const postEndHook = clip("post-end-hook", { startSec: 0, endSec: 2, hookStartSec: 3 });
    const result = applyPostBoundaryHookGate(
      [postEndHook],
      nodes([[0, 3]]),
      options("enforce", { maxDelaySec: 1, maxPreHookGapSec: 1 }),
    );

    expect(result.clips).toEqual([]);
    expect(result.drops).toEqual([{ id: "post-end-hook", reasons: ["hook_delay"] }]);
    expect(result.telemetry).toMatchObject({ evaluated: 1, notEvaluable: 0, dropped: 1 });
  });

  it("bounds diagnostics to the twenty greatest delay and gap outliers with stable ID ties", () => {
    const delayClips = Array.from({ length: 25 }, (_, index) =>
      clip(`delay-${String(index).padStart(2, "0")}`, { endSec: 130, hookStartSec: 100 + index }),
    );
    const gapClips = Array.from({ length: 25 }, (_, index) =>
      clip(`gap-${String(index).padStart(2, "0")}`, {
        startSec: 200 + index * 2,
        endSec: 220 + index * 2,
        hookStartSec: 220 + index * 2,
      }),
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
