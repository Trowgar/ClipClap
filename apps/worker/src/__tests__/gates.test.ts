import { describe, expect, it } from "vitest";
import {
  evidenceGate,
  regroundCopy,
  snippetFallbackCopy,
  lexicalOverlap,
} from "../analyze-v2/gates";
import type { CriticVerdict, SentenceNode, SnappedClip } from "../analyze-v2/types";

function nodes(): SentenceNode[] {
  return Array.from({ length: 10 }, (_, i) => ({
    index: i,
    start: i * 2,
    end: i * 2 + 1.8,
    text: i === 4 ? "и тут он всё поставил на кон." : `предложение ${i}.`,
    hasWords: i !== 8, // node 8 is opaque
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
    payoffNode: 4,
    endNode: 5,
    hookStartNode: 4,
    hookEndNode: 4,
    title: "Он поставил всё на кон",
    description: "Стример рискует всем в одном моменте.",
    titleEvidenceNodes: [4],
    descriptionEvidenceNodes: [4],
    language: "ru",
    ...p,
  };
}

describe("evidenceGate", () => {
  it("passes valid in-range word-bearing evidence", () => {
    expect(evidenceGate(verdict({}), nodes()).ok).toBe(true);
  });
  it("fails when evidence is out of clip range, with a named reason", () => {
    const r = evidenceGate(verdict({ titleEvidenceNodes: [7] }), nodes());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("title_evidence_out_of_range");
  });
  it("fails when evidence is empty", () => {
    expect(evidenceGate(verdict({ titleEvidenceNodes: [] }), nodes()).ok).toBe(false);
  });
  it("accepts opaque evidence nodes - segment text is real, only word timings are not", () => {
    expect(
      evidenceGate(verdict({ endNode: 9, descriptionEvidenceNodes: [8] }), nodes()).ok
    ).toBe(true);
  });
  it("fails when critic itself says grounded=false or selfContained=false", () => {
    expect(evidenceGate(verdict({ grounded: false }), nodes()).ok).toBe(false);
    expect(evidenceGate(verdict({ selfContained: false }), nodes()).ok).toBe(false);
  });
});

describe("snippetFallbackCopy", () => {
  it("builds grounded copy from the clip's own words in the clip's language", () => {
    const copy = snippetFallbackCopy(nodes(), 4, 5);
    expect(copy.title).toContain("и тут он");
    expect(copy.title.length).toBeLessThanOrEqual(70);
    expect(copy.description.length).toBeGreaterThan(0);
  });
});

describe("regroundCopy", () => {
  /** A shipped clip whose FINAL range is [from..to] - the range snap and any
   *  finalizer trim left behind, which is the only range the viewer hears. */
  function clip(
    from: number,
    to: number,
    evidence: Partial<Pick<CriticVerdict, "titleEvidenceNodes" | "descriptionEvidenceNodes">>
  ): SnappedClip {
    return {
      verdict: verdict({ startNode: from, endNode: to, ...evidence }),
      startSec: from * 2,
      endSec: to * 2 + 1.8,
      hookStartSec: from * 2,
      hookEndSec: from * 2 + 1.8,
      payoffSec: to * 2 + 1.8,
      shortMoment: false,
      finalStartNode: from,
      finalEndNode: to,
    };
  }

  it("leaves copy alone when every citation is inside the range that shipped", () => {
    const c = clip(2, 5, { titleEvidenceNodes: [4], descriptionEvidenceNodes: [3, 5] });
    const r = regroundCopy(c, nodes());
    expect(r.regrounded).toEqual([]);
    expect(r.clip).toBe(c);
  });

  it("tolerates a citation just outside - a boundary artefact, not a lost premise", () => {
    // podcast-ecology, the finalizer's only applied trim (332 -> 334): the title
    // "Плейстоценовый парк..." keeps citing 332 while still being fully grounded
    // in 334 and 348, both inside. Two nodes out is the same slack
    // widenRangeToEvidence uses to pull a boundary OUT before snap.
    const c = clip(4, 7, { titleEvidenceNodes: [2, 4, 6] });
    expect(regroundCopy(c, nodes()).regrounded).toEqual([]);
  });

  it("re-grounds a description whose premise the boundary move deleted", () => {
    // Job cms2c8ahm, "Самые живучие на планете": compression moved the start
    // three nodes and 24.8s forward, and the shipped description narrated node
    // 804 - the PREVIOUS clip's ending - because the evidence gate had already
    // run and nothing re-checked it.
    const c = clip(4, 8, { descriptionEvidenceNodes: [1, 5, 7] });
    const r = regroundCopy(c, nodes());
    expect(r.regrounded).toEqual(["description"]);
    expect(r.clip.verdict.description).not.toBe(c.verdict.description);
    // verbatim from inside the range, so it is grounded and correctly-languaged
    // by construction, and the citations now name where it came from
    for (const i of r.clip.verdict.descriptionEvidenceNodes) {
      expect(i).toBeGreaterThanOrEqual(4);
      expect(i).toBeLessThanOrEqual(8);
    }
    // the title was never damaged and must not be touched
    expect(r.clip.verdict.title).toBe(c.verdict.title);
    expect(r.clip.verdict.titleEvidenceNodes).toEqual(c.verdict.titleEvidenceNodes);
  });

  it("re-grounds the title on its own evidence, independently of the description", () => {
    const c = clip(4, 8, { titleEvidenceNodes: [0], descriptionEvidenceNodes: [5] });
    const r = regroundCopy(c, nodes());
    expect(r.regrounded).toEqual(["title"]);
    expect(r.clip.verdict.title).not.toBe(c.verdict.title);
    expect(r.clip.verdict.description).toBe(c.verdict.description);
  });

  it("never leaves a clip without citations, even when the range is all opaque", () => {
    const opaque = nodes().map((n) => ({ ...n, hasWords: false }));
    const c = clip(6, 7, { titleEvidenceNodes: [0], descriptionEvidenceNodes: [0] });
    const r = regroundCopy(c, opaque);
    expect(r.clip.verdict.titleEvidenceNodes.length).toBeGreaterThan(0);
    expect(r.clip.verdict.descriptionEvidenceNodes.length).toBeGreaterThan(0);
  });

  it("re-grounds against the FINAL range, not the critic's proposal", () => {
    // The whole defect in one assertion: verdict.startNode still says 1, the
    // clip actually starts at 4, and the citation on node 1 is stale.
    const c = clip(4, 8, { descriptionEvidenceNodes: [1] });
    c.verdict.startNode = 1;
    expect(regroundCopy(c, nodes()).regrounded).toEqual(["description"]);
  });
});

describe("lexicalOverlap", () => {
  it("returns a 0..1 telemetry ratio, never used as a gate", () => {
    const ratio = lexicalOverlap("поставил кон", "и тут он всё поставил на кон.");
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });
});
