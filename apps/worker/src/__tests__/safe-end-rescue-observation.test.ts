import { describe, expect, it } from "vitest";
import { observeRescueCandidates } from "../analyze-v2/safe-end-rescue-observation";
import type { SafeEndRescueRecord } from "../analyze-v2/safe-end-audit";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { ArcAuditGeometryEvidence } from "../analyze-v2/arc-audit";
import type { CriticVerdict, SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});

function nodes(): SentenceNode[] {
  return [0, 1, 2].map((index) => ({
    index,
    start: index * 15,
    end: index * 15 + 15,
    text: `Sentence ${index}.`,
    hasWords: true,
    leadingStrength: 1,
    trailingStrength: 1,
  }));
}

function verdict(id: string, score: number, node = 0): CriticVerdict {
  return {
    id,
    keep: false,
    score,
    grounded: true,
    selfContained: true,
    startNode: node,
    payoffNode: node,
    endNode: node,
    hookStartNode: node,
    hookEndNode: node,
    title: "Title",
    description: "Description.",
    titleEvidenceNodes: [node],
    descriptionEvidenceNodes: [node],
    language: "en",
  };
}

function evidenceFor(record: SafeEndRescueRecord): ArcAuditGeometryEvidence {
  return {
    id: record.geometry.candidateId,
    finalStartNode: record.geometry.startNode,
    finalEndNode: record.geometry.endNode,
    startMs: record.geometry.startMs,
    endMs: record.geometry.endMs,
    flags: {
      entry: { ok: true },
      exit: { ok: true },
      standalone: { ok: true },
    },
  };
}

describe("safe-end rescue observation", () => {
  it("accounts for an unrealizable higher-ranked verdict before the selected realizable winner", () => {
    const observations = observeRescueCandidates(
      [verdict("bad", 0.9, 99), verdict("winner", 0.8)],
      nodes(),
      cfg,
      new Map(),
    );

    expect(observations.evaluated).toBe(2);
    expect(observations.records).toHaveLength(1);
    expect(observations.records[0]).toMatchObject({
      geometry: { candidateId: "winner" },
      language: "en",
      scoreRank: 2,
      selectedState: "selected",
    });
  });

  it("uses rescue score/id ordering, preserves the zero-tail geometry, and marks only its first realizable candidate selected", () => {
    const records = observeRescueCandidates(
      [verdict("b", 0.7), verdict("a", 0.7), verdict("lower", 0.6, 1)],
      nodes(),
      cfg,
      new Map(),
    ).records;

    expect(records.map((record) => [record.geometry.candidateId, record.scoreRank, record.selectedState])).toEqual([
      ["a", 1, "selected"],
      ["b", 2, "not_selected"],
      ["lower", 3, "not_selected"],
    ]);
    expect(records[0]).toMatchObject({ zeroTailHandoff: true, proposedAction: "zero_tail_handoff", arcEvidence: "stale_or_absent" });
  });

  it("uses arc flags only when their audit-time geometry exactly matches, without mutating them", () => {
    const first = observeRescueCandidates([verdict("c0", 0.7)], nodes(), cfg, new Map()).records[0];
    const clear = evidenceFor(first);
    const standing = evidenceFor(first);
    standing.flags.entry = { ok: false, defect: "mid_story" };
    const stale = { ...evidenceFor(first), startMs: first.geometry.startMs + 1 };
    const original = structuredClone(standing);

    expect(observeRescueCandidates([verdict("c0", 0.7)], nodes(), cfg, new Map([["c0", clear]])).records[0]?.arcEvidence).toBe("matching_clear");
    expect(observeRescueCandidates([verdict("c0", 0.7)], nodes(), cfg, new Map([["c0", standing]])).records[0]).toMatchObject({ arcEvidence: "matching_standing", proposedAction: "both" });
    expect(observeRescueCandidates([verdict("c0", 0.7)], nodes(), cfg, new Map([["c0", stale]])).records[0]?.arcEvidence).toBe("stale_or_absent");
    expect(standing).toEqual(original);
  });
});
