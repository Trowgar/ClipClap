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
    text: `Sentence ${i}.`,
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
    // tail-hold capped at the next node's onset: min(15.8 + 0.3, 16) = 16
    expect(r.clip.endSec).toBeCloseTo(16, 5);
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

  it("accepts an opaque payoff at segment confidence instead of dropping", () => {
    // punchline drowned in laughter: words unreliable, segment edges real
    const nodes = strongNodes().map((n, i) => (i === 6 ? { ...n, hasWords: false } : n));
    const r = snapNodes(verdict({}), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.boundaryConfidence).toBe("segment");
    expect(r.clip.endSec).toBeGreaterThanOrEqual(nodes[6].end);
  });

  it("treats a start right after an opaque node as a clean cold open", () => {
    // music break before the sentence: leadingStrength inherits 0.2 but the
    // gap itself is a strong semantic boundary
    const nodes = strongNodes().map((n, i) =>
      i === 4 ? { ...n, hasWords: false } : i === 5 ? { ...n, leadingStrength: 0.2 } : n
    );
    const r = snapNodes(
      verdict({ startNode: 5, payoffNode: 7, endNode: 8, hookStartNode: 6, hookEndNode: 7 }),
      nodes,
      cfg
    );
    expect(r.ok).toBe(true);
  });

  it("walks an opaque end back and re-checks payoff containment", () => {
    const nodes = strongNodes().map((n, i) => (i >= 7 ? { ...n, hasWords: false } : n));
    const r = snapNodes(verdict({ endNode: 8 }), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.endSec).toBeGreaterThanOrEqual(nodes[6].end); // last word-bearing node covers payoff
  });

  it("clamps a nested prev.end at the start node onset instead of cutting into it", () => {
    // node1's words nest past node2's onset (legal nested-word input);
    // the start must land exactly at node2.start, not at prev.end.
    const nodes = strongNodes().map((n, i) => (i === 1 ? { ...n, end: 5.5 } : n));
    const r = snapNodes(verdict({}), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.startSec).toBe(4);
  });

  it("salvages a clip whose start and end nodes are both opaque", () => {
    const nodes = strongNodes()
      .slice(0, 12)
      .map((n, i) => {
        if (i === 3) return { ...n, hasWords: false, leadingStrength: 0.3 };
        if (i === 8) return { ...n, hasWords: false };
        return n;
      });
    const r = snapNodes(
      verdict({ startNode: 3, payoffNode: 6, endNode: 8, hookStartNode: 6, hookEndNode: 6 }),
      nodes,
      cfg
    );
    expect(r.ok).toBe(true);
  });

  it("extends the end for a nested payoff that outlasts the end node", () => {
    // payoff node6's last word runs to 20s, past endNode 7's end (15.8s);
    // payoff containment outranks the bleed cap - extend, don't drop.
    const nodes = strongNodes().map((n, i) => (i === 6 ? { ...n, end: 20 } : n));
    const r = snapNodes(verdict({}), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.endSec).toBeGreaterThanOrEqual(20);
  });

  it("vetoes a lowercase pause-boundary start and walks back to a real sentence onset", () => {
    // CLIP4 regression: a hesitation pause minted a fake 0.8 boundary before
    // "глаза на все её хотелки" - the lowercase onset must veto it and the
    // walk-back must land on the earlier capitalized sentence start.
    const nodes = strongNodes().map((n, i) =>
      i === 3
        ? { ...n, text: "глаза на все её хотелки.", leadingStrength: 0.8 }
        : n
    );
    const r = snapNodes(verdict({ startNode: 3 }), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    // node2 is the nearest clean (capitalized, strong) start within reach
    expect(r.clip.startSec).toBeCloseTo(nodes[2].start - cfg.leadInSec, 5);
  });

  it("trims a weak comma end back to the sentence-final payoff", () => {
    // CLIP3 regression: end lands on "...искала ты его потому," (weak trailing,
    // lowercase continuation follows) - repair must trim BACK to the payoff's
    // terminal boundary, not swallow the next sentence forward.
    const nodes = strongNodes().map((n, i) => {
      if (i === 7) return { ...n, text: "которого не существует,", trailingStrength: 0.4, leadingStrength: 0.4 };
      if (i === 8) return { ...n, text: "а искала ты его потому,", trailingStrength: 0.4, leadingStrength: 0.4 };
      // real graphs derive leadingStrength from the previous node's trailing
      if (i === 9) return { ...n, leadingStrength: 0.4 };
      return n;
    });
    const r = snapNodes(verdict({ payoffNode: 6, endNode: 8 }), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    // trimmed to node6 ("Sentence 6." trailing 1.0): endSec = min(13.8 + 0.3, 14) = 14
    expect(r.clip.endSec).toBeCloseTo(14, 5);
  });

  it("drops with no_clean_end when no clean boundary exists near the payoff", () => {
    const nodes = strongNodes().map((n, i) =>
      i >= 5 && i <= 9
        ? { ...n, text: "и снова без точки,", trailingStrength: 0.4, leadingStrength: 0.4 }
        : n
    );
    // payoff and end both sit inside the weak run; forward slack (3s) cannot
    // reach node 10 (17.8s away from node 6's end), backward finds nothing >= payoff
    const r = snapNodes(
      verdict({ startNode: 2, payoffNode: 6, endNode: 6, hookStartNode: 5, hookEndNode: 6 }),
      nodes,
      cfg
    );
    expect(r).toEqual({ ok: false, reason: "no_clean_end" });
  });

  it("compresses >90s clips from the start along strong boundaries, keeping the hook", () => {
    const nodes: SentenceNode[] = Array.from({ length: 60 }, (_, i) => ({
      index: i,
      start: i * 2,
      end: i * 2 + 1.9,
      text: `S${i}.`,
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
