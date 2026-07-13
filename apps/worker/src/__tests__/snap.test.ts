import { describe, expect, it } from "vitest";
import { snapNodes } from "../analyze-v2/snap";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { CriticVerdict, SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});

/** 20 nodes x 2s each, all strong sentence boundaries. */
function strongNodes(): SentenceNode[] {
  return Array.from({ length: 20 }, (_, i) => ({
    index: i,
    start: i * 2,
    end: i * 2 + 1.8,
    text: `sentence ${i}.`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

function verdict(p: Partial<CriticVerdict>): CriticVerdict {
  return {
    id: "c0",
    keep: true,
    score: 0.8,
    grounded: true,
    selfContained: true,
    startNode: 2,
    payoffNode: 6,
    endNode: 7,
    hookStartNode: 5,
    hookEndNode: 6,
    title: "t",
    description: "d",
    titleEvidenceNodes: [6],
    descriptionEvidenceNodes: [6],
    language: "en",
    ...p,
  };
}

describe("snapNodes", () => {
  it("snaps a clean clip to word edges with lead-in and tail-hold", () => {
    const r = snapNodes(verdict({}), strongNodes(), cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.startSec).toBeCloseTo(4 - cfg.leadInSec, 5);
    expect(r.clip.endSec).toBeCloseTo(15.8 + cfg.tailHoldSec, 5);
    expect(r.clip.payoffSec).toBeCloseTo(13.8, 5);
    expect(r.clip.shortMoment).toBe(false);
  });

  it("accepts a hook that opens the clip exactly (epsilon, not strict <)", () => {
    const r = snapNodes(verdict({ hookStartNode: 2 }), strongNodes(), cfg);
    expect(r.ok).toBe(true);
  });

  it("forces end at or after the payoff", () => {
    const r = snapNodes(verdict({ endNode: 4, payoffNode: 6 }), strongNodes(), cfg);
    if (!r.ok) throw new Error("should not drop");
    expect(r.clip.endSec).toBeGreaterThanOrEqual(13.8);
  });

  it("drops when the start is weak and no strong boundary is within reach", () => {
    const nodes = strongNodes().map((n, i) =>
      i <= 3 ? { ...n, leadingStrength: 0.3, trailingStrength: 0.3 } : n
    );
    const r = snapNodes(verdict({ startNode: 3, hookStartNode: 5 }), nodes, cfg);
    expect(r).toEqual({ ok: false, reason: "no_clean_start" });
  });

  it("drops sub-6s clips instead of extending them", () => {
    const r = snapNodes(
      verdict({ startNode: 5, payoffNode: 5, endNode: 5, hookStartNode: 5, hookEndNode: 5 }),
      strongNodes(),
      cfg
    );
    // single 1.8s node -> too_short (hookEnd==hookStart also violates, either drop is fine)
    expect(r.ok).toBe(false);
  });

  it("flags 6-8s clips as shortMoment without extending", () => {
    // three 2s nodes -> ~6.4s with lead-in/tail-hold
    const r = snapNodes(
      verdict({ startNode: 5, payoffNode: 7, endNode: 7, hookStartNode: 6, hookEndNode: 7 }),
      strongNodes(),
      cfg
    );
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.shortMoment).toBe(true);
    expect(r.clip.endSec - r.clip.startSec).toBeLessThan(8);
  });

  it("drops when the payoff node is opaque", () => {
    const nodes = strongNodes().map((n, i) => (i === 6 ? { ...n, hasWords: false } : n));
    const r = snapNodes(verdict({}), nodes, cfg);
    expect(r).toEqual({ ok: false, reason: "opaque_payoff" });
  });

  it("walks an opaque end back and re-checks payoff containment", () => {
    const nodes = strongNodes().map((n, i) => (i >= 7 ? { ...n, hasWords: false } : n));
    const r = snapNodes(verdict({ endNode: 8 }), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.endSec).toBeGreaterThanOrEqual(nodes[6].end); // last word-bearing node covers payoff
  });

  it("compresses >90s clips from the start along strong boundaries, keeping the hook", () => {
    const nodes: SentenceNode[] = Array.from({ length: 60 }, (_, i) => ({
      index: i,
      start: i * 2,
      end: i * 2 + 1.9,
      text: `s${i}.`,
      hasWords: true,
      trailingStrength: 1.0,
      leadingStrength: 1.0,
    }));
    const r = snapNodes(
      verdict({ startNode: 0, payoffNode: 55, endNode: 56, hookStartNode: 54, hookEndNode: 55 }),
      nodes,
      cfg
    );
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.endSec - r.clip.startSec).toBeLessThanOrEqual(90);
    expect(r.clip.startSec).toBeLessThanOrEqual(nodes[54].start);
  });
});
