import { describe, expect, it } from "vitest";
import { recurrenceFraction, isTeaserCandidate, TEASER_NGRAM } from "../analyze-v2/teaser";
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

const cfg = { teaserWindowSec: 120, teaserRecurrenceFrac: 0.35 };

describe("recurrenceFraction", () => {
  it("is 1 when every phrase reappears later", () => {
    const graph = nodes([
      "человек это зло для планеты земля",
      "мусорная фраза посередине",
      "человек это зло для планеты земля",
    ]);
    expect(recurrenceFraction(graph, 0, 0)).toBe(1);
  });

  it("is 0 when nothing reappears", () => {
    const graph = nodes(["уникальная мысль про экологию", "совсем другая тема разговора"]);
    expect(recurrenceFraction(graph, 0, 0)).toBe(0);
  });

  it("ignores recurrence INSIDE the candidate itself", () => {
    const graph = nodes([
      "одна и та же фраза повторяется",
      "одна и та же фраза повторяется",
      "дальше идет совершенно другой текст",
    ]);
    // the repeat is inside [0,1], not after it
    expect(recurrenceFraction(graph, 0, 1)).toBe(0);
  });

  it("does not count the candidate's own earlier copy - only later text", () => {
    // the REAL moment at the end must measure 0, otherwise the filter would
    // punish the original for having been quoted by the montage
    const graph = nodes([
      "человек это зло для планеты земля",
      "заполнитель между ними",
      "человек это зло для планеты земля",
    ]);
    expect(recurrenceFraction(graph, 2, 2)).toBe(0);
  });

  it("tolerates punctuation and case differences", () => {
    const graph = nodes([
      "Человек - это ЗЛО для планеты Земля!",
      "другое",
      "человек это зло для планеты земля",
    ]);
    expect(recurrenceFraction(graph, 0, 0)).toBe(1);
  });

  it("returns 0 for text too short to form an n-gram", () => {
    expect(recurrenceFraction(nodes(["да", "да"]), 0, 0)).toBe(0);
  });

  it("measures the share of n-grams, not a yes/no match", () => {
    // 10 words -> 6 five-grams; only the first 6 words recur -> 2 of 6 hit
    const graph = nodes([
      "человек это зло для планеты земля и мы все виноваты",
      "человек это зло для планеты земля",
    ]);
    expect(recurrenceFraction(graph, 0, 0)).toBeCloseTo(2 / 6, 5);
  });

  it("spans the whole candidate range, not just its first node", () => {
    const graph = nodes([
      "первая приманка про экологию планеты",
      "вторая приманка про будущее цивилизации",
      "первая приманка про экологию планеты вторая приманка про будущее цивилизации",
    ]);
    expect(recurrenceFraction(graph, 0, 1)).toBe(1);
  });

  it("is 0 for an out-of-range slice", () => {
    expect(recurrenceFraction(nodes(["одна фраза здесь и сейчас"]), 5, 9)).toBe(0);
  });

  it("uses 5-grams - four shared words are not enough", () => {
    expect(TEASER_NGRAM).toBe(5);
    const graph = nodes(["мы говорим про экологию", "мы говорим про экологию"]);
    // only 4 tokens: cannot form a 5-gram, so nothing is measurable
    expect(recurrenceFraction(graph, 0, 0)).toBe(0);
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

  it("fires exactly AT the threshold and not one step below it", () => {
    // 10 words -> 6 five-grams, 2 of them recur -> 0.3333...
    const graph2 = nodes([
      "человек это зло для планеты земля и мы все виноваты",
      "человек это зло для планеты земля",
    ]);
    const at = { teaserWindowSec: 120, teaserRecurrenceFrac: 2 / 6 };
    const above = { teaserWindowSec: 120, teaserRecurrenceFrac: 0.34 };
    expect(isTeaserCandidate(graph2, { startNode: 0, endNode: 0 }, at)).toBe(true);
    expect(isTeaserCandidate(graph2, { startNode: 0, endNode: 0 }, above)).toBe(false);
  });

  it("is inert for a candidate whose start node does not exist", () => {
    expect(isTeaserCandidate(graph, { startNode: 99, endNode: 99 }, cfg)).toBe(false);
  });

  it("reads the shipped defaults from the real config", () => {
    const real = loadAnalyzeConfig({});
    expect(real.teaserWindowSec).toBe(120);
    expect(real.teaserRecurrenceFrac).toBe(0.35);
    expect(isTeaserCandidate(graph, { startNode: 0, endNode: 0 }, real)).toBe(true);
  });
});
