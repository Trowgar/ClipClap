// apps/worker/src/scripts/asr-metrics.ts
/**
 * Normalizes the two transcript JSON shapes of the ASR comparison corpus
 * (Groq ASR spec §4.2) into one measurable form.
 *
 * - stored TranscriptionResult (from jobs.transcriptJson dumps): words nested
 *   per segment, `language` is ISO, `languageRaw` is Whisper's name;
 * - RawWhisperResponse (fresh API captures): words top-level, `language` is
 *   Whisper's name - capitalized on Groq.
 */

interface AnySegment {
  start: number;
  end: number;
  text: string;
  words?: Array<{ start: number; end: number }>;
}

export interface LoadedTranscript {
  /** Whitespace tokens of every segment's text - opaque segments included. */
  tokens: string[];
  totalSpanSec: number;
  /** Σ span of segments that carry word timings - the speechSec analogue. */
  coveredSec: number;
  /** w.start earlier than the previous word's end, counted before any clamp. */
  monotonicityViolations: number;
  /** Whisper's language NAME when present (languageRaw beats stored ISO). */
  languageRaw: string | null;
}

export function loadTranscript(json: {
  segments?: AnySegment[];
  words?: Array<{ start: number; end: number }>;
  language?: string;
  languageRaw?: string;
}): LoadedTranscript {
  const segments = json.segments ?? [];
  const topWords = json.words ?? [];
  const nested = segments.some((s) => (s.words?.length ?? 0) > 0);

  const tokens = segments
    .flatMap((s) => s.text.trim().split(/\s+/))
    .filter((t) => t.length > 0);

  let coveredSec = 0;
  for (const s of segments) {
    const words = nested
      ? s.words ?? []
      : topWords.filter((w) => w.start < s.end && w.end > s.start);
    if (words.length > 0) coveredSec += s.end - s.start;
  }

  const allWords = nested ? segments.flatMap((s) => s.words ?? []) : topWords;
  let monotonicityViolations = 0;
  let prevEnd = -Infinity;
  for (const w of allWords) {
    if (w.start < prevEnd) monotonicityViolations++;
    prevEnd = Math.max(prevEnd, w.end);
  }

  const first = segments[0]?.start ?? 0;
  const last = segments.length > 0 ? segments[segments.length - 1].end : 0;
  return {
    tokens,
    totalSpanSec: Math.max(0, last - first),
    coveredSec,
    monotonicityViolations,
    languageRaw: json.languageRaw ?? json.language ?? null,
  };
}
