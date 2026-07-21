import type { WhisperSegment, SubtitleWord } from "@clipclap/shared";
import type { AnalyzeConfig } from "./config";
import type { SentenceNode } from "./types";

const TERMINAL = /[.!?…。！？]$/;
const CLAUSE = /[,;:-]$/;
const MICRO_SEC = 0.4;
const MAX_WORD_SPAN_SEC = 3;

function wordsUnreliable(words: SubtitleWord[]): boolean {
  let prevStart = -Infinity;
  for (const w of words) {
    if (w.end <= w.start) return true;
    if (w.start < prevStart) return true;
    if (w.end - w.start > MAX_WORD_SPAN_SEC) return true;
    prevStart = w.start;
  }
  return false;
}

/** A node opens cleanly when its leading boundary is strong (>= 0.8: after
 *  terminal punctuation or a sentence-length pause) or it follows an opaque
 *  music/silence region. This is THE clean-start semantics - snap's guard and
 *  the critic's ¶ window markers must agree, so both consume this helper. */
export function isCleanStart(nodes: SentenceNode[], index: number): boolean {
  const n = nodes[index];
  if (!n) return false;
  return (
    n.leadingStrength >= 0.8 ||
    (index > 0 && nodes[index - 1].hasWords === false)
  );
}

export function buildSentenceGraph(
  segments: WhisperSegment[],
  cfg: AnalyzeConfig
): SentenceNode[] {
  // guard against out-of-order input: node indices must track time
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const raw: Omit<SentenceNode, "index" | "leadingStrength">[] = [];

  for (const seg of ordered) {
    const words = seg.words ?? [];
    if (words.length === 0 || wordsUnreliable(words)) {
      raw.push({
        start: seg.start,
        end: seg.end,
        text: seg.text,
        hasWords: false,
        trailingStrength: 0.2,
      });
      continue;
    }

    let current: SubtitleWord[] = [];
    const emit = (run: SubtitleWord[], strength: number) => {
      raw.push({
        start: run[0].start,
        // max, not last: word timings may nest (a long word containing a short
        // one passes the reliability check), and the node must cover its tail
        end: Math.max(...run.map((w) => w.end)),
        text: run.map((w) => w.text).join(" "),
        hasWords: true,
        trailingStrength: strength,
      });
    };
    const close = (strength: number) => {
      if (current.length === 0) return;
      emit(current, strength);
      current = [];
    };
    // Length-limit split: close at the largest interior gap (the most natural
    // pause seen so far) and carry the remaining words forward - they stay
    // open and may close again on punctuation, gaps, or another force-split.
    const forceSplit = () => {
      if (current.length < 2) {
        close(0.3);
        return;
      }
      let splitAfter = 0;
      let bestGap = -Infinity;
      for (let k = 0; k < current.length - 1; k++) {
        const g = current[k + 1].start - current[k].end;
        // >= so ties prefer the latest gap: with uniform gaps this keeps the
        // head close to nodeMaxSec instead of shaving single-word slivers
        if (g >= bestGap) {
          bestGap = g;
          splitAfter = k;
        }
      }
      emit(current.slice(0, splitAfter + 1), 0.3);
      current = current.slice(splitAfter + 1);
    };

    for (let i = 0; i < words.length; i++) {
      current.push(words[i]);
      const w = words[i];
      const next = words[i + 1];
      const gap = next ? next.start - w.end : 0;
      const runningLen = w.end - current[0].start;

      if (TERMINAL.test(w.text)) close(1.0);
      else if (next && gap >= cfg.gapSentence) close(0.8);
      else if (CLAUSE.test(w.text) || (next && gap >= cfg.gapPhrase)) close(0.4);
      else if (runningLen >= cfg.nodeMaxSec) forceSplit();
    }
    close(0.8); // segment end is a Whisper boundary
  }

  // micro-merge: keep folding word-bearing neighbors forward while the
  // accumulated node is still shorter than MICRO_SEC, so chains of 3+
  // tiny fragments collapse into one node instead of pairing greedily
  const merged: typeof raw = [];
  let i = 0;
  while (i < raw.length) {
    let node = raw[i];
    i += 1;
    while (
      node.hasWords &&
      node.end - node.start < MICRO_SEC &&
      i < raw.length &&
      raw[i].hasWords
    ) {
      const next = raw[i];
      node = {
        start: node.start,
        end: Math.max(node.end, next.end),
        text: `${node.text} ${next.text}`,
        hasWords: true,
        trailingStrength: next.trailingStrength,
      };
      i += 1;
    }
    merged.push(node);
  }

  return merged.map((n, index) => ({
    ...n,
    index,
    leadingStrength: index === 0 ? 1.0 : merged[index - 1].trailingStrength,
  }));
}
