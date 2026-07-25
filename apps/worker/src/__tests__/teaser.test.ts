import { describe, expect, it } from "vitest";
import {
  buildRecurrenceIndex,
  nodeRecurrence,
  detectTeaserRegion,
  isInTeaserRegion,
  TEASER_MIN_RUN,
  TEASER_RECUR_BAR,
  TEASER_MIN_GAP_SEC,
  TEASER_MAX_HIT_GAP_SEC,
  TEASER_REGION_PAD_SEC,
} from "../analyze-v2/teaser";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { SentenceNode } from "../analyze-v2/types";

/**
 * The detector decides on WHERE recurring sentences cluster, so every graph
 * here carries real timings. `dur` defaults to 2s, which is about the length of
 * a montage fragment.
 */
interface Line {
  start: number;
  text: string;
  dur?: number;
}

function graph(lines: Line[]): SentenceNode[] {
  return lines.map((l, i) => ({
    index: i,
    start: l.start,
    end: l.start + (l.dur ?? 2),
    text: l.text,
    hasWords: true,
    trailingStrength: 1,
    leadingStrength: 1,
  }));
}

/** n distinct filler words - padding that can never match anything. */
function filler(n: number, tag = "ф"): string {
  return Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
}

/** A sentence of `words` words, every one of them unique to `tag`. */
function line(tag: string, words = 6): string {
  return Array.from({ length: words }, (_, i) => `сл${i}${tag}`).join(" ");
}

const cfg = { teaserWindowSec: 120, teaserMinHits: 3 };

/**
 * The real montage's shape, sentence by sentence.
 *
 * podcast-ecology / podcast-answer-arc, measured 2026-07-25: fourteen sentence
 * nodes from 0.00s to 44.64s, eleven of which reproduce speech from 724-3099s.
 * Word counts and recurring-word counts below are the MEASURED ones, not round
 * numbers - the shape is what the tests are about, and a montage of uniform
 * six-word fragments would be a different (and much more fragile) artefact than
 * the one that shipped. Every origin sits past TEASER_MIN_GAP_SEC, as in the
 * fixtures, where the nearest real origin is 724s away.
 *
 *   idx  start   words  recurring   idx  start   words  recurring
 *    0    0.00     6        6        7   22.20    12       12
 *    1    2.26    13       13        8   27.16    10       10
 *    2    7.24     8        8        9   31.98     7        5
 *    3    9.52    15        9       10   34.74     5        5
 *    4   15.00     6        6       11   36.68     3        0   <- the defect
 *    5   17.48     5        0       12   38.22     3        0   <- the defect
 *    6   19.64     8        8       13   39.56    15       15
 */
const FRAGMENTS = [
  { start: 0.0, words: 6, recurring: 6 },
  { start: 2.26, words: 13, recurring: 13 },
  { start: 7.24, words: 8, recurring: 8 },
  { start: 9.52, words: 15, recurring: 9 },
  { start: 15.0, words: 6, recurring: 6 },
  { start: 17.48, words: 5, recurring: 0 },
  { start: 19.64, words: 8, recurring: 8 },
  { start: 22.2, words: 12, recurring: 12 },
  { start: 27.16, words: 10, recurring: 10 },
  { start: 31.98, words: 7, recurring: 5 },
  { start: 34.74, words: 5, recurring: 5 },
  { start: 39.56, words: 15, recurring: 15 },
];

/** Index of the first node of the real show - everything after the montage. */
const SHOW_NODE = 15;

function realMontage(): SentenceNode[] {
  const lines: Line[] = [];
  FRAGMENTS.forEach((f, i) => {
    if (f.start === 39.56) return; // appended after the defect, below
    const pad = f.words - f.recurring;
    lines.push({
      start: f.start,
      text: [f.recurring > 0 ? line(`m${i}`, f.recurring) : "", pad > 0 ? filler(pad, `у${i}`) : ""]
        .filter(Boolean)
        .join(" "),
    });
  });
  // The defect: two fragments that recur nowhere, inside the montage.
  lines.push({ start: 36.68, text: "что убьет человечество" });
  lines.push({ start: 38.22, text: "собственная глупость конечно" });
  lines.push({ start: 39.56, text: line("m11", 15) });
  // The real show starts here (node SHOW_NODE onwards are its sentences).
  lines.push({ start: 45.52, text: "всем привет это подкаст сортировочный сегодня" });
  FRAGMENTS.forEach((f, i) => {
    if (f.recurring === 0) return;
    const tag = f.start === 39.56 ? "m11" : `m${i}`;
    lines.push({
      start: 200 + i * 240,
      text: `${filler(5, `п${i}`)} ${line(tag, f.recurring)} ${filler(5, `с${i}`)}`,
    });
  });
  return graph(lines);
}

describe("nodeRecurrence", () => {
  const share = (nodes: SentenceNode[], i: number) =>
    nodeRecurrence(buildRecurrenceIndex(nodes), i).share;

  it("is 1 when the whole sentence is spoken again far away", () => {
    const g = graph([
      { start: 0, text: line("a") },
      { start: 900, text: line("a") },
    ]);
    expect(share(g, 0)).toBe(1);
  });

  it("is symmetric - the later original scores as high as the early copy", () => {
    // The montage's own first fragment originates 31 minutes in, so a
    // later-only test would have to guess which occurrence is the copy. The
    // region's anchor at t=0 is what makes a symmetric primitive safe.
    const g = graph([
      { start: 0, text: line("a") },
      { start: 900, text: line("a") },
    ]);
    expect(share(g, 1)).toBe(1);
  });

  it(`ignores an echo closer than ${TEASER_MIN_GAP_SEC}s - that is a speaker repeating himself`, () => {
    const g = graph([
      { start: 0, text: line("a") },
      { start: TEASER_MIN_GAP_SEC - 1, text: line("a") },
    ]);
    expect(share(g, 0)).toBe(0);
  });

  it("counts the share of WORDS backed by evidence, not the share of n-grams", () => {
    const cand = `${line("a")} ${filler(5, "х")}`; // 11 words, 6 recur
    const g = graph([
      { start: 0, text: cand },
      { start: 900, text: `${filler(4)} ${line("a")} ${filler(4, "г")}` },
    ]);
    expect(share(g, 0)).toBeCloseTo(6 / 11, 5);
  });

  it(`ignores matching runs shorter than ${TEASER_MIN_RUN} words`, () => {
    expect(TEASER_MIN_RUN).toBe(5);
    // NOT "four words never recur by chance" - they do, and so do five. The
    // same episode says "серы азота и так далее" verbatim at 717.2s and
    // 1888.9s. Five is where the FALSE-POSITIVE SURFACE of the region rule
    // stops shrinking: measured 2026-07-25 over 1623 later offsets on both
    // fixtures, the clustered-hit ceiling is 2 at both k=4 and k=5, but k=4
    // triples the number of offsets that reach it (17-19 vs 6-8). Chance
    // recurrence is not what k buys; margin is.
    const g = graph([
      { start: 0, text: "альфа бета гамма дельта эпсилон" },
      { start: 900, text: `${filler(8)} альфа бета гамма дельта ${filler(8, "д")}` },
    ]);
    expect(share(g, 0)).toBe(0);
  });

  it("is 0 for a sentence too short to carry a run", () => {
    const g = graph([
      { start: 0, text: "да конечно" },
      { start: 900, text: "да конечно" },
    ]);
    expect(share(g, 0)).toBe(0);
  });

  it("folds ё to е: the same word spelled two ways is the same word", () => {
    // MEASURED: the two eval fixtures are two Whisper runs of one episode - one
    // contains 10 ё-tokens, the other 0, and inside a single run the same lemma
    // appears both ways (всё/все, ещё/еще). ё carries no lexical information in
    // ordinary Russian orthography.
    const g = graph([
      { start: 0, text: "что убьёт человечество собственная глупость конечно" },
      { start: 900, text: "что убьет человечество собственная глупость конечно" },
    ]);
    expect(share(g, 0)).toBe(1);
  });

  it("tolerates punctuation and case", () => {
    const g = graph([
      { start: 0, text: "Человек - это ЗЛО для планеты Земля!" },
      { start: 900, text: "человек это зло для планеты земля" },
    ]);
    expect(share(g, 0)).toBe(1);
  });
});

describe("detectTeaserRegion - the real montage", () => {
  it("finds all eleven recurring fragments and ends the region after the last one", () => {
    const region = detectTeaserRegion(realMontage(), cfg);
    expect(region).not.toBeNull();
    expect(region!.hits).toBe(11);
    // last hit is the node at 39.56s (2s long); the pad carries the region past it
    expect(region!.lastHitEndSec).toBeCloseTo(41.56, 5);
    expect(region!.endSec).toBeCloseTo(41.56 + TEASER_REGION_PAD_SEC, 5);
  });

  it("catches the owner's defect, which scores ZERO on its own", () => {
    // podcast-ecology 36.68-39.30s, "Что убьет человечество / Собственная
    // глупость конечно" - six words that occur exactly once in the episode.
    // Every per-candidate similarity test scores this 0.000 at full strength;
    // it is a montage fragment because of where it sits, not because of what
    // it says. This is the assertion the whole redesign exists for.
    const nodes = realMontage();
    const ix = buildRecurrenceIndex(nodes);
    expect(nodeRecurrence(ix, 11).share).toBe(0);
    expect(nodeRecurrence(ix, 12).share).toBe(0);
    const region = detectTeaserRegion(nodes, cfg)!;
    expect(isInTeaserRegion(region, 36.68)).toBe(true);
  });

  it("leaves the legitimate cold open at 87s alone", () => {
    // Both fixtures open the real show with "Бытует мнение, что люди - главные
    // разрушители планеты... Так ли это?" at ~87s, inside the 120s window. The
    // region must stop 45s short of it.
    const region = detectTeaserRegion(realMontage(), cfg)!;
    expect(region.endSec).toBeLessThan(87.43);
    expect(isInTeaserRegion(region, 87.43)).toBe(false);
  });

  it("the pad is load-bearing: it reaches a fragment the last hit stops short of", () => {
    // MEASURED necessity: under "one respelled word in every fragment" the last
    // surviving hit on podcast-ecology ends at 31.74s while the defect starts
    // at 36.68s. Without the pad the defect escapes. The measured working range
    // is [5s, 55s] - 5s to reach the defect, 55s before touching the 87.43s
    // cold open - and 15s sits inside it. Growing the pad IS the false-positive
    // direction; if anything ever needs adjusting, adjust it down.
    const nodes = graph([
      { start: 0.0, text: line("a") },
      { start: 3.0, text: line("b") },
      { start: 6.0, text: line("c") },
      { start: 12.0, text: "уникальная приманка которая нигде больше не встречается" },
      { start: 900, text: line("a") },
      { start: 1200, text: line("b") },
      { start: 1500, text: line("c") },
    ]);
    const region = detectTeaserRegion(nodes, cfg)!;
    expect(region.lastHitEndSec).toBeCloseTo(8.0, 5);
    expect(isInTeaserRegion(region, 12.0)).toBe(true);
    expect(TEASER_REGION_PAD_SEC).toBe(15);
  });
});

describe("detectTeaserRegion - what must NOT fire", () => {
  /** A real show whose speaker genuinely says one thing twice. */
  function coldOpen(repeats: number): SentenceNode[] {
    const lines: Line[] = [];
    for (let i = 0; i < repeats; i++) {
      lines.push({ start: 0.5 + i * 4, text: line(`q${i}`) });
    }
    lines.push({ start: 0.5 + repeats * 4, text: "всем привет это подкаст сортировочный сегодня" });
    for (let i = 0; i < repeats; i++) {
      lines.push({ start: 400 + i * 200, text: `${filler(4, `п${i}`)} ${line(`q${i}`)}` });
    }
    return graph(lines);
  }

  it("does not fire on a cold open the speaker really repeats once", () => {
    // THE CASE ATTEMPT 2 GOT WRONG. Measured on both fixtures: a real sentence
    // the guest genuinely says at 455.0s ("Один заражает только двугорбового
    // верблюда в Северной Африке"), placed at 8.0s, scores recurrence 1.0000 at
    // candidate level and was filtered on both fixtures - rewording three of
    // its eight words still left it filtered. It produces exactly ONE clustered
    // hit, and one is not a montage.
    const nodes = coldOpen(1);
    expect(nodeRecurrence(buildRecurrenceIndex(nodes), 0).share).toBe(1);
    expect(detectTeaserRegion(nodes, cfg)).toBeNull();
  });

  it("does not fire on two genuine repeats either", () => {
    // The measured false-positive ceiling in ordinary conversation is 2
    // clustered hits (1623 later offsets, both fixtures, 2026-07-25). Two must
    // stay below the bar or the ceiling touches it.
    expect(detectTeaserRegion(coldOpen(2), cfg)).toBeNull();
  });

  it("fires at exactly teaserMinHits and not one below", () => {
    expect(cfg.teaserMinHits).toBe(3);
    expect(detectTeaserRegion(coldOpen(3), cfg)).not.toBeNull();
    expect(detectTeaserRegion(coldOpen(3), { ...cfg, teaserMinHits: 4 })).toBeNull();
  });

  it("never fires on a repetition cluster that is not anchored at the video's start", () => {
    // Free safety from the anchor: the region grows from t=0, so a host who
    // quotes his guest five times in a row cannot produce a region no matter
    // how verbatim the quotes are. Placed at 90s - INSIDE the 120s window, so
    // the window is not what saves this; the anchor is.
    const lines: Line[] = [{ start: 0, text: "всем привет это подкаст сортировочный сегодня" }];
    for (let i = 0; i < 5; i++) lines.push({ start: 90 + i * 4, text: line(`q${i}`) });
    for (let i = 0; i < 5; i++) lines.push({ start: 900 + i * 200, text: line(`q${i}`) });
    const nodes = graph(lines);
    // The quotes really do score - it is only their position that saves them.
    expect(nodeRecurrence(buildRecurrenceIndex(nodes), 1).share).toBe(1);
    expect(detectTeaserRegion(nodes, cfg)).toBeNull();
  });

  it("never fires on a mid-video cluster far outside the opening window", () => {
    const lines: Line[] = [{ start: 0, text: "всем привет это подкаст сортировочный сегодня" }];
    for (let i = 0; i < 5; i++) lines.push({ start: 1200 + i * 4, text: line(`q${i}`) });
    for (let i = 0; i < 5; i++) lines.push({ start: 2000 + i * 200, text: line(`q${i}`) });
    expect(detectTeaserRegion(graph(lines), cfg)).toBeNull();
  });

  it(`never fires on a cluster that starts more than ${TEASER_MAX_HIT_GAP_SEC}s in`, () => {
    const lines: Line[] = [{ start: 0, text: "всем привет это подкаст сортировочный сегодня" }];
    for (let i = 0; i < 5; i++) {
      lines.push({ start: TEASER_MAX_HIT_GAP_SEC + 1 + i * 4, text: line(`q${i}`) });
    }
    for (let i = 0; i < 5; i++) lines.push({ start: 900 + i * 200, text: line(`q${i}`) });
    expect(detectTeaserRegion(graph(lines), cfg)).toBeNull();
  });

  it(`stops the region at a hit gap wider than ${TEASER_MAX_HIT_GAP_SEC}s`, () => {
    const lines: Line[] = [
      { start: 0, text: line("a") },
      { start: 3, text: line("b") },
      { start: 6, text: line("c") },
      // ordinary speech past the tolerance, then more recurring material: a
      // separate event, not part of the montage.
      { start: 8 + TEASER_MAX_HIT_GAP_SEC + 1, text: line("d") },
      { start: 8 + TEASER_MAX_HIT_GAP_SEC + 4, text: line("e") },
      { start: 900, text: line("a") },
      { start: 1100, text: line("b") },
      { start: 1300, text: line("c") },
      { start: 1500, text: line("d") },
      { start: 1700, text: line("e") },
    ];
    const region = detectTeaserRegion(graph(lines), cfg)!;
    expect(region.hits).toBe(3);
    expect(region.lastHitEndSec).toBeCloseTo(8, 5);
  });

  it("does not fire when the opening merely shares vocabulary with the body", () => {
    const nodes = graph([
      { start: 0, text: "сегодня мы обсуждаем экологию климат и будущее планеты" },
      { start: 6, text: "экология это очень широкая и сложная тема" },
      { start: 12, text: "климат меняется намного быстрее чем раньше" },
      { start: 900, text: "экология климат и будущее это разные вещи на самом деле" },
      { start: 1200, text: "тема климата очень широкая и сложная сама по себе" },
    ]);
    expect(detectTeaserRegion(nodes, cfg)).toBeNull();
  });

  it("is disabled by teaserWindowSec = 0 - the kill switch", () => {
    expect(detectTeaserRegion(realMontage(), { ...cfg, teaserWindowSec: 0 })).toBeNull();
  });

  it("is inert on an empty graph", () => {
    expect(detectTeaserRegion([], cfg)).toBeNull();
  });
});

describe("detectTeaserRegion - transcription jitter", () => {
  const PARTICLES = ["значит", "вот", "да", "ну", "там", "если", "надо"];

  /** Insert a discourse particle into the middle of a node's text. */
  function insert(nodes: SentenceNode[], i: number, seed = 0): SentenceNode[] {
    return nodes.map((n, j) => {
      if (j !== i) return n;
      const w = n.text.split(/\s+/);
      w.splice(Math.floor(w.length / 2), 0, PARTICLES[seed % PARTICLES.length]);
      return { ...n, text: w.join(" ") };
    });
  }

  /** Delete one interior word from a node's text. */
  function remove(nodes: SentenceNode[], i: number): SentenceNode[] {
    return nodes.map((n, j) => {
      if (j !== i) return n;
      const w = n.text.split(/\s+/);
      w.splice(Math.floor(w.length / 2), 1);
      return { ...n, text: w.join(" ") };
    });
  }

  it("survives a particle inserted into the copy", () => {
    // What killed attempt 2: alignedShare voted on a FIXED offset, so ONE
    // inserted word shifted every later word into a different bucket and took
    // the score from 1.0000 to 0.0000. Insertions and deletions outnumber
    // substitutions 3.8:1 in real Whisper jitter (measured by LCS-aligning the
    // two fixtures: 14 subs, 28 ins, 25 del).
    let nodes = realMontage();
    for (let i = 0; i < SHOW_NODE - 1; i++) nodes = insert(nodes, i, i);
    const region = detectTeaserRegion(nodes, cfg);
    expect(region).not.toBeNull();
    expect(region!.hits).toBeGreaterThanOrEqual(cfg.teaserMinHits);
    expect(isInTeaserRegion(region!, 36.68)).toBe(true);
  });

  it("survives a particle deleted from every later original", () => {
    let nodes = realMontage();
    for (let i = SHOW_NODE; i < nodes.length; i++) nodes = remove(nodes, i);
    const region = detectTeaserRegion(nodes, cfg);
    expect(region).not.toBeNull();
    expect(region!.hits).toBeGreaterThanOrEqual(cfg.teaserMinHits);
    expect(isInTeaserRegion(region!, 36.68)).toBe(true);
  });

  it("survives independent indels in the copies AND the originals at once", () => {
    // The desynchronising case: the fragment and its origin are edited
    // differently, which is exactly what two transcription runs of one audio
    // produce. Insert into the copies, delete from the originals.
    let nodes = realMontage();
    for (let i = 0; i < SHOW_NODE - 1; i++) nodes = insert(nodes, i, i);
    for (let i = SHOW_NODE; i < nodes.length; i++) nodes = remove(nodes, i);
    const region = detectTeaserRegion(nodes, cfg);
    expect(region).not.toBeNull();
    expect(region!.hits).toBeGreaterThanOrEqual(cfg.teaserMinHits);
    expect(isInTeaserRegion(region!, 36.68)).toBe(true);
  });

  it("still refuses the single genuine repeat under the same jitter", () => {
    // The robustness above must not be robustness at admitting anything: the
    // cold open stays out with the same edits applied.
    let nodes = graph([
      { start: 0.5, text: line("q") },
      { start: 5, text: "всем привет это подкаст сортировочный сегодня" },
      { start: 400, text: `${filler(4, "п")} ${line("q")}` },
    ]);
    nodes = insert(nodes, 0, 1);
    nodes = remove(nodes, 2);
    expect(detectTeaserRegion(nodes, cfg)).toBeNull();
  });
});

describe("isInTeaserRegion", () => {
  it("drops a candidate starting inside the region and keeps one starting at its end", () => {
    const region = detectTeaserRegion(realMontage(), cfg)!;
    expect(isInTeaserRegion(region, region.endSec - 0.01)).toBe(true);
    expect(isInTeaserRegion(region, region.endSec)).toBe(false);
  });

  it("keeps everything when no region was found", () => {
    expect(isInTeaserRegion(null, 0)).toBe(false);
  });
});

describe("shipped configuration", () => {
  it("reads the defaults from the real config", () => {
    const real = loadAnalyzeConfig({});
    expect(real.teaserWindowSec).toBe(120);
    expect(real.teaserMinHits).toBe(3);
    expect(detectTeaserRegion(realMontage(), real)).not.toBeNull();
  });

  it(`pins the recurrence bar at ${TEASER_RECUR_BAR} and keeps it out of the env`, () => {
    // Measured 2026-07-25 on both fixtures: the bar is INERT across [0.20,
    // 0.50] - the clustered-hit ceiling over 1623 later offsets is 2 at every
    // value in that range, and the montage scores 11 at every value. Exposing
    // an inert number as a knob is what attempt 2 did with TEASER_MIN_ALIGNED
    // (provably binary on its own path). The knob that DOES separate the
    // distributions is the hit count, so that is the one in the config.
    expect(TEASER_RECUR_BAR).toBe(0.5);
    expect(loadAnalyzeConfig({}) as unknown as Record<string, unknown>).not.toHaveProperty(
      "teaserRecurrenceFrac"
    );
  });
});
