import { describe, expect, it } from "vitest";
import { restoreScannerQuestionSetup } from "../analyze-v2/scanner-setup-protection";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { CriticVerdict, MergedCandidate, SentenceNode, SnappedClip } from "../analyze-v2/types";

const nodes: SentenceNode[] = [
  { index: 0, start: 6, end: 10.3, text: "Do you speak English?", hasWords: false, hasReliableStart: true, trailingStrength: 0.2, leadingStrength: 1 },
  { index: 1, start: 10.9, end: 11.7, text: "No, sorry.", hasWords: false, trailingStrength: 0.2, leadingStrength: 0.2 },
  { index: 2, start: 12.1, end: 17.5, text: "My car broke down.", hasWords: true, trailingStrength: 1, leadingStrength: 1 },
  { index: 3, start: 18.3, end: 21.5, text: "I cannot understand you.", hasWords: true, trailingStrength: 1, leadingStrength: 1 },
];
const candidate: MergedCandidate = {
  id: "c0", startNode: 0, endNode: 3, payoffNode: 3,
  interest: 0.7, type: "conflict", windowIndex: 0,
};
const verdict = (): CriticVerdict => ({
  id: "c0", keep: true, score: 0.72, grounded: true, selfContained: true,
  startNode: 2, payoffNode: 3, endNode: 3, hookStartNode: 2, hookEndNode: 3,
  title: "Wrong language", description: "A request fails.",
  titleEvidenceNodes: [2, 3], descriptionEvidenceNodes: [2, 3], language: "en",
});
const clip = (): SnappedClip => ({
  verdict: verdict(), startSec: 11.95, endSec: 21.8,
  finalStartNode: 2, finalEndNode: 3, hookStartSec: 12.1,
  hookEndSec: 21.5, payoffSec: 21.5, shortMoment: false,
});

describe("restoreScannerQuestionSetup", () => {
  it("restores the short scanner question plus answer before a kept cut", () => {
    const value = clip();
    expect(restoreScannerQuestionSetup(value, candidate, nodes, loadAnalyzeConfig({}))).toBe(true);
    expect(value.finalStartNode).toBe(0);
    expect(value.startSec).toBe(5.85);
    expect(value.boundaryConfidence).toBe("segment");
  });

  it("does not restore broad or non-question context", () => {
    const broad = clip();
    broad.finalStartNode = 3;
    expect(restoreScannerQuestionSetup(broad, candidate, nodes, loadAnalyzeConfig({}))).toBe(false);
    const plainNodes = nodes.map((node, index) => index === 0 ? { ...node, text: "He speaks English." } : node);
    const plain = clip();
    expect(restoreScannerQuestionSetup(plain, candidate, plainNodes, loadAnalyzeConfig({}))).toBe(false);
  });

  it("does not create an opaque interior start without a reliable boundary", () => {
    const unsafeNodes = [
      { ...nodes[0], text: "Earlier sentence.", hasWords: true },
      { ...nodes[1], text: "Do you speak English?", hasWords: false },
      nodes[2],
      nodes[3],
    ];
    const unsafeCandidate = { ...candidate, startNode: 1 };
    const value = clip();
    expect(restoreScannerQuestionSetup(value, unsafeCandidate, unsafeNodes, loadAnalyzeConfig({}))).toBe(false);
  });

  it("does not restore setup across a scene gap", () => {
    const gappedNodes = [
      { ...nodes[0], end: 6.5 },
      { ...nodes[1], start: 11.6, end: 11.8 },
      nodes[2],
      nodes[3],
    ];
    const value = clip();
    expect(restoreScannerQuestionSetup(value, candidate, gappedNodes, loadAnalyzeConfig({}))).toBe(false);
  });

  it("does not infer a reliable onset merely because an opaque node is first", () => {
    const uncertified = nodes.map((node, index) => index === 0
      ? { ...node, hasReliableStart: undefined }
      : node);
    expect(restoreScannerQuestionSetup(clip(), candidate, uncertified, loadAnalyzeConfig({}))).toBe(false);
  });
});
