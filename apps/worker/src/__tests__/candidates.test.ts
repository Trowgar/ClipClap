import { describe, expect, it } from "vitest";
import { mergeCandidates, selectCriticCandidates } from "../analyze-v2/candidates";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { ScanCandidate, SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});

function nodes(count: number, secEach = 5): SentenceNode[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    start: i * secEach,
    end: i * secEach + secEach,
    text: `n${i}`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

function cand(p: Partial<ScanCandidate>): ScanCandidate {
  return {
    startNode: 0,
    endNode: 2,
    payoffNode: 1,
    interest: 0.5,
    type: "funny",
    windowIndex: 0,
    ...p,
  };
}

function speechSpan(c: { startNode: number; endNode: number }, secEach: number): number {
  return (c.endNode - c.startNode + 1) * secEach;
}

describe("mergeCandidates", () => {
  it("unions candidates overlapping more than half of the shorter one", () => {
    const merged = mergeCandidates(
      [
        cand({ startNode: 0, endNode: 4, payoffNode: 3, interest: 0.5 }),
        cand({ startNode: 2, endNode: 5, payoffNode: 4, interest: 0.8, type: "reveal" }),
      ],
      nodes(10),
      cfg
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      startNode: 0,
      endNode: 5,
      interest: 0.8,
      type: "reveal", // from the higher-interest constituent
    });
    expect(merged[0].id).toBe("c0");
  });

  it("keeps distant candidates separate and collates thread labels", () => {
    const merged = mergeCandidates(
      [
        cand({ startNode: 0, endNode: 1, payoffNode: 1, thread: "bet" }),
        cand({ startNode: 8, endNode: 9, payoffNode: 9, thread: "bet" }),
      ],
      nodes(10),
      cfg
    );
    expect(merged).toHaveLength(2);
    expect(merged[1].threadSetupNode).toBe(0); // earliest node of the shared thread
  });

  it("refuses to merge overlapping candidates when the union would exceed the span guard", () => {
    // A [0,19] and B [8,29] overlap by 12 nodes > 50% of the shorter (20 -> 10),
    // but the union [0,29] would carry 180s of speech > 130 - the merge gate
    // keeps them separate (the critic sees both; post-critic NMS dedups).
    // A (120s) fits whole; B (132s) exceeds the guard on its own and is split
    // at its payoff 25: head [8,25] (108s) keeps the payoff, tail [26,29]
    // re-anchors its payoff on its own end node.
    const merged = mergeCandidates(
      [
        cand({ startNode: 0, endNode: 19, payoffNode: 5, interest: 0.9 }),
        cand({ startNode: 8, endNode: 29, payoffNode: 25, interest: 0.6 }),
      ],
      nodes(30, 6),
      cfg
    );
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ startNode: 0, endNode: 19, payoffNode: 5 });
    expect(merged[1]).toMatchObject({ startNode: 8, endNode: 25, payoffNode: 25 });
    expect(merged[2]).toMatchObject({ startNode: 26, endNode: 29, payoffNode: 29 });
  });

  it("iteratively splits an oversized raw candidate until every piece fits the guard", () => {
    // One 300s scanner candidate with a late payoff: splitting at the payoff
    // would leave a 294s head, so the guard falls back to midpoint splits and
    // recurses until every piece carries <= 130s of speech. The original
    // payoff survives in exactly one piece.
    const merged = mergeCandidates(
      [cand({ startNode: 0, endNode: 49, payoffNode: 48, interest: 0.9 })],
      nodes(50, 6),
      cfg
    );
    expect(merged.length).toBeGreaterThan(1);
    for (const m of merged) {
      expect(speechSpan(m, 6)).toBeLessThanOrEqual(130);
    }
    const withPayoff = merged.filter((m) => m.startNode <= 48 && 48 <= m.endNode);
    expect(withPayoff).toHaveLength(1);
    expect(withPayoff[0].payoffNode).toBe(48);
  });

  it("does not chain staircase candidates into an unbounded union", () => {
    // 15 length-10 candidates each shifted by 1 node: every consecutive pair
    // overlaps 9/10, but the transitive union would be [0,23] = 144s of speech.
    // The merge gate stops the chain before any union crosses 130s.
    const merged = mergeCandidates(
      Array.from({ length: 15 }, (_, i) =>
        cand({ startNode: i, endNode: i + 9, payoffNode: i, interest: 0.5 })
      ),
      nodes(40, 6),
      cfg
    );
    expect(merged.length).toBeGreaterThan(1);
    for (const m of merged) {
      expect(speechSpan(m, 6)).toBeLessThanOrEqual(130);
    }
  });

  it("keeps zero-overlap adjacent-payoff candidates separate", () => {
    // Payoffs 2 and 3 are adjacent, but the ranges share no node - the
    // payoff-proximity rule requires at least one node of overlap.
    const merged = mergeCandidates(
      [
        cand({ startNode: 0, endNode: 2, payoffNode: 2, type: "funny" }),
        cand({ startNode: 3, endNode: 12, payoffNode: 3, type: "reveal" }),
      ],
      nodes(20),
      cfg
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ startNode: 0, endNode: 2, type: "funny" });
    expect(merged[1]).toMatchObject({ startNode: 3, endNode: 12, type: "reveal" });
  });

  it("does not mutate the caller's candidate objects", () => {
    const input = cand({ startNode: 0, endNode: 2, payoffNode: 99, interest: 1.5 });
    const merged = mergeCandidates([input], nodes(10), cfg);
    expect(input.payoffNode).toBe(99); // caller's object untouched
    expect(input.interest).toBe(1.5);
    expect(merged[0].payoffNode).toBe(0); // coerced to startNode on the copy
    expect(merged[0].interest).toBe(1); // clamped on the copy
  });
});

describe("selectCriticCandidates", () => {
  it("guarantees per-window representation before global interest fill", () => {
    const all = [
      // window 0: two weak candidates
      cand({ startNode: 0, endNode: 1, payoffNode: 1, interest: 0.2, windowIndex: 0 }),
      cand({ startNode: 2, endNode: 3, payoffNode: 3, interest: 0.25, windowIndex: 0 }),
      // window 1: many strong candidates
      ...Array.from({ length: 10 }, (_, i) =>
        cand({ startNode: 20 + i, endNode: 21 + i, payoffNode: 21 + i, interest: 0.9, windowIndex: 1 })
      ),
    ];
    const merged = mergeCandidates(all, nodes(40), { ...cfg, criticMaxCandidates: 6 });
    const selected = selectCriticCandidates(merged, nodes(40), {
      ...cfg,
      criticMaxCandidates: 6,
    }, 10);
    const window0 = selected.filter((c) => c.windowIndex === 0);
    expect(window0.length).toBeGreaterThanOrEqual(2); // quota survived the flood
    expect(selected.length).toBeLessThanOrEqual(6);
  });

  it("blocks extras at K but never evicts per-window quota picks", () => {
    const merged = mergeCandidates(
      Array.from({ length: 50 }, (_, i) =>
        cand({ startNode: i * 2, endNode: i * 2 + 1, payoffNode: i * 2 + 1, interest: 0.5, windowIndex: Math.floor(i / 10) })
      ),
      nodes(120),
      cfg
    );
    // 5 windows x 2 quota = 10 guaranteed; K = clamp(round(10/2), 8, 40) = 8,
    // so extras are blocked entirely but the quota tier stays -> exactly 10
    const selected = selectCriticCandidates(merged, nodes(120), cfg, 10);
    expect(selected.length).toBe(10);
    for (let w = 0; w < 5; w++) {
      expect(selected.filter((c) => c.windowIndex === w)).toHaveLength(2);
    }
  });

  it("caps extras per 10-minute region while quota picks ignore the cap", () => {
    const ns = nodes(150); // 5s nodes -> region boundary at node 120 (600s)
    const all = [
      // window 0: 10 disjoint candidates, payoffs all inside region 0
      ...Array.from({ length: 10 }, (_, i) =>
        cand({
          startNode: i * 4,
          endNode: i * 4 + 1,
          payoffNode: i * 4 + 1,
          interest: 0.9 - i * 0.01,
          windowIndex: 0,
        })
      ),
      // window 1: 2 candidates with payoffs in region 1 (start >= 600s)
      cand({ startNode: 120, endNode: 121, payoffNode: 121, interest: 0.5, windowIndex: 1 }),
      cand({ startNode: 124, endNode: 125, payoffNode: 125, interest: 0.49, windowIndex: 1 }),
    ];
    const merged = mergeCandidates(all, ns, cfg);
    expect(merged).toHaveLength(12); // disjoint, nothing merges
    const selected = selectCriticCandidates(merged, ns, cfg, 60); // K = 30, no K pressure
    // region 0 gets 2 quota picks + extras only up to regionMaxCandidates (6);
    // the remaining 4 region-0 extras are rejected by the cap despite K room
    const region0 = selected.filter((c) => ns[c.payoffNode].start < 600);
    expect(region0).toHaveLength(cfg.regionMaxCandidates);
    expect(selected).toHaveLength(cfg.regionMaxCandidates + 2);
  });
});
