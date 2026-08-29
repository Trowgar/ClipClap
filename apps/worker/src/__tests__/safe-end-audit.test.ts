import { describe, expect, it } from "vitest";
import {
  capSafeEndNormalRecords,
  capSafeEndRescueRecords,
  reconcileSafeEndNormalRecords,
  safeEndGeometryReference,
  zeroTailHandoff,
  type SafeEndGeometryReference,
  type SafeEndNormalRecord,
  type SafeEndRescueRecord,
} from "../analyze-v2/safe-end-audit";
import type { SentenceNode, SnappedClip } from "../analyze-v2/types";

function clip(
  id: string,
  values: Partial<Pick<SnappedClip, "startSec" | "endSec" | "finalStartNode" | "finalEndNode">> = {},
): SnappedClip {
  return {
    verdict: { id, score: 0.7, language: "en", kind: "story" },
    startSec: 0,
    endSec: 10,
    finalStartNode: 0,
    finalEndNode: 0,
    ...values,
  } as SnappedClip;
}

function nodes(ranges: Array<[number, number, boolean]>): SentenceNode[] {
  return ranges.map(([start, end, hasWords], index) => ({
    index,
    start,
    end,
    hasWords,
    text: "",
    trailingStrength: 1,
    leadingStrength: 1,
  }));
}

function geometry(candidateId: string): SafeEndGeometryReference {
  return { candidateId, startMs: 0, endMs: 10_000, startNode: 0, endNode: 0 };
}

function normal(candidateId: string, outcome: SafeEndNormalRecord["outcome"]): SafeEndNormalRecord {
  return {
    geometry: geometry(candidateId),
    score: 0.7,
    language: "en",
    kind: "story",
    outcome,
    reason: null,
  };
}

function rescue(
  candidateId: string,
  proposedAction: SafeEndRescueRecord["proposedAction"],
  selectedState: SafeEndRescueRecord["selectedState"] = "not_selected",
): SafeEndRescueRecord {
  return {
    geometry: geometry(candidateId),
    score: 0.7,
    scoreRank: 1,
    zeroTailHandoff: proposedAction === "zero_tail_handoff" || proposedAction === "both",
    arcEvidence:
      proposedAction === "standing_arc" || proposedAction === "both"
        ? "matching_standing"
        : "matching_clear",
    proposedAction,
    selectedState,
  };
}

describe("safe-end audit primitives", () => {
  it("detects only an immediate word-bearing zero-tail handoff", () => {
    expect(zeroTailHandoff(clip("at-edge", { endSec: 0, finalEndNode: 0 }), nodes([[-2, 0, true], [0.05, 2, true]]))).toBe(true);
    expect(zeroTailHandoff(clip("over-edge", { endSec: 0, finalEndNode: 0 }), nodes([[-2, 0, true], [0.051, 2, true]]))).toBe(false);
    expect(zeroTailHandoff(clip("opaque", { finalEndNode: 0 }), nodes([[8, 10, false], [10, 12, true]]))).toBe(false);
    expect(zeroTailHandoff(clip("opaque-next", { finalEndNode: 0 }), nodes([[8, 10, true], [10, 12, false]]))).toBe(false);
    expect(zeroTailHandoff(clip("missing", { finalEndNode: 1 }), nodes([[8, 10, true]]))).toBe(false);
    expect(zeroTailHandoff(clip("invalid", { finalEndNode: 0 }), nodes([[8, 8, true], [10, 12, true]]))).toBe(false);
  });

  it("skips opaque and invalid nodes when finding the final and following word-bearing nodes", () => {
    expect(
      zeroTailHandoff(
        clip("search", { endSec: 0, finalStartNode: 0, finalEndNode: 3 }),
        nodes([
          [-3, -2, false],
          [-2, 0, true],
          [0, 1, false],
          [1, 1, true],
          [0, 1, false],
          [2, 1, true],
          [0.05, 2, true],
        ]),
      ),
    ).toBe(true);
  });

  it("rounds geometry from snapped clips without exposing clip references", () => {
    const candidate = clip("rounded", {
      startSec: 1.2345,
      endSec: 9.8765,
      finalStartNode: 4,
      finalEndNode: 9,
    });
    expect(safeEndGeometryReference(candidate)).toEqual({
      candidateId: "rounded",
      startMs: 1235,
      endMs: 9877,
      startNode: 4,
      endNode: 9,
    });
  });

  it("orders normal detail by closed severity then candidate id", () => {
    const result = capSafeEndNormalRecords([
      normal("safe", "safe"),
      normal("not-evaluable", "not_evaluable"),
      normal("failed", "audit_failed"),
      normal("afterbeat", "needs_afterbeat"),
      normal("handoff-b", "hard_handoff"),
      normal("handoff-a", "hard_handoff"),
    ]);

    expect(result.records.map((record) => record.geometry.candidateId)).toEqual([
      "handoff-a",
      "handoff-b",
      "afterbeat",
      "failed",
      "not-evaluable",
      "safe",
    ]);
    expect(result.truncatedCount).toBe(0);
  });

  it("orders rescue detail by closed severity, including standing arc", () => {
    const result = capSafeEndRescueRecords([
      rescue("none", "none"),
      rescue("standing", "standing_arc"),
      rescue("zero", "zero_tail_handoff"),
      rescue("both-b", "both"),
      rescue("both-a", "both"),
      rescue("selected", "none", "selected"),
    ]);

    expect(result.records.map((record) => record.geometry.candidateId)).toEqual([
      "both-a",
      "both-b",
      "zero",
      "standing",
      "none",
      "selected",
    ]);
    expect(result.truncatedCount).toBe(0);
  });

  it("hard-caps normal detail at twenty records", () => {
    const records = Array.from({ length: 22 }, (_, index) => normal(`safe-${index.toString().padStart(2, "0")}`, "safe"));
    const result = capSafeEndNormalRecords(records);

    expect(result.records).toHaveLength(20);
    expect(result.records.at(-1)?.geometry.candidateId).toBe("safe-19");
    expect(result.truncatedCount).toBe(2);
    expect(records).toHaveLength(22);
  });

  it("does not permit callers to bypass the fixed V1 cap", () => {
    const records = Array.from({ length: 22 }, (_, index) => normal(`safe-${index.toString().padStart(2, "0")}`, "safe"));
    // @ts-expect-error V1's telemetry cap is intentionally not configurable.
    const result = capSafeEndNormalRecords(records, 0);

    expect(result.records).toHaveLength(20);
    expect(result.truncatedCount).toBe(2);
  });

  it("retains a selected rescue loser outside the first twenty details", () => {
    const records = [
      ...Array.from({ length: 21 }, (_, index) => rescue(`both-${index.toString().padStart(2, "0")}`, "both")),
      rescue("selected-loser", "none", "selected"),
    ];
    const result = capSafeEndRescueRecords(records);

    expect(result.records).toHaveLength(20);
    expect(result.records.map((record) => record.geometry.candidateId)).toContain("selected-loser");
    expect(result.records.map((record) => record.geometry.candidateId)).not.toContain("both-20");
    expect(result.truncatedCount).toBe(2);
  });

  it("reconciles actual geometry membership without mutating clips or records", () => {
    const source = clip("shipped", { startSec: 1.2344, endSec: 9.8764 });
    const shipped = clip("shipped", { startSec: 1.23449, endSec: 9.87649 });
    const records = [
      { ...normal("before", "safe"), geometry: safeEndGeometryReference(clip("before")) },
      { ...normal("finalizer", "safe"), geometry: safeEndGeometryReference(clip("finalizer")) },
      { ...normal("soft", "safe"), geometry: safeEndGeometryReference(clip("soft")) },
      { ...normal("shipped", "safe"), geometry: safeEndGeometryReference(source) },
      { ...normal("trimmed", "safe"), geometry: safeEndGeometryReference(clip("trimmed")) },
    ];
    const original = structuredClone(records);

    const reconciled = reconcileSafeEndNormalRecords(
      records,
      [clip("finalizer"), clip("soft"), source, clip("trimmed")],
      [clip("soft"), source, clip("trimmed", { startSec: 3, endSec: 8, finalStartNode: 3, finalEndNode: 8 })],
      [shipped, clip("trimmed", { startSec: 3, endSec: 8, finalStartNode: 3, finalEndNode: 8 })],
    );

    expect(reconciled.map((record) => record.reconciliation?.state)).toEqual([
      "removed_before_finalizer",
      "removed_by_finalizer",
      "removed_by_soft_cap",
      "shipped",
      "shipped",
    ]);
    expect(reconciled[3].reconciliation).toEqual({
      state: "shipped",
      finalGeometry: safeEndGeometryReference(shipped),
    });
    expect(reconciled[4].reconciliation).toEqual({
      state: "shipped",
      finalGeometry: safeEndGeometryReference(clip("trimmed", { startSec: 3, endSec: 8, finalStartNode: 3, finalEndNode: 8 })),
    });
    expect(records).toEqual(original);
    expect(source).toEqual(clip("shipped", { startSec: 1.2344, endSec: 9.8764 }));
  });
});
