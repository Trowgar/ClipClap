import type { SentenceNode } from "./types";

/**
 * Word n-gram size for the recurrence test.
 *
 * MEASURED, not assumed (2026-07-25, both eval fixtures = two transcription runs
 * of the same 52-minute episode). Max recurrence among candidates starting after
 * the opening window, i.e. the false-positive surface:
 *
 *   N=3  0.286  (14 of 32 ordinary candidates non-zero) - unusable
 *   N=4  0.012  (2 of 32 non-zero)
 *   N=5  0.000  (0 of 61 non-zero across both fixtures)   <- chosen
 *   N=6  0.000  but the montage signal starts collapsing (0.467 -> 0.286)
 *   N=7  0.000  and the montage is gone too (0.467 -> 0.077)
 *
 * Five is the smallest n at which ordinary speech stops accidentally repeating
 * itself, and it still keeps the montage signal at full strength. Four words in
 * a row recur by chance in a 52-minute conversation; five do not.
 */
export const TEASER_NGRAM = 5;

export interface TeaserConfig {
  teaserWindowSec: number;
  teaserRecurrenceFrac: number;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(words: string[]): string[] {
  if (words.length < TEASER_NGRAM) return [];
  const out: string[] = [];
  for (let i = 0; i + TEASER_NGRAM <= words.length; i++) {
    out.push(words.slice(i, i + TEASER_NGRAM).join(" "));
  }
  return out;
}

function textOf(nodes: SentenceNode[], from: number, to?: number): string {
  return nodes
    .slice(from, to)
    .map((n) => n.text)
    .join(" ");
}

/**
 * Share of the candidate's word 5-grams that reappear LATER in the transcript.
 *
 * An intro teaser montage is literally a copy of speech from further in, so its
 * n-grams occur twice; ordinary speech that merely shares vocabulary does not
 * repeat five words in a row. Recurrence is measured strictly after the
 * candidate's own end, which buys two things at once: internal repetition never
 * counts, and the ORIGINAL later occurrence measures 0 - only the copy that
 * comes first can ever be flagged.
 */
export function recurrenceFraction(
  nodes: SentenceNode[],
  startNode: number,
  endNode: number
): number {
  const candidate = ngrams(tokens(textOf(nodes, startNode, endNode + 1)));
  if (candidate.length === 0) return 0;
  const later = new Set(ngrams(tokens(textOf(nodes, endNode + 1))));
  if (later.size === 0) return 0;
  const hits = candidate.filter((g) => later.has(g)).length;
  return hits / candidate.length;
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
    recurrenceFraction(nodes, candidate.startNode, candidate.endNode) >=
    cfg.teaserRecurrenceFrac
  );
}
