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

  it("splits merged regions longer than ~130s of speech at the strongest payoff", () => {
    const merged = mergeCandidates(
      [
        cand({ startNode: 0, endNode: 15, payoffNode: 5, interest: 0.9 }),
        cand({ startNode: 10, endNode: 29, payoffNode: 25, interest: 0.6 }),
      ],
      nodes(30, 6), // union would span 30 nodes * 6s = 180s
      cfg
    );
    expect(merged.length).toBe(2);
    expect(merged.every((m) => {
      const span = (m.endNode - m.startNode + 1) * 6;
      return span <= 135;
    })).toBe(true);
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
});
