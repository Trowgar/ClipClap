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

export function buildSentenceGraph(
  segments: WhisperSegment[],
  cfg: AnalyzeConfig
): SentenceNode[] {
  const raw: Omit<SentenceNode, "index" | "leadingStrength">[] = [];

  for (const seg of segments) {
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
    const close = (strength: number) => {
      if (current.length === 0) return;
      raw.push({
        start: current[0].start,
        end: current[current.length - 1].end,
        text: current.map((w) => w.text).join(" "),
        hasWords: true,
        trailingStrength: strength,
      });
      current = [];
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
      else if (runningLen >= cfg.nodeMaxSec) close(0.3);
    }
    close(0.8); // segment end is a Whisper boundary
  }

  // micro-merge: fold sub-0.4s fragments forward into the next node
  const merged: typeof raw = [];
  for (let i = 0; i < raw.length; i++) {
    const node = raw[i];
    const next = raw[i + 1];
    if (node.hasWords && next && next.hasWords && node.end - node.start < MICRO_SEC) {
      merged.push({
        start: node.start,
        end: next.end,
        text: `${node.text} ${next.text}`,
        hasWords: true,
        trailingStrength: next.trailingStrength,
      });
      i += 1;
      continue;
    }
    merged.push(node);
  }

  return merged.map((n, index) => ({
    ...n,
    index,
    leadingStrength: index === 0 ? 1.0 : merged[index - 1].trailingStrength,
  }));
}
