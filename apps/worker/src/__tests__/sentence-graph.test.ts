import { describe, expect, it } from "vitest";
import { anaphoricRunEnd, buildSentenceGraph } from "../analyze-v2/sentence-graph";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { SentenceNode } from "../analyze-v2/types";
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

  it("uses the max word end for node end when word timings nest", () => {
    // alpha fully contains beta - starts are monotonic and spans are short,
    // so the words pass the reliability check, but the node end must not
    // chop alpha's tail by using the last word's smaller end
    const nodes = buildSentenceGraph(
      [seg(0, 3, [["alpha", 0, 2.0], ["beta", 1.0, 1.5], ["gamma.", 2.1, 2.6]])],
      cfg
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0].end).toBeGreaterThanOrEqual(2.0);
    expect(nodes[1].start).toBe(2.1);
  });

  it("sorts out-of-order segments so node starts are non-decreasing", () => {
    const nodes = buildSentenceGraph(
      [
        seg(5, 8, [["later.", 5, 5.5]]),
        seg(0, 2, [["first.", 0, 0.5]]),
      ],
      cfg
    );
    expect(nodes).toHaveLength(2);
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i].start).toBeGreaterThanOrEqual(nodes[i - 1].start);
    }
  });

  it("folds chains of 3+ sub-0.4s fragments into one node", () => {
    const nodes = buildSentenceGraph(
      [seg(0, 1, [["A.", 0, 0.15], ["B.", 0.2, 0.35], ["C.", 0.4, 0.55]])],
      cfg
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].text).toBe("A. B. C.");
    expect(nodes[0].end - nodes[0].start).toBeGreaterThanOrEqual(0.4);
  });

  it("force-splits at the largest interior gap, not at the crossing word", () => {
    // 17 words tightly packed (0.05s gaps), then a 0.25s gap (below GAP_PHRASE,
    // so it does not close a phrase), then 23 more tightly packed words. The
    // run crosses NODE_MAX_SEC deep inside the second block; the split must
    // land on the 0.25s gap, not on the word where the length limit was hit.
    const words: Array<[string, number, number]> = [];
    for (let i = 0; i < 17; i++) words.push([`a${i}`, i * 0.4, i * 0.4 + 0.35]);
    for (let i = 0; i < 23; i++)
      words.push([`b${i}`, 7.0 + i * 0.4, 7.0 + i * 0.4 + 0.35]);
    const nodes = buildSentenceGraph([seg(0, 17, words)], cfg);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].end).toBeCloseTo(6.75, 5);
    expect(nodes[0].trailingStrength).toBe(0.3);
    expect(nodes[1].start).toBeCloseTo(7.0, 5);
  });

  it("closes a node on clause punctuation with strength 0.4", () => {
    const nodes = buildSentenceGraph(
      [seg(0, 2, [["Well,", 0, 0.4], ["yes", 0.5, 0.9]])],
      cfg
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0].trailingStrength).toBe(0.4);
    expect(nodes[1].leadingStrength).toBe(0.4);
  });

  it("closes a node on a gap >= GAP_PHRASE with strength 0.4", () => {
    const nodes = buildSentenceGraph(
      [seg(0, 2, [["one", 0, 0.5], ["two", 0.85, 1.3]])],
      cfg
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0].trailingStrength).toBe(0.4);
  });

  it("treats non-monotonic word starts as opaque even when each word is valid", () => {
    const nodes = buildSentenceGraph(
      [seg(0, 2, [["a", 1.0, 1.5], ["b", 0.5, 0.9]])],
      cfg
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].hasWords).toBe(false);
  });

  it("treats a single word spanning more than 3s as opaque", () => {
    const nodes = buildSentenceGraph([seg(0, 4, [["loooong", 0, 3.5]])], cfg);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].hasWords).toBe(false);
    expect(nodes[0].trailingStrength).toBe(0.2);
  });
});

/**
 * anaphoricRunEnd - the detector behind snap's end rule. The definition and its
 * two thresholds were derived by measuring candidate runs across both fixture
 * transcripts (1747 nodes, 1193 word-bearing, 788 clean starts):
 *
 *   3+ beats, onset stem >= 4 chars   1 run per episode   the real figure below
 *   2+ beats, same stem rule          8 and 9 per episode  half of them are
 *                                     transcription echo, crosstalk and
 *                                     self-repair, not rhetoric
 *   3+ beats, stem floor 3 chars      1 and 2 per episode  the extra is noise
 *
 * The onset is compared by STEM, not by string: the real case runs "Планета /
 * Планета / Планета / Планете" and an exact match sees three beats where the
 * speaker built four.
 */
describe("anaphoricRunEnd", () => {
  function nodesFrom(texts: string[]): SentenceNode[] {
    return texts.map((text, index) => ({
      index,
      start: index * 3,
      end: index * 3 + 2,
      text,
      hasWords: true,
      leadingStrength: 1.0,
      trailingStrength: 1.0,
    }));
  }

  /** Graph nodes 47-50 of job cms2c8ahm - the owner's real case. */
  const PLANETA = [
    "Планета еще и не такое видала",
    "Планета видала вулканические катастрофы",
    "Планета видала астероидные импакты",
    "Планете 4 5 миллиарда лет",
  ];

  it("matches an inflected onset - Планета/Планете is one lemma", () => {
    const nodes = nodesFrom(PLANETA);
    expect(anaphoricRunEnd(nodes, 0)).toBe(3);
    expect(anaphoricRunEnd(nodes, 1)).toBe(3);
    expect(anaphoricRunEnd(nodes, 2)).toBe(3);
  });

  it("returns null on the last beat - that ending is already correct", () => {
    expect(anaphoricRunEnd(nodesFrom(PLANETA), 3)).toBeNull();
  });

  it("refuses a pair", () => {
    const nodes = nodesFrom([PLANETA[0], PLANETA[1], "Вулканы взрывались много раз"]);
    expect(anaphoricRunEnd(nodes, 0)).toBeNull();
  });

  it("refuses onsets shorter than the stem floor - Это/Это/Это is not a figure", () => {
    expect(anaphoricRunEnd(nodesFrom(["Это еще не все", "Это было давно", "Это уже неважно"]), 0)).toBeNull();
    expect(anaphoricRunEnd(nodesFrom(["Как же так", "Как это вышло", "Как обычно"]), 0)).toBeNull();
  });

  it("skips discourse particles to find the onset", () => {
    // The two fixture transcripts render the same sentence with and without a
    // leading "Ну да" / "Да А" - an anchored first-token test decides
    // differently on two runs of the same audio.
    const nodes = nodesFrom(["Ну Планета еще и не такое видала", ...PLANETA.slice(1)]);
    expect(anaphoricRunEnd(nodes, 0)).toBe(3);
  });

  it("refuses stems that only share a prefix - планета is not планетарный", () => {
    const nodes = nodesFrom([
      "Планета еще и не такое видала",
      "Планетарные системы бывают разные",
      "Планетология это наука",
    ]);
    expect(anaphoricRunEnd(nodes, 0)).toBeNull();
  });

  it("breaks a run on a member that is not a sentence onset", () => {
    // A lowercase continuation is a fragment of the previous sentence, not a
    // beat - isCleanStart is the same test snap and the critic markers use.
    const nodes = nodesFrom(PLANETA).map((n, i) =>
      i === 2 ? { ...n, text: "планета видала астероидные импакты", leadingStrength: 0.4 } : n
    );
    expect(anaphoricRunEnd(nodes, 0)).toBeNull();
  });

  it("ignores an opaque node - no reliable onset to build a beat on", () => {
    const nodes = nodesFrom(PLANETA).map((n, i) => (i === 1 ? { ...n, hasWords: false } : n));
    expect(anaphoricRunEnd(nodes, 0)).toBeNull();
  });
});
