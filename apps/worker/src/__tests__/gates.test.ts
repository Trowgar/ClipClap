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
  it("passes valid in-range word-bearing evidence with nothing flagged", () => {
    expect(evidenceGate(verdict({}), nodes())).toEqual({ ok: true, outOfRange: [] });
  });

  it("accepts opaque evidence nodes - segment text is real, only word timings are not", () => {
    expect(
      evidenceGate(verdict({ endNode: 9, descriptionEvidenceNodes: [8] }), nodes())
    ).toEqual({ ok: true, outOfRange: [] });
  });

  // ---- PROTOCOL FAILURES. Each of these is the critic breaking the contract,
  // and each must still cost the whole clip. ------------------------------------
  it("drops an ungrounded verdict", () => {
    expect(evidenceGate(verdict({ grounded: false }), nodes())).toEqual({
      ok: false,
      reason: "critic_ungrounded",
    });
  });
  it("drops a verdict the critic itself calls not self-contained", () => {
    expect(evidenceGate(verdict({ selfContained: false }), nodes())).toEqual({
      ok: false,
      reason: "not_self_contained",
    });
  });
  it("drops empty or absent title evidence", () => {
    expect(evidenceGate(verdict({ titleEvidenceNodes: [] }), nodes())).toEqual({
      ok: false,
      reason: "title_evidence_missing",
    });
    expect(
      evidenceGate(verdict({ titleEvidenceNodes: null as unknown as number[] }), nodes())
    ).toEqual({ ok: false, reason: "title_evidence_missing" });
  });
  it("drops empty or absent description evidence", () => {
    expect(evidenceGate(verdict({ descriptionEvidenceNodes: [] }), nodes())).toEqual({
      ok: false,
      reason: "description_evidence_missing",
    });
    expect(
      evidenceGate(
        verdict({ descriptionEvidenceNodes: null as unknown as number[] }),
        nodes()
      )
    ).toEqual({ ok: false, reason: "description_evidence_missing" });
  });
  it("drops a citation that is not an integer node index", () => {
    expect(evidenceGate(verdict({ titleEvidenceNodes: [3.5] }), nodes())).toEqual({
      ok: false,
      reason: "title_evidence_invalid",
    });
    expect(
      evidenceGate(verdict({ descriptionEvidenceNodes: [Number.NaN] }), nodes())
    ).toEqual({ ok: false, reason: "description_evidence_invalid" });
  });
  it("drops a citation that names no node in the graph", () => {
    expect(evidenceGate(verdict({ titleEvidenceNodes: [99] }), nodes())).toEqual({
      ok: false,
      reason: "title_evidence_invalid",
    });
    expect(evidenceGate(verdict({ descriptionEvidenceNodes: [-1] }), nodes())).toEqual({
      ok: false,
      reason: "description_evidence_invalid",
    });
  });
  it("calls a citation outside the GRAPH invalid, never merely out of range", () => {
    // 99 is both past endNode and past the last node. The graph check has to win:
    // "invalid" is fatal and "out of range" no longer is, so the order of these
    // two tests is the difference between dropping a protocol violation and
    // shipping a clip whose citation indexes nothing.
    const r = evidenceGate(verdict({ startNode: 2, endNode: 5, titleEvidenceNodes: [99] }), nodes());
    expect(r).toEqual({ ok: false, reason: "title_evidence_invalid" });
  });

  // ---- OUT OF RANGE. Reported, never fatal: the clip goes to snap and
  // regroundCopy repairs the copy against the range that actually ships. --------
  it("reports out-of-range title evidence without costing the clip", () => {
    // sitcom-friends c15: the critic moved start_node to 639 and left the
    // description citing 636 - its own bookkeeping lagging its own range edit.
    expect(evidenceGate(verdict({ titleEvidenceNodes: [7] }), nodes())).toEqual({
      ok: true,
      outOfRange: ["title"],
    });
  });
  it("reports out-of-range description evidence without costing the clip", () => {
    expect(evidenceGate(verdict({ descriptionEvidenceNodes: [7] }), nodes())).toEqual({
      ok: true,
      outOfRange: ["description"],
    });
  });
  it("reports both fields when both drifted, in field order", () => {
    expect(
      evidenceGate(
        verdict({ titleEvidenceNodes: [0], descriptionEvidenceNodes: [9] }),
        nodes()
      )
    ).toEqual({ ok: true, outOfRange: ["title", "description"] });
  });
  it("reports a field ONCE however many of its citations drifted", () => {
    expect(
      evidenceGate(verdict({ titleEvidenceNodes: [0, 3, 7, 9] }), nodes())
    ).toEqual({ ok: true, outOfRange: ["title"] });
  });
  it("keeps the clip even when the citation is nowhere near it", () => {
    // A citation this far out is a lost premise, not a boundary artefact - and
    // the answer is still regroundCopy replacing the copy, not losing the moment.
    expect(
      evidenceGate(
        verdict({ startNode: 7, endNode: 9, titleEvidenceNodes: [0], descriptionEvidenceNodes: [0] }),
        nodes()
      )
    ).toEqual({ ok: true, outOfRange: ["title", "description"] });
  });

  it("treats both range endpoints as inside", () => {
    // startNode 2, endNode 5 - the boundary nodes themselves are the clip's own
    // first and last sentence and are the most natural thing for copy to cite.
    expect(
      evidenceGate(
        verdict({ titleEvidenceNodes: [2], descriptionEvidenceNodes: [5] }),
        nodes()
      )
    ).toEqual({ ok: true, outOfRange: [] });
  });
  it("flags the node just outside either endpoint", () => {
    expect(evidenceGate(verdict({ titleEvidenceNodes: [1] }), nodes())).toEqual({
      ok: true,
      outOfRange: ["title"],
    });
    expect(evidenceGate(verdict({ titleEvidenceNodes: [6] }), nodes())).toEqual({
      ok: true,
      outOfRange: ["title"],
    });
  });

  it("still reaches the description's protocol check past a drifted title", () => {
    // The old gate returned on the FIRST out-of-range citation, so a verdict that
    // was both drifted AND malformed reported the drift. Now the drift is not a
    // verdict at all, and the malformed half must still be found.
    expect(
      evidenceGate(
        verdict({ titleEvidenceNodes: [7], descriptionEvidenceNodes: [] }),
        nodes()
      )
    ).toEqual({ ok: false, reason: "description_evidence_missing" });
    expect(
      evidenceGate(
        verdict({ titleEvidenceNodes: [7], descriptionEvidenceNodes: [42] }),
        nodes()
      )
    ).toEqual({ ok: false, reason: "description_evidence_invalid" });
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
