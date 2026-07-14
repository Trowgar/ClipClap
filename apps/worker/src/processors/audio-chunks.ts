import type { SubtitleWord, WhisperSegment } from "@clipclap/shared";

export interface SilenceInterval {
  start: number;
  end: number;
}

export interface ChunkPlan {
  start: number;
  end: number;
  /** Non-null when the seam is a hard cut: transcription overlap starts here. */
  overlapStart: number | null;
}

export interface RawChunkTranscript {
  offsetSec: number;
  text: string;
  segments: WhisperSegment[];
}

export interface StitchedTranscript {
  text: string;
  segments: WhisperSegment[];
  coverage: number;
  missingRanges: Array<{ start: number; end: number; reason: string }>;
}

export function parseSilences(stderr: string): SilenceInterval[] {
  const result: SilenceInterval[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split("\n")) {
    const startMatch = line.match(/silence_start:\s*([\d.]+)/);
    if (startMatch) {
      pendingStart = Number(startMatch[1]);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([\d.]+)/);
    if (endMatch && pendingStart !== null) {
      result.push({ start: pendingStart, end: Number(endMatch[1]) });
      pendingStart = null;
    }
  }
  return result;
}

export function planChunks(
  durationSec: number,
  silences: SilenceInterval[],
  chunkSec: number,
  seekWindowSec: number,
  overlapSec: number
): ChunkPlan[] {
  if (durationSec <= chunkSec) {
    return [{ start: 0, end: durationSec, overlapStart: null }];
  }

  const chunks: ChunkPlan[] = [];
  let cursor = 0;
  let pendingOverlapStart: number | null = null;

  while (cursor < durationSec) {
    const start = cursor;
    const target = start + chunkSec;
    const overlapStart = pendingOverlapStart;
    pendingOverlapStart = null;

    if (target >= durationSec) {
      chunks.push({ start, end: durationSec, overlapStart });
      break;
    }

    const silence = silences
      .map((s) => ({ seam: (s.start + s.end) / 2 }))
      .filter(({ seam }) => Math.abs(seam - target) <= seekWindowSec && seam > start)
      .sort((a, b) => Math.abs(a.seam - target) - Math.abs(b.seam - target))[0];

    if (silence) {
      chunks.push({ start, end: silence.seam, overlapStart });
      cursor = silence.seam;
    } else {
      chunks.push({ start, end: target, overlapStart });
      cursor = target - overlapSec;
      pendingOverlapStart = cursor;
    }
  }
  return chunks;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function stitchTranscripts(
  chunks: RawChunkTranscript[],
  opts: {
    totalDurationSec?: number;
    missingRanges?: Array<{ start: number; end: number; reason: string }>;
  } = {}
): StitchedTranscript {
  // 1. re-offset every chunk into the source timeline
  const shifted = chunks.map((c) => ({
    ...c,
    segments: c.segments.map((s) => ({
      ...s,
      start: s.start + c.offsetSec,
      end: s.end + c.offsetSec,
      words: s.words?.map((w) => ({
        ...w,
        start: w.start + c.offsetSec,
        end: w.end + c.offsetSec,
      })),
    })),
  }));

  // 2. seam dedup: for each adjacent pair, find the longest common word-token
  //    run inside the time overlap; keep the previous chunk's version of the
  //    matched run, cut the next chunk at the seam
  const result: WhisperSegment[] = [];
  let carry: WhisperSegment[] = shifted[0]?.segments ?? [];

  for (let k = 1; k < shifted.length; k++) {
    const next = shifted[k].segments;
    const overlapStart = shifted[k].offsetSec;
    const carryEnd = carry.length > 0 ? carry[carry.length - 1].end : -Infinity;
    const prevTail = carry.filter((s) => s.end > overlapStart);
    const nextHead = next.filter((s) => s.start < carryEnd);

    let seam = overlapStart; // temporal fallback
    const prevWords = prevTail.flatMap((s) => s.words ?? []);
    const nextWords = nextHead.flatMap((s) => s.words ?? []);
    const match = longestCommonRun(prevWords, nextWords);
    if (match) {
      seam = match.prevEndTime;
    }

    result.push(...carry.filter((s) => s.start < seam || !prevTail.includes(s)));
    carry = next
      .filter((s) => s.end > seam)
      .map((s) => ({
        ...s,
        words: s.words?.filter((w) => w.start >= seam),
      }));
  }
  result.push(...carry);

  // 3. enforce monotonic word times - violations clamp to the previous edge
  let prevEnd = 0;
  for (const s of result) {
    if (!s.words) continue;
    for (const w of s.words) {
      if (w.start < prevEnd) w.start = prevEnd;
      if (w.end <= w.start) w.end = w.start + 0.05;
      prevEnd = w.end;
    }
  }

  const missingRanges = opts.missingRanges ?? [];
  const total = opts.totalDurationSec ?? Math.max(...result.map((s) => s.end), 0);
  const missing = missingRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
  const coverage = total > 0 ? Math.max(0, Math.min(1, (total - missing) / total)) : 1;

  return {
    text: result.map((s) => s.text).join(" ").trim(),
    segments: result,
    coverage,
    missingRanges,
  };
}

/** Longest common contiguous normalized-token run (>= 2 tokens) in the overlap. */
function longestCommonRun(
  prevWords: SubtitleWord[],
  nextWords: SubtitleWord[]
): { prevEndTime: number } | null {
  if (prevWords.length === 0 || nextWords.length === 0) return null;
  const a = prevWords.map((w) => norm(w.text));
  const b = nextWords.map((w) => norm(w.text));
  let best = { len: 0, aEnd: -1 };
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] !== "" && a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > best.len) best = { len: dp[i][j], aEnd: i - 1 };
      }
    }
  }
  if (best.len < 2) return null;
  return { prevEndTime: prevWords[best.aEnd].end };
}
