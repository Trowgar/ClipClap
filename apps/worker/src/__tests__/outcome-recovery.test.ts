import { describe, expect, it } from "vitest";
import {
  buildOutcomeRecoveryPool,
  isOutcomeRecoveryEligible,
} from "../analyze-v2/outcome-recovery";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { MergedCandidate, SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});

function nodes(count: number, secEach = 100): SentenceNode[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    start: index * secEach,
    end: index * secEach + secEach,
    text: `node-${index}`,
    hasWords: true,
    trailingStrength: 1,
    leadingStrength: 1,
  }));
}

function candidate(id: string, input: Partial<MergedCandidate> = {}): MergedCandidate {
  return {
    id,
    startNode: 0,
    endNode: 0,
    payoffNode: 0,
    interest: 0.5,
    type: "other",
    windowIndex: 0,
    ...input,
  };
}

describe("outcome recovery pool", () => {
  it("round-robins ten-minute payoff regions, sorting each region by interest then id", () => {
    const tail = [
      candidate("r0", { payoffNode: 0, interest: 0.9 }),
      candidate("r1", { payoffNode: 1, interest: 0.8 }),
      candidate("r2", { payoffNode: 2, interest: 0.7 }),
      candidate("r3", { payoffNode: 6, interest: 0.9 }),
      candidate("r4", { payoffNode: 7, interest: 0.8 }),
      candidate("r5", { payoffNode: 8, interest: 0.7 }),
      candidate("r6", { payoffNode: 12, interest: 0.9 }),
      candidate("r7", { payoffNode: 13, interest: 0.8 }),
      candidate("r8", { payoffNode: 14, interest: 0.7 }),
    ];
    const result = buildOutcomeRecoveryPool({
      candidates: tail,
      nodes: nodes(20),
      missingRanges: [],
      maxCandidates: 6,
    });

    expect(result.candidates.map((item) => item.id)).toEqual([
      "r0",
      "r3",
      "r6",
      "r1",
      "r4",
      "r7",
    ]);
  });

  it("uses stable id for interest ties and excludes every candidate intersecting a hole", () => {
    const tail = [
      candidate("b", { startNode: 0, endNode: 1, payoffNode: 0, interest: 0.8 }),
      candidate("a", { startNode: 1, endNode: 1, payoffNode: 1, interest: 0.8 }),
      candidate("crosses-hole", { startNode: 2, endNode: 3, payoffNode: 2, interest: 0.9 }),
      candidate("edge-before", { startNode: 1, endNode: 1, payoffNode: 1, interest: 0.7 }),
      candidate("edge-after", { startNode: 6, endNode: 6, payoffNode: 6, interest: 0.6 }),
    ];
    const result = buildOutcomeRecoveryPool({
      candidates: tail,
      nodes: nodes(8, 10),
      missingRanges: [{ start: 25, end: 50 }],
      maxCandidates: 12,
    });

    expect(result.excludedMissingRange).toBe(1);
    expect(result.candidates.map((item) => item.id)).toEqual([
      "a",
      "b",
      "edge-before",
      "edge-after",
    ]);
  });

  it("enforces the defensive hard maximum, handles empty caps, and does not mutate inputs", () => {
    const tail = Array.from({ length: 20 }, (_, index) =>
      candidate(`c${index}`, { payoffNode: index, interest: index / 20 })
    );
    const before = tail.map((item) => ({ ...item }));
    expect(buildOutcomeRecoveryPool({ candidates: tail, nodes: nodes(20), missingRanges: [], maxCandidates: 99 }).candidates).toHaveLength(12);
    expect(buildOutcomeRecoveryPool({ candidates: tail, nodes: nodes(20), missingRanges: [], maxCandidates: 0 }).candidates).toEqual([]);
    expect(tail).toEqual(before);
  });
});

describe("outcome recovery eligibility", () => {
  const base = {
    mode: cfg.outcomeRecoveryMode,
    primaryHighlights: [],
    noClipsReason: "NO_VIABLE_MOMENTS" as const,
    transcriptPartial: false,
    missingRangeDrops: 0,
    path: "full",
    unselectedCount: 1,
  };

  it("requires the honest full-path empty outcome with an unjudged tail", () => {
    expect(isOutcomeRecoveryEligible({ ...base, mode: "on" })).toEqual({
      eligible: true,
      reason: "unjudged_tail",
    });
  });

  it("uses deterministic precedence for all ineligible reasons", () => {
    expect(isOutcomeRecoveryEligible({ ...base, mode: "off", primaryHighlights: [{} as never], noClipsReason: "NO_USABLE_SPEECH", transcriptPartial: true, missingRangeDrops: 1, path: "degenerate", unselectedCount: 0 })).toEqual({ eligible: false, reason: "mode_off" });
    expect(isOutcomeRecoveryEligible({ ...base, mode: "on", primaryHighlights: [{} as never], noClipsReason: "NO_USABLE_SPEECH", transcriptPartial: true, missingRangeDrops: 1, path: "degenerate", unselectedCount: 0 })).toEqual({ eligible: false, reason: "non_empty" });
    expect(isOutcomeRecoveryEligible({ ...base, mode: "on", noClipsReason: "NO_USABLE_SPEECH", transcriptPartial: true, missingRangeDrops: 1, path: "degenerate", unselectedCount: 0 })).toEqual({ eligible: false, reason: "wrong_content_reason" });
    expect(isOutcomeRecoveryEligible({ ...base, mode: "on", transcriptPartial: true, missingRangeDrops: 1, path: "degenerate", unselectedCount: 0 })).toEqual({ eligible: false, reason: "partial_transcript" });
    expect(isOutcomeRecoveryEligible({ ...base, mode: "on", missingRangeDrops: 1, path: "degenerate", unselectedCount: 0 })).toEqual({ eligible: false, reason: "missing_range" });
    expect(isOutcomeRecoveryEligible({ ...base, mode: "on", path: "degenerate", unselectedCount: 0 })).toEqual({ eligible: false, reason: "degenerate" });
    expect(isOutcomeRecoveryEligible({ ...base, mode: "on", path: "song-gate", unselectedCount: 0 })).toEqual({ eligible: false, reason: "song_gate" });
    expect(isOutcomeRecoveryEligible({ ...base, mode: "on", unselectedCount: 0 })).toEqual({ eligible: false, reason: "no_unjudged_tail" });
  });

  it("rejects partial, wrong-path, and non-positive tail values", () => {
    expect(isOutcomeRecoveryEligible({ ...base, mode: "shadow", path: "tiny" })).toEqual({ eligible: false, reason: "no_unjudged_tail" });
    expect(isOutcomeRecoveryEligible({ ...base, mode: "shadow", path: "tiny", unselectedCount: 1 })).toEqual({ eligible: false, reason: "no_unjudged_tail" });
    expect(isOutcomeRecoveryEligible({ ...base, mode: "shadow", unselectedCount: -1 })).toEqual({ eligible: false, reason: "no_unjudged_tail" });
  });

  it("fails closed for invalid missing-range and tail counters", () => {
    for (const missingRangeDrops of [Number.NaN, Number.POSITIVE_INFINITY, 0.5, -1]) {
      expect(isOutcomeRecoveryEligible({ ...base, mode: "on", missingRangeDrops })).toEqual({
        eligible: false,
        reason: "missing_range",
      });
    }
    for (const unselectedCount of [Number.NaN, Number.POSITIVE_INFINITY, 0.5, -1]) {
      expect(isOutcomeRecoveryEligible({ ...base, mode: "on", unselectedCount })).toEqual({
        eligible: false,
        reason: "no_unjudged_tail",
      });
    }
  });
});
