import { describe, expect, it } from "vitest";
import { buildSentenceGraph } from "../analyze-v2/sentence-graph";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { WhisperSegment } from "@clipclap/shared";

const cfg = loadAnalyzeConfig({});

function seg(
  start: number,
  end: number,
  words: Array<[string, number, number]>
): WhisperSegment {
  return {
    start,
    end,
    text: words.map(([t]) => t).join(" "),
    words: words.map(([text, s, e]) => ({ text, start: s, end: e })),
  };
}

describe("buildSentenceGraph", () => {
  it("closes a node on terminal punctuation with strength 1.0 and starts the next", () => {
    const nodes = buildSentenceGraph(
      [seg(0, 4, [["Hello", 0, 0.5], ["world.", 0.6, 1.0], ["Next", 1.2, 1.6], ["thought", 1.7, 2.2]])],
      cfg
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0].text).toBe("Hello world.");
    expect(nodes[0].trailingStrength).toBe(1.0);
    expect(nodes[0].end).toBe(1.0); // real word offset
    expect(nodes[1].start).toBe(1.2); // real word onset
    expect(nodes[1].leadingStrength).toBe(1.0);
  });

  it("closes a node on a silence gap >= GAP_SENTENCE with strength 0.8", () => {
    const nodes = buildSentenceGraph(
      [seg(0, 5, [["one", 0, 0.4], ["two", 0.5, 0.9], ["three", 2.0, 2.4]])],
      cfg
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0].trailingStrength).toBe(0.8);
    expect(nodes[1].start).toBe(2.0);
  });

  it("emits an opaque node for a segment without words", () => {
    const nodes = buildSentenceGraph(
      [{ start: 0, end: 6, text: "[music]" }],
      cfg
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].hasWords).toBe(false);
    expect(nodes[0].trailingStrength).toBe(0.2);
  });

  it("treats non-monotonic word times as opaque", () => {
    const nodes = buildSentenceGraph(
      [seg(0, 4, [["ok", 0, 0.5], ["broken", 0.4, 0.2]])],
      cfg
    );
    expect(nodes.every((n) => n.hasWords === false)).toBe(true);
  });

  it("force-splits nodes longer than NODE_MAX_SEC and indexes monotonically", () => {
    const words: Array<[string, number, number]> = [];
    for (let i = 0; i < 40; i++) words.push([`w${i}`, i * 0.4, i * 0.4 + 0.3]);
    const nodes = buildSentenceGraph([seg(0, 16, words)], cfg);
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.every((n) => n.end - n.start <= cfg.nodeMaxSec + 0.5)).toBe(true);
    nodes.forEach((n, i) => expect(n.index).toBe(i));
  });
});
