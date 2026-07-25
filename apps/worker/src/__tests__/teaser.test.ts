import { describe, expect, it } from "vitest";
import {
  montageScore,
  isTeaserCandidate,
  TEASER_MIN_RUN,
  TEASER_SHORT_WORDS,
  TEASER_MIN_ALIGNED,
} from "../analyze-v2/teaser";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { SentenceNode } from "../analyze-v2/types";

function nodes(texts: string[]): SentenceNode[] {
  return texts.map((text, i) => ({
    index: i,
    start: i * 5,
    end: i * 5 + 4.5,
    text,
    hasWords: true,
    trailingStrength: 1,
    leadingStrength: 1,
  }));
}

const cfg = { teaserWindowSec: 120, teaserRecurrenceFrac: 0.5 };

/** n distinct filler words - padding that can never match anything. */
function filler(n: number, tag = "ф"): string {
  return Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
}

describe("montageScore", () => {
  it("is 1 when the whole candidate reappears later", () => {
    const graph = nodes([
      "человек это зло для планеты земля",
      "мусорная фраза посередине",
      "человек это зло для планеты земля",
    ]);
    expect(montageScore(graph, 0, 0)).toBe(1);
  });

  it("is 0 when nothing reappears", () => {
    const graph = nodes(["уникальная мысль про экологию", "совсем другая тема разговора"]);
    expect(montageScore(graph, 0, 0)).toBe(0);
  });

  it("ignores recurrence INSIDE the candidate itself", () => {
    const graph = nodes([
      "одна и та же фраза повторяется",
      "одна и та же фраза повторяется",
      "дальше идет совершенно другой текст",
    ]);
    expect(montageScore(graph, 0, 1)).toBe(0);
  });

  it("does not count the candidate's own earlier copy - only later text", () => {
    const graph = nodes([
      "человек это зло для планеты земля",
      "заполнитель между ними",
      "человек это зло для планеты земля",
    ]);
    expect(montageScore(graph, 2, 2)).toBe(0);
  });

  it("tolerates punctuation and case differences", () => {
    const graph = nodes([
      "Человек - это ЗЛО для планеты Земля!",
      "другое",
      "человек это зло для планеты земля",
    ]);
    expect(montageScore(graph, 0, 0)).toBe(1);
  });

  it("returns 0 for text too short to carry evidence", () => {
    expect(montageScore(nodes(["да", "да"]), 0, 0)).toBe(0);
  });

  it("is 0 for an out-of-range slice", () => {
    expect(montageScore(nodes(["одна фраза здесь и сейчас"]), 5, 9)).toBe(0);
  });

  // --- what the score MEASURES ------------------------------------------------

  it("scores the share of WORDS backed by evidence, not the share of n-grams", () => {
    // 11 words; the first 5 recur verbatim. Five of eleven words are evidenced.
    // (The old 5-gram fraction called this 1/7 = 0.14 - it divided by n-gram
    // windows, which under-counts a run at the very edge of a candidate.)
    const graph = nodes([
      "человек это зло для планеты и мы все в этом виноваты",
      `${filler(3)} человек это зло для планеты ${filler(3)}`,
    ]);
    expect(montageScore(graph, 0, 0)).toBeCloseTo(5 / 11, 5);
  });

  it("sums evidence from fragments copied from DIFFERENT later places", () => {
    // A montage is a splice: each fragment comes from its own moment further on.
    // One aligned window can never cover it - the runs must add up.
    const graph = nodes([
      "первая приманка про экологию планеты земля",
      "вторая приманка про будущее цивилизации людей",
      `первая приманка про экологию планеты земля ${filler(20)}`,
      `${filler(20, "г")} вторая приманка про будущее цивилизации людей`,
    ]);
    expect(montageScore(graph, 0, 1)).toBe(1);
  });

  it(`ignores matching runs shorter than ${TEASER_MIN_RUN} words`, () => {
    expect(TEASER_MIN_RUN).toBe(5);
    // "и так далее" style filler: four words in a row recur by chance in any
    // long conversation, so four words are not evidence of a copy.
    const graph = nodes([
      "мы говорим про экологию и климат",
      `${filler(8)} мы говорим про экологию ${filler(8, "д")}`,
    ]);
    expect(montageScore(graph, 0, 0)).toBe(0);
  });

  // --- surviving transcription jitter ----------------------------------------

  it("folds ё to е: the same word spelled two ways is the same word", () => {
    // MEASURED: the two eval fixtures are two Whisper runs of one 52-minute
    // episode - one contains 10 ё-tokens, the other 0. Inside a single run the
    // same lemma appears both ways (всё/все, ещё/еще, её/ее). ё carries no
    // lexical information in ordinary Russian orthography, so a copy spelled
    // the other way is still a copy.
    const graph = nodes([
      "что убьёт человечество собственная глупость конечно",
      "заполнитель",
      "что убьет человечество собственная глупость конечно",
    ]);
    expect(montageScore(graph, 0, 0)).toBe(1);
  });

  it("detects the REAL failure: the montage still matches when one later word is respelled", () => {
    // podcast-ecology, nodes 11-12 at 36.7-39.3s - the montage fragment this
    // filter exists to kill. Its original is node 783 at 2807s. Respelling that
    // one word took the shipped 5-gram fraction from 1.000 to 0.000 and let the
    // montage through; six words are exactly two 5-grams, so any interior word
    // erased both.
    const graph = nodes([
      "Что убьет человечество",
      "Собственная глупость конечно",
      filler(40),
      "Что убьёт человечество Собственная глупость конечно",
    ]);
    expect(montageScore(graph, 0, 1)).toBe(1);
    expect(isTeaserCandidate(graph, { startNode: 0, endNode: 1 }, cfg)).toBe(true);
  });

  it("a short candidate survives ONE substituted word anywhere in it", () => {
    // Six words is the smallest real montage fragment and the fragile case: no
    // verbatim 5-word run can survive a change in the middle. Every position
    // must stay above the bar, not just the edges.
    const words = ["альфа", "бета", "гамма", "дельта", "эпсилон", "дзета"];
    for (let i = 0; i < words.length; i++) {
      const respelled = words.map((w, j) => (i === j ? `${w}х` : w));
      const graph = nodes([respelled.join(" "), filler(30), words.join(" ")]);
      expect(
        montageScore(graph, 0, 0),
        `word ${i} respelled`
      ).toBeCloseTo(5 / 6, 5);
      expect(isTeaserCandidate(graph, { startNode: 0, endNode: 0 }, cfg)).toBe(true);
    }
  });

  it(`needs ${TEASER_MIN_ALIGNED} words to line up - four is not a montage`, () => {
    expect(TEASER_MIN_ALIGNED).toBe(5);
    const graph = nodes([
      "альфа бета гамма дельта эпсилон дзета",
      filler(30),
      "альфа бета гамма дельта ЧУЖОЕ ДРУГОЕ",
    ]);
    expect(montageScore(graph, 0, 0)).toBe(0);
  });

  it("requires the aligned words to sit in ONE later passage, not scattered", () => {
    // The measured false-positive shape: ordinary short speech whose stock
    // phrases each recur somewhere. Three words here, three words there is not
    // a copy of anything - only one later passage reproducing the utterance is.
    const graph = nodes([
      "альфа бета гамма дельта эпсилон дзета",
      `${filler(20)} альфа бета гамма ${filler(20, "д")}`,
      `${filler(20, "е")} дельта эпсилон дзета ${filler(20, "ж")}`,
    ]);
    expect(montageScore(graph, 0, 0)).toBe(0);
  });

  it(`gives the aligned path only to candidates of at most ${TEASER_SHORT_WORDS} words`, () => {
    // 12 words matching later at 6 alternating positions: no run reaches 5, so
    // there is no verbatim evidence. A candidate this long CAN carry a real run
    // around a respelled word, so it does not get the looser test - which is
    // what keeps "same topic, same stock phrases" from scoring.
    const cand = Array.from({ length: 12 }, (_, i) => `сл${i}`);
    const echo = cand.map((w, i) => (i % 2 === 0 ? w : `иное${i}`));
    const graph = nodes([cand.join(" "), filler(30), echo.join(" ")]);
    expect(montageScore(graph, 0, 0)).toBe(0);
  });

  it("a candidate of 11 words carries a respelled word on runs alone", () => {
    // The arithmetic behind the cutoff: a substitution at position i leaves a
    // prefix of i and a suffix of w-1-i, and only runs of 5 count. The worst
    // position costs everything up to w=9, exactly half at w=10, and from 11
    // words up both halves survive - which is where the looser test stops.
    const cand = Array.from({ length: 11 }, (_, i) => `сл${i}`);
    const echo = cand.map((w, i) => (i === 5 ? "подмена" : w));
    const graph = nodes([cand.join(" "), filler(30), echo.join(" ")]);
    expect(montageScore(graph, 0, 0)).toBeCloseTo(10 / 11, 5);
  });

  it("a candidate of exactly 10 words would sit ON the bar without the aligned path", () => {
    // The reason the cutoff is 10 and not 9: at ten words the worst-placed
    // respelling leaves one surviving run of five, i.e. coverage 0.500 - equal
    // to the default bar, with no margin at all. The aligned reading lifts the
    // same candidate to 0.900.
    const cand = Array.from({ length: 10 }, (_, i) => `сл${i}`);
    const echo = cand.map((w, i) => (i === 4 ? "подмена" : w));
    const graph = nodes([cand.join(" "), filler(30), echo.join(" ")]);
    expect(TEASER_SHORT_WORDS).toBe(10);
    expect(montageScore(graph, 0, 0)).toBeCloseTo(9 / 10, 5);
  });
});

describe("isTeaserCandidate", () => {
  const graph = nodes([
    "человек это зло для планеты земля",
    "заполнитель между ними",
    "человек это зло для планеты земля",
  ]);

  it("flags a montage copy inside the opening window", () => {
    expect(isTeaserCandidate(graph, { startNode: 0, endNode: 0 }, cfg)).toBe(true);
  });

  it("never flags a candidate that starts past the window", () => {
    const late = graph.map((n, i) => ({ ...n, start: 300 + i * 5, end: 304 + i * 5 }));
    expect(isTeaserCandidate(late, { startNode: 0, endNode: 0 }, cfg)).toBe(false);
  });

  it("flags a candidate sitting exactly on the window edge", () => {
    const edge = graph.map((n, i) => ({ ...n, start: i === 0 ? 120 : 300, end: 304 }));
    expect(isTeaserCandidate(edge, { startNode: 0, endNode: 0 }, cfg)).toBe(true);
  });

  it("does not flag the ORIGINAL later occurrence the montage copied", () => {
    expect(isTeaserCandidate(graph, { startNode: 2, endNode: 2 }, cfg)).toBe(false);
  });

  it("does not flag an ordinary opening that merely shares vocabulary", () => {
    const ordinary = nodes([
      "сегодня мы обсуждаем экологию и климат",
      "экология это очень широкая тема",
      "климат меняется быстрее чем раньше",
    ]);
    expect(isTeaserCandidate(ordinary, { startNode: 0, endNode: 0 }, cfg)).toBe(false);
  });

  it("does not flag a cold open whose thesis is only paraphrased later", () => {
    // The legitimate shape this filter must never eat: a speaker states a
    // position early and returns to it later in DIFFERENT words. Shared topic
    // vocabulary, no reproduced passage.
    const coldOpen = nodes([
      "человечество само себя погубит собственной глупостью и жадностью",
      filler(30),
      "глупость человечества это то что нас в итоге и погубит наверное",
    ]);
    expect(isTeaserCandidate(coldOpen, { startNode: 0, endNode: 0 }, cfg)).toBe(false);
  });

  it("fires exactly AT the threshold and not one step below it", () => {
    const graph2 = nodes([
      "человек это зло для планеты и мы все в этом виноваты",
      `${filler(3)} человек это зло для планеты ${filler(3)}`,
    ]);
    // 5 of 11 words evidenced
    const at = { teaserWindowSec: 120, teaserRecurrenceFrac: 5 / 11 };
    const above = { teaserWindowSec: 120, teaserRecurrenceFrac: 0.46 };
    expect(isTeaserCandidate(graph2, { startNode: 0, endNode: 0 }, at)).toBe(true);
    expect(isTeaserCandidate(graph2, { startNode: 0, endNode: 0 }, above)).toBe(false);
  });

  it("is inert for a candidate whose start node does not exist", () => {
    expect(isTeaserCandidate(graph, { startNode: 99, endNode: 99 }, cfg)).toBe(false);
  });

  it("reads the shipped defaults from the real config", () => {
    const real = loadAnalyzeConfig({});
    expect(real.teaserWindowSec).toBe(120);
    expect(real.teaserRecurrenceFrac).toBe(0.5);
    expect(isTeaserCandidate(graph, { startNode: 0, endNode: 0 }, real)).toBe(true);
  });
});
