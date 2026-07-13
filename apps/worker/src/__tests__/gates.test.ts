import { describe, expect, it } from "vitest";
import { evidenceGate, snippetFallbackCopy, lexicalOverlap } from "../analyze-v2/gates";
import type { CriticVerdict, SentenceNode } from "../analyze-v2/types";

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
  it("fails when evidence is out of clip range", () => {
    expect(evidenceGate(verdict({ titleEvidenceNodes: [7] }), nodes()).ok).toBe(false);
  });
  it("fails when evidence is empty or points at an opaque node", () => {
    expect(evidenceGate(verdict({ titleEvidenceNodes: [] }), nodes()).ok).toBe(false);
    expect(
      evidenceGate(verdict({ endNode: 9, descriptionEvidenceNodes: [8] }), nodes()).ok
    ).toBe(false);
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

describe("lexicalOverlap", () => {
  it("returns a 0..1 telemetry ratio, never used as a gate", () => {
    const ratio = lexicalOverlap("поставил кон", "и тут он всё поставил на кон.");
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });
});
