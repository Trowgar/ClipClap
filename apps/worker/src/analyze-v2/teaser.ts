import type { SentenceNode } from "./types";

/**
 * Shortest verbatim word run that counts as evidence of a copy.
 *
 * MEASURED, not assumed (2026-07-25, both eval fixtures = two transcription
 * runs of the same 52-minute episode). Max score among candidates starting
 * after the opening window, i.e. the false-positive surface:
 *
 *   run=3  0.667  (23 of 61 ordinary candidates non-zero) - unusable
 *   run=4  0.047  (3 of 61 non-zero)
 *   run=5  0.000  (0 of 61 non-zero across both fixtures)   <- chosen
 *
 * Four words in a row recur by chance in a 52-minute conversation ("и так
 * далее", "с одной стороны"); five do not.
 */
export const TEASER_MIN_RUN = 5;

/**
 * Candidates at or below this many words also get the substitution-tolerant
 * test below. The cutoff is arithmetic, not taste: one respelled word at
 * position i splits a w-word candidate into a prefix of i and a suffix of
 * w-1-i, and only runs of TEASER_MIN_RUN survive. Worst case (the middle word),
 * that leaves coverage 0.000 up to w=9 and exactly 0.500 at w=10 - on the
 * default bar, not above it. From eleven words up the worst case is 10/11, so
 * a long candidate carries a respelling by itself and needs no help.
 */
export const TEASER_SHORT_WORDS = 10;

/**
 * How many words a short candidate must line up in one later passage. Equal to
 * TEASER_MIN_RUN on purpose: the evidence bar does not move, only the
 * requirement that the evidence be contiguous.
 */
export const TEASER_MIN_ALIGNED = 5;

export interface TeaserConfig {
  teaserWindowSec: number;
  teaserRecurrenceFrac: number;
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
 * character rule can repair - that is what the substitution tolerance below is
 * for. Scripts written without spaces (Chinese, Japanese, Thai) collapse into a
 * handful of huge tokens here and simply never score, so the filter is inert on
 * them rather than wrong.
 */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function textOf(nodes: SentenceNode[], from: number, to?: number): string {
  return nodes
    .slice(from, to)
    .map((n) => n.text)
    .join(" ");
}

/**
 * Share of the candidate's words that sit inside a verbatim run of at least
 * TEASER_MIN_RUN words occurring in the later text.
 *
 * Counting WORDS rather than n-gram windows is what makes a long montage
 * robust: a run of five words is five words of evidence wherever it falls,
 * including at the very edge of the candidate, where the n-gram count used to
 * collapse. And because the covered positions are unioned, fragments spliced
 * from different later moments - which is exactly what a montage is - add up
 * instead of competing.
 */
function runCoverage(candidate: string[], later: string[]): number {
  const k = TEASER_MIN_RUN;
  if (candidate.length < k || later.length < k) return 0;

  const starts = new Map<string, number[]>();
  for (let i = 0; i + k <= later.length; i++) {
    const key = later.slice(i, i + k).join(" ");
    const at = starts.get(key);
    if (at) at.push(i);
    else starts.set(key, [i]);
  }

  const covered = new Array<boolean>(candidate.length).fill(false);
  for (let i = 0; i + k <= candidate.length; i++) {
    const at = starts.get(candidate.slice(i, i + k).join(" "));
    if (!at) continue;
    let longest = k;
    for (const s of at) {
      let len = k;
      while (
        i + len < candidate.length &&
        s + len < later.length &&
        candidate[i + len] === later[s + len]
      ) {
        len += 1;
      }
      if (len > longest) longest = len;
    }
    for (let j = i; j < i + longest; j++) covered[j] = true;
  }
  return covered.filter(Boolean).length / candidate.length;
}

/**
 * Share of the candidate's words that line up, in place, inside the single best
 * later window of the candidate's own length.
 *
 * This is the part that survives a respelled word: a substitution costs one
 * word instead of destroying every run through it. The safety comes from
 * insisting on ONE window - the matched words must be the same passage said
 * again, in order, at the same spacing. Words that merely recur here and there
 * across the transcript land on different offsets and never accumulate, which
 * is what separates a copy from a speaker's stock phrases.
 *
 * Scored 0 below TEASER_MIN_ALIGNED matches so a handful of common words can
 * never carry a verdict on their own.
 */
function alignedShare(candidate: string[], later: string[]): number {
  if (candidate.length === 0) return 0;

  const positions = new Map<string, number[]>();
  later.forEach((word, i) => {
    const at = positions.get(word);
    if (at) at.push(i);
    else positions.set(word, [i]);
  });

  // One vote per (candidate word, later occurrence) pair, keyed by the offset
  // that would align them. The winning offset IS the best window, found without
  // sliding one.
  const votes = new Map<number, number>();
  let best = 0;
  candidate.forEach((word, i) => {
    const at = positions.get(word);
    if (!at) return;
    for (const p of at) {
      const offset = p - i;
      const n = (votes.get(offset) ?? 0) + 1;
      votes.set(offset, n);
      if (n > best) best = n;
    }
  });

  if (best < TEASER_MIN_ALIGNED) return 0;
  return best / candidate.length;
}

/**
 * How much of a candidate is speech copied from LATER in the transcript.
 *
 * An intro teaser montage is literally a copy of speech from further in, so it
 * reappears; ordinary speech that merely shares vocabulary does not reproduce
 * five words in a row. Recurrence is measured strictly after the candidate's
 * own end, which buys two things at once: internal repetition never counts, and
 * the ORIGINAL later occurrence measures 0 - only the copy that comes first can
 * ever be flagged.
 *
 * Two readings of the same evidence, whichever is stronger:
 *   - verbatim run coverage, which handles montages of any length and any
 *     number of spliced fragments;
 *   - for candidates too short to carry a run around a respelling, alignment
 *     against one later passage, which tolerates a wrong word.
 */
export function montageScore(
  nodes: SentenceNode[],
  startNode: number,
  endNode: number
): number {
  const candidate = tokens(textOf(nodes, startNode, endNode + 1));
  if (candidate.length === 0) return 0;
  const later = tokens(textOf(nodes, endNode + 1));
  if (later.length === 0) return 0;

  const verbatim = runCoverage(candidate, later);
  if (candidate.length > TEASER_SHORT_WORDS) return verbatim;
  return Math.max(verbatim, alignedShare(candidate, later));
}

/**
 * True when a candidate in the video's opening window is a montage copy.
 *
 * Only the opening window is examined and only against LATER text, so a normal
 * intro that shares vocabulary with the body cannot trip it - the montage
 * matches because it is the same sentences. Dropping such a candidate never
 * loses content: by construction the same words exist later in full, where the
 * thought is actually finished.
 */
export function isTeaserCandidate(
  nodes: SentenceNode[],
  candidate: { startNode: number; endNode: number },
  cfg: TeaserConfig
): boolean {
  const node = nodes[candidate.startNode];
  if (!node || node.start > cfg.teaserWindowSec) return false;
  return (
    montageScore(nodes, candidate.startNode, candidate.endNode) >=
    cfg.teaserRecurrenceFrac
  );
}
