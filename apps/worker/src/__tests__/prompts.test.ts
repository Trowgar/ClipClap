import { describe, expect, it } from "vitest";
import { criticCandidateBlock } from "../analyze-v2/prompts";
import { isCleanStart } from "../analyze-v2/sentence-graph";
import type { MergedCandidate, SentenceNode } from "../analyze-v2/types";

function node(i: number, over: Partial<SentenceNode> = {}): SentenceNode {
  return {
    index: i,
    start: i * 5,
    end: i * 5 + 4.5,
    text: `узел ${i}.`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
    ...over,
  };
}

describe("isCleanStart", () => {
  it("accepts strong leading boundaries and post-opaque starts, rejects mid-flow", () => {
    const nodes = [
      node(0),
      node(1, { leadingStrength: 0.4 }),
      node(2, { hasWords: false, leadingStrength: 0.4 }),
      node(3, { leadingStrength: 0.2 }), // follows opaque node 2
    ];
    expect(isCleanStart(nodes, 0)).toBe(true);
    expect(isCleanStart(nodes, 1)).toBe(false);
    expect(isCleanStart(nodes, 3)).toBe(true);
    expect(isCleanStart(nodes, 99)).toBe(false);
    // an opaque node is never a valid start, even with a strong leading boundary
    expect(isCleanStart([node(0), node(1, { hasWords: false })], 1)).toBe(false);
  });
});

describe("criticCandidateBlock", () => {
  it("marks clean-start lines with ¶ and mid-flow lines with padding", () => {
    const nodes = [node(0), node(1, { leadingStrength: 0.4 }), node(2)];
    const candidate: MergedCandidate = {
      id: "c0",
      startNode: 0,
      endNode: 2,
      payoffNode: 2,
      interest: 0.7,
      type: "story",
      windowIndex: 0,
    };
    const block = criticCandidateBlock(candidate, nodes);
    const lines = block.split("\n");
    // match node lines by "#<idx> [" - the candidate header also contains #0
    expect(lines.find((l) => l.includes("#0 ["))!.startsWith("¶ ")).toBe(true);
    expect(lines.find((l) => l.includes("#1 ["))!.startsWith("  ")).toBe(true);
    expect(lines.find((l) => l.includes("#2 ["))!.startsWith("¶ ")).toBe(true);
  });
});
