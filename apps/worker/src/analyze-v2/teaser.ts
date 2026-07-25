import type { SentenceNode } from "./types";

/**
 * Intro trailer-montage detection.
 *
 * WHAT CHANGED AND WHY (2026-07-25, third attempt)
 * ------------------------------------------------
 * The first two attempts scored each CANDIDATE for textual similarity against
 * the rest of the transcript and dropped the ones that looked like copies.
 * Measurement killed both, and killed the whole approach with them:
 *
 *   - The motivating defect - podcast-ecology's 3.03s clip at 36.68-39.30s,
 *     "Что убьет человечество / Собственная глупость конечно" - is six words
 *     that occur EXACTLY ONCE in the 52-minute episode. It scores 0.000 on
 *     plain verbatim recurrence at full strength. No per-candidate similarity
 *     test at any threshold can flag it, because there is nothing to match.
 *   - The substitution-tolerant path built to rescue short fragments voted on a
 *     FIXED word offset, so a single INSERTED word split the vote and took the
 *     score from 1.0000 to 0.0000. Real Whisper jitter, measured by LCS-aligning
 *     the two fixtures (two runs of the same audio): 14 substitutions, 28
 *     insertions, 25 deletions. Indels outnumber substitutions 3.8:1 - the
 *     mechanism was defeated by the dominant failure mode.
 *   - Per-candidate similarity cannot separate "montage copy" from "the speaker
 *     said it twice" even in principle: at the text level they are the same
 *     phenomenon. A constructed cold open built from a sentence the guest
 *     really does say twice scored 1.0000 and was dropped on both fixtures.
 *
 * So the unit of decision moved. What makes a montage a montage is not that any
 * one fragment resembles later speech - it is that the video OPENS with a run
 * of sentences that each reproduce speech from far away in the episode. That is
 * a property of the neighbourhood, and the neighbourhood is measurable:
 *
 *   ecology, nodes 0-13 (0.00-44.64s):  11 of 14 sentences reproduce speech
 *                                       from 724-3099s. Both fixtures, from
 *                                       independent transcriptions, give 11.
 *   1623 later offsets, both fixtures:  the most clustered recurrences ordinary
 *                                       conversation ever produced is 2.
 *   constructed legitimate cold open:   1.
 *
 * The defect scores 0.000 on its own and sits surrounded by eleven sentences
 * that score 0.60-1.00. It is dropped for WHERE IT IS, which is the only thing
 * that was ever true about it.
 *
 * The string matcher below is the SAME weak one that failed at candidate level.
 * Nothing about the matching needed to improve - the rule needs 3 of 14 nodes
 * to match, not 14 of 14.
 */

/**
 * Shortest verbatim word run that counts as evidence of a copy.
 *
 * NOT "four words recur by chance and five do not" - the earlier comment here
 * said that and the same transcript disproves it: "серы азота и так далее"
 * occurs verbatim at 717.2s and 1888.9s, and single sentences reach recurrence
 * 1.000 in ordinary mid-episode speech at every k tested.
 *
 * What k actually buys is MARGIN on the clustered statistic this module decides
 * on. Measured 2026-07-25 over 1623 later offsets across both fixtures, the
 * ceiling on clustered hits is 2 at both k=4 and k=5 - but k=4 triples the
 * number of offsets that reach that ceiling (17-19 vs 6-8) and raises the count
 * of ordinary sentences scoring above the bar from 14 to 19-22. Same ceiling,
 * thinner margin, no gain: the montage scores 11 either way.
 */
export const TEASER_MIN_RUN = 5;

/**
 * Share of a sentence's words that must sit inside a distant verbatim run for
 * that sentence to count as one hit.
 *
 * Deliberately NOT a config knob, and that is the point. Measured on both
 * fixtures, this number is INERT across [0.20, 0.50]: the clustered-hit ceiling
 * over 1623 later offsets is 2 at every value in that range, and the real
 * montage scores 11 at every value (the eleven real hits are 0.60, 0.71, 0.92
 * and eight at 1.00; ordinary sentences are almost all exactly 0.00 - 12 of 799
 * clear 0.50, 15 clear 0.20). Attempt 2 shipped an inert number as a tunable
 * bar - TEASER_MIN_ALIGNED, provably binary on its own path - and the knob was
 * theatre that made the filter look safer than it was. The threshold that DOES
 * separate the two distributions is the hit count, and that is the one in the
 * config.
 *
 * 0.5 rather than the low end of the inert range because a false positive here
 * is an invisible, unrecoverable loss of a good clip, while a false negative
 * reaches the finalizer's LLM judge and the 6s duration floor. Measured, the
 * low end buys robustness only against jitter roughly 10x heavier than the
 * fixtures actually exhibit (at one edit per node, hits stay >= 3 in 7-9 runs
 * of 10 at 0.34 versus 4-5 of 10 at 0.50; at the fixtures' own edit rate both
 * are 10 of 10). If a real montage is ever measured escaping, 0.34 is the first
 * thing to try - the false-positive surface does not move.
 */
export const TEASER_RECUR_BAR = 0.5;

/**
 * How far away in time an occurrence must be to count as "elsewhere".
 *
 * This is what stops a sentence matching its own neighbourhood, and what makes
 * the symmetric test safe: the primitive does not care which occurrence came
 * first (the montage's own opening fragment originates 31 minutes in, so a
 * later-only test would have had to guess). The nearest real montage origin is
 * 724s away, so 60s costs nothing on the true-positive side while excluding the
 * ordinary case of a speaker restating himself within a minute.
 */
export const TEASER_MIN_GAP_SEC = 60;

/**
 * How far after the previous hit's END the next hit may arrive and still belong
 * to the same montage.
 *
 * This is the parameter that actually binds, and it is NOT sized by the
 * undegraded montage. On clean text the montage's largest hit-to-hit gap is
 * 4.9s (over the two non-recurring fragments at 36.68/38.22s), which would
 * suggest something like 15s. But jitter does not shrink fragments, it DELETES
 * hits - and the survivors are then spread much further apart than the
 * originals were. Swept on both fixtures, 2026-07-25, with one random
 * insertion/deletion/substitution in EVERY sentence (roughly 10x the jitter the
 * two fixtures actually exhibit between them), 10 seeds:
 *
 *   gap  FP ceiling over 1623 later offsets   montage survives jitter
 *    15  2  (6 offsets reach it)              4-5 of 10   <- the design's value
 *    20  2  (13)                              8-9 of 10
 *    25  2  (17)                             10 of 10     <- chosen
 *    30  2  (39)                             10 of 10
 *    45  3  (16 offsets reach 3)             10 of 10     <- ceiling touches the bar
 *
 * 25 is the smallest value at which the true positive stops depending on luck,
 * and it costs nothing on the false-positive side: the ceiling is 2 all the way
 * to 30, and the region END does not move at all on the undegraded montage
 * (59.6s at every gap from 15 to 120 - it is pinned by the last hit at 44.64s,
 * because nothing in the real show's opening minutes recurs). 30 keeps the
 * ceiling but more than doubles the offsets that reach it for no gain; at 45
 * the ceiling reaches 3 and ordinary conversation would fire the rule.
 */
export const TEASER_MAX_HIT_GAP_SEC = 25;

/**
 * How far past the last hit the region reaches.
 *
 * A measured necessity, not a safety margin: under "one respelled word in every
 * fragment" the last surviving hit ends at 31.74s and the defect starts at
 * 36.68s. The measured working range is [5s, 55s] - 5s to reach the defect, 55s
 * before touching the cold open at 87.43s. 15s is the same constant as the
 * hit-gap tolerance. Growing this pad IS the false-positive direction; if
 * anything here ever needs adjusting, adjust it DOWN.
 */
export const TEASER_REGION_PAD_SEC = 15;

export interface TeaserConfig {
  teaserWindowSec: number;
  teaserMinHits: number;
}

/**
 * ё is folded to е because Whisper's choice between them is noise, not
 * meaning. MEASURED across the two runs of the same audio: one contains 10
 * ё-tokens, the other 0, and inside a single run the same lemma appears both
 * ways (всё/все, ещё/еще, её/ее). Russian orthography treats ё as optional, so
 * "убьёт" and "убьет" are one word and must tokenise as one.
 *
 * Nothing else is normalised, deliberately. The other languages this product
 * serves have no equivalent free variation to fold: English contractions
 * ("don't" -> "don t") tokenise the same way in both copies, and Whisper's
 * English jitter is word-level ("gonna"/"going to", "90"/"ninety"), which no
 * character rule can repair. Scripts written without spaces (Chinese, Japanese,
 * Thai) collapse into a handful of huge tokens here and simply never score, so
 * the filter is inert on them rather than wrong.
 */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The transcript as one token stream, plus a start position index of every
 * TEASER_MIN_RUN-gram in it.
 *
 * Built once per video: scoring forty opening sentences against the whole
 * episode by re-tokenising it forty times is the same answer for forty times
 * the work.
 */
export interface RecurrenceIndex {
  nodes: SentenceNode[];
  tokens: string[];
  /** Node index that produced each token. */
  nodeOf: number[];
  /** First token position of each node. */
  offset: number[];
  /** Token count of each node. */
  length: number[];
  /** run-gram -> every token position where it starts. */
  runs: Map<string, number[]>;
}

export function buildRecurrenceIndex(nodes: SentenceNode[]): RecurrenceIndex {
  const tok: string[] = [];
  const nodeOf: number[] = [];
  const offset: number[] = [];
  const length: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const words = tokens(nodes[i].text);
    offset.push(tok.length);
    length.push(words.length);
    for (const word of words) {
      tok.push(word);
      nodeOf.push(i);
    }
  }
  const runs = new Map<string, number[]>();
  for (let i = 0; i + TEASER_MIN_RUN <= tok.length; i++) {
    const key = tok.slice(i, i + TEASER_MIN_RUN).join(" ");
    const at = runs.get(key);
    if (at) at.push(i);
    else runs.set(key, [i]);
  }
  return { nodes, tokens: tok, nodeOf, offset, length, runs };
}

export interface NodeRecurrence {
  /** 0..1 - share of this sentence's words backed by distant verbatim speech. */
  share: number;
  /** Start seconds of the distant sentences that backed it, deduplicated. */
  originSec: number[];
}

/**
 * Share of one sentence's words that sit inside a verbatim run of at least
 * TEASER_MIN_RUN words occurring at least TEASER_MIN_GAP_SEC away in time.
 *
 * Counting WORDS rather than n-gram windows is what makes a long sentence
 * robust: a run of five words is five words of evidence wherever it falls,
 * including at the very edge, where an n-gram count collapses. Covered
 * positions are unioned, so a sentence spliced from two distant moments - which
 * is what a montage fragment often is - adds its evidence up instead of
 * competing with itself.
 */
export function nodeRecurrence(ix: RecurrenceIndex, index: number): NodeRecurrence {
  const width = ix.length[index] ?? 0;
  if (width < TEASER_MIN_RUN) return { share: 0, originSec: [] };
  const base = ix.offset[index];
  const at = ix.nodes[index].start;
  const covered = new Array<boolean>(width).fill(false);
  const origins = new Set<number>();

  for (let i = 0; i + TEASER_MIN_RUN <= width; i++) {
    const key = ix.tokens.slice(base + i, base + i + TEASER_MIN_RUN).join(" ");
    const positions = ix.runs.get(key);
    if (!positions) continue;
    let longest = 0;
    for (const p of positions) {
      const originAt = ix.nodes[ix.nodeOf[p]].start;
      if (Math.abs(originAt - at) < TEASER_MIN_GAP_SEC) continue;
      let run = TEASER_MIN_RUN;
      while (
        i + run < width &&
        p + run < ix.tokens.length &&
        ix.tokens[base + i + run] === ix.tokens[p + run]
      ) {
        run += 1;
      }
      if (run > longest) longest = run;
      origins.add(originAt);
    }
    for (let j = i; j < i + longest; j++) covered[j] = true;
  }

  return {
    share: covered.filter(Boolean).length / width,
    originSec: [...origins].sort((a, b) => a - b),
  };
}

export interface TeaserRegion {
  /** Candidates STARTING before this second are montage-positioned. */
  endSec: number;
  /** Sentences in the region that reproduce distant speech. */
  hits: number;
  /** Their node indices, in order. */
  hitNodes: number[];
  /** Start of the first hit. */
  firstHitStartSec: number;
  /** End of the last hit - endSec minus the pad. */
  lastHitEndSec: number;
  /**
   * Seconds between the earliest and latest origin the hits reproduce.
   * DIAGNOSTIC ONLY - nothing decides on it. Measured, it separates every case
   * available (real montage 0.76 of runtime, jitter-degraded 0.26-0.36,
   * constructed 3-quote cold open 0.10), but the only evidence for a bar is a
   * construction, and 0.26 against a 0.25 bar is a one-sample margin. Emitted so
   * that a real production false positive can be checked against it instead of
   * argued about.
   */
  originSpreadSec: number;
}

/**
 * The opening stretch of the video that is a trailer montage, or null.
 *
 * Grown from the video's start: the first hit must arrive within
 * TEASER_MAX_HIT_GAP_SEC of t=0, and every hit after it within
 * TEASER_MAX_HIT_GAP_SEC of the previous hit's END. Non-recurring sentences
 * inside the run do not extend it and do not break it - the two that make up
 * the owner's defect sit between hits 10 and 11.
 *
 * Anchoring at the start is free safety and is the reason the hit bar can be as
 * low as 3: a repetition cluster anywhere else in the video cannot produce a
 * region by construction. The false-positive sweep that set the bar was run
 * UNANCHORED from all 1623 later offsets - strictly more permissive than what
 * ships - and its ceiling was 2.
 *
 * Set teaserWindowSec to 0 to switch the detector off entirely.
 */
export function detectTeaserRegion(
  nodes: SentenceNode[],
  cfg: TeaserConfig
): TeaserRegion | null {
  if (nodes.length === 0 || cfg.teaserWindowSec <= 0) return null;
  const ix = buildRecurrenceIndex(nodes);

  const hitNodes: number[] = [];
  const origins: number[] = [];
  let reach = 0; // last hit's end, or the video start before the first hit
  let firstHitStartSec = 0;
  let lastHitEndSec = 0;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.start > cfg.teaserWindowSec) break;
    if (node.start > reach + TEASER_MAX_HIT_GAP_SEC) break;
    const { share, originSec } = nodeRecurrence(ix, i);
    if (share < TEASER_RECUR_BAR) continue;
    if (hitNodes.length === 0) firstHitStartSec = node.start;
    hitNodes.push(i);
    origins.push(...originSec);
    reach = node.end;
    lastHitEndSec = node.end;
  }

  if (hitNodes.length < cfg.teaserMinHits) return null;
  return {
    endSec: lastHitEndSec + TEASER_REGION_PAD_SEC,
    hits: hitNodes.length,
    hitNodes,
    firstHitStartSec,
    lastHitEndSec,
    originSpreadSec: Math.max(...origins) - Math.min(...origins),
  };
}

/**
 * True when a candidate starting at this second opens inside the montage.
 *
 * Position, not content: a clip that STARTS here opens on a trailer stinger
 * whatever it goes on to say, and the fragment that motivated this module
 * reproduces nothing at all. Dropping such a candidate never loses the thought
 * - by construction the montage's material is spoken again later in full, where
 * it is actually finished.
 */
export function isInTeaserRegion(
  region: TeaserRegion | null,
  startSec: number
): boolean {
  return region !== null && startSec < region.endSec;
}
