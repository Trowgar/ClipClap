import { describe, expect, it } from "vitest";
import {
  buildSentenceGraph,
  endsOnSentenceMark,
  isCleanEnd,
} from "../analyze-v2/sentence-graph";
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

// ---------------------------------------------------------------------------
// isCleanEnd / endsOnSentenceMark
// ---------------------------------------------------------------------------

/** Nodes built directly rather than through buildSentenceGraph: these cases are
 *  about what isCleanEnd DECIDES, and driving them through the builder would
 *  make every one of them depend on gap arithmetic that is not under test. */
function node(i: number, over: Partial<SentenceNode> = {}): SentenceNode {
  return {
    index: i,
    start: i * 2,
    end: i * 2 + 1.8,
    text: `Sentence ${i}.`,
    hasWords: true,
    trailingStrength: 0.8,
    leadingStrength: 0.8,
    ...over,
  };
}

describe("endsOnSentenceMark", () => {
  // The guard that decides whether an opaque node may END a clip. It reads
  // Whisper's raw segment text, which is the ONLY place punctuation survives in
  // these transcripts, and it refuses 46-52 opaque nodes per eval fixture - so
  // it is load-bearing rather than decorative and each branch is pinned.
  it("accepts the sentence-final marks", () => {
    for (const text of ["готово.", "готово!", "готово?", "готово…", "終わり。", "終わり！", "終わり？"]) {
      expect(endsOnSentenceMark(text), text).toBe(true);
    }
  });

  it("accepts a mark hiding behind closing quotes or brackets", () => {
    expect(endsOnSentenceMark('он сказал: "Да!"')).toBe(true);
    expect(endsOnSentenceMark("(и на этом всё.)")).toBe(true);
    expect(endsOnSentenceMark("конец.  ")).toBe(true);
  });

  it("refuses clause punctuation and a bare unterminated clause", () => {
    // the real answer-arc #847 shape: a comma-ended opaque node mid-enumeration
    expect(endsOnSentenceMark("И получили сразу букет проблем и с шеей, и с поясницей,")).toBe(false);
    expect(endsOnSentenceMark("нагрузки на него были")).toBe(false);
    expect(endsOnSentenceMark("что-то там;")).toBe(false);
    expect(endsOnSentenceMark("")).toBe(false);
    expect(endsOnSentenceMark("   ")).toBe(false);
  });

  it("refuses a terminal mark that is not at the end", () => {
    expect(endsOnSentenceMark("Да. И ещё одно слово")).toBe(false);
  });
});

describe("isCleanEnd", () => {
  it("returns false for an index outside the graph", () => {
    expect(isCleanEnd([node(0)], 5)).toBe(false);
    expect(isCleanEnd([node(0)], -1)).toBe(false);
  });

  it("accepts a terminal trailing boundary whatever follows", () => {
    // short circuit #1, and it must outrank the opaque test below: a node that
    // closed on a full stop has ended its sentence by construction.
    const nodes = [
      node(0, { trailingStrength: 1.0 }),
      node(1, { hasWords: false, text: "любая биосфера обречена, и дальше." }),
    ];
    expect(isCleanEnd(nodes, 0)).toBe(true);
  });

  it("accepts the last node in the graph", () => {
    // short circuit #2: there is no continuation to be cut off from.
    expect(isCleanEnd([node(0, { trailingStrength: 0.4 })], 0)).toBe(true);
  });

  // -- the defect ----------------------------------------------------------
  it("REFUSES an end whose opaque successor starts mid-clause", () => {
    // podcast-ecology #576/#577, the shipped defect: "...космические корабли,"
    // certified clean purely because the next node was opaque, while that opaque
    // node CARRIES the missing predicate. hasWords=false means Whisper's word
    // timings were unreliable (laughter, crosstalk), not that speech stopped.
    const nodes = [
      node(0, { text: "Без разумного вида строящего космические корабли", trailingStrength: 0.8 }),
      node(1, {
        hasWords: false,
        text: "любая биосфера обречена, срок ее жизни ограничен сроком жизни звезды.",
      }),
      node(2),
    ];
    expect(isCleanEnd(nodes, 0)).toBe(false);
  });

  it("still accepts an end whose opaque successor opens a new sentence", () => {
    // the case the old rule was written for and which must survive: speech ends,
    // music or an unintelligible stretch follows, a new thought begins after it.
    const nodes = [
      node(0, { trailingStrength: 0.8 }),
      node(1, { hasWords: false, text: "То есть разумный вид это потенциал бессмертия." }),
      node(2),
    ];
    expect(isCleanEnd(nodes, 0)).toBe(true);
  });

  it("accepts an opaque successor carrying no letters at all", () => {
    // pure music/silence: Whisper emits "" or "[Музыка]". There is no
    // continuation evidence, and absence of evidence must not become a refusal.
    for (const text of ["", "   ", "[Музыка]", "♪♪♪", "..."]) {
      const nodes = [node(0, { trailingStrength: 0.8 }), node(1, { hasWords: false, text }), node(2)];
      expect(isCleanEnd(nodes, 0), JSON.stringify(text)).toBe(true);
    }
  });

  it("reads only the FIRST node of an opaque run, which is where the continuation would be", () => {
    // Decided semantics, not an accident. A run of opaque nodes is consulted at
    // its head: if speech continued into the gap at all it continued THERE, and
    // a later opaque node opening lowercase is a continuation of the gap's own
    // speech, not of the clip's last word.
    const dirtyHead = [
      node(0, { trailingStrength: 0.8 }),
      node(1, { hasWords: false, text: "любая биосфера обречена." }),
      node(2, { hasWords: false, text: "Новая мысль." }),
      node(3),
    ];
    expect(isCleanEnd(dirtyHead, 0)).toBe(false);

    const cleanHead = [
      node(0, { trailingStrength: 0.8 }),
      node(1, { hasWords: false, text: "Новая мысль." }),
      node(2, { hasWords: false, text: "и продолжение этой мысли." }),
      node(3),
    ];
    expect(isCleanEnd(cleanHead, 0)).toBe(true);
  });

  it("applies the same test when the opaque successor is the last node in the graph", () => {
    const dirty = [
      node(0, { trailingStrength: 0.8 }),
      node(1, { hasWords: false, text: "любая биосфера обречена." }),
    ];
    expect(isCleanEnd(dirty, 0)).toBe(false);
    const clean = [
      node(0, { trailingStrength: 0.8 }),
      node(1, { hasWords: false, text: "Новая мысль." }),
    ];
    expect(isCleanEnd(clean, 0)).toBe(true);
  });

  // -- the word-bearing path, which must not move ---------------------------
  it("delegates to isCleanStart when the next node is word-bearing", () => {
    const lowercase = [
      node(0, { trailingStrength: 0.4 }),
      node(1, { text: "а искала ты его потому", leadingStrength: 0.4 }),
    ];
    expect(isCleanEnd(lowercase, 0)).toBe(false);

    const uppercase = [
      node(0, { trailingStrength: 0.8 }),
      node(1, { text: "Новое предложение", leadingStrength: 0.8 }),
    ];
    expect(isCleanEnd(uppercase, 0)).toBe(true);
  });

  it("does not consult the opaque node's own strengths, only its text", () => {
    // trailingStrength on an opaque node is a hardcoded 0.2 in the builder and
    // says nothing about whether speech continued.
    const nodes = [
      node(0, { trailingStrength: 0.8 }),
      node(1, { hasWords: false, text: "любая биосфера обречена.", trailingStrength: 1.0, leadingStrength: 1.0 }),
      node(2),
    ];
    expect(isCleanEnd(nodes, 0)).toBe(false);
  });
});
