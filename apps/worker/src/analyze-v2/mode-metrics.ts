import type { WhisperSegment } from "@clipclap/shared";
import type { AnalyzeConfig } from "./config";
import { isReliableSegment } from "./sentence-graph";

/**
 * Stream resolver v2 metrics (spec 2026-08-25-mid-rescue-and-stream-
 * resolver-v2, part 2). Moved VERBATIM (per the spec's own implementer
 * note) from the measurement/prep artifact at
 * .corpus/feedback-audit/stream-mode/v2/resolver-v2-metrics.ts, with two
 * mechanical changes only: the local V2Word/V2Segment shapes and the
 * private wordsUnreliable/isReliableSegment copies are replaced by the real
 * @clipclap/shared WhisperSegment type and the now-exported
 * sentence-graph.ts isReliableSegment (no re-implementation - see that
 * file's doc comment), and the three threshold constants move to
 * AnalyzeConfig (config.ts) instead of living as module consts here, so
 * they are env-overridable the same way streamDensityMax already is.
 *
 * Full derivation, corpus numbers, and the two rejected reliableMetric
 * candidates (reliable wpm, reliable speech-sec) are documented in the prep
 * file above - not re-derived here.
 */

// ---------------------------------------------------------------------
// Metric 1: density
// ---------------------------------------------------------------------
/**
 * density = (reliable-segment speech seconds) / sourceDurationSec.
 *
 * Numerator: for each RELIABLE segment, its speech span is
 * (max word.end - min word.start) - NOT (segment.end - segment.start).
 * Validated against the 54-job corpus: the word-span form reproduces
 * engine_speech_sec/engine_density EXACTLY (0/54 mismatches, tolerance
 * 0.0005); segment.end - segment.start does not (28/54 rows off).
 */
export function computeDensity(
  segments: WhisperSegment[],
  sourceDurationSec: number
): number {
  if (!sourceDurationSec || sourceDurationSec <= 0) return 0;
  let speechSec = 0;
  for (const seg of segments) {
    if (!isReliableSegment(seg)) continue;
    const words = seg.words!; // isReliableSegment guarantees non-empty
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const w of words) {
      if (w.start < minStart) minStart = w.start;
      if (w.end > maxEnd) maxEnd = w.end;
    }
    speechSec += maxEnd - minStart;
  }
  return speechSec / sourceDurationSec;
}

// ---------------------------------------------------------------------
// Metric 2: medianSegmentSec
// ---------------------------------------------------------------------
/**
 * medianSegmentSec = median of (segment.end - segment.start) over ALL
 * segments - reliable AND opaque both included. This is deliberate, and
 * matches the corpus measurement exactly (0/54 mismatches at 0.02s
 * tolerance): restricting to reliable-only segments does NOT reproduce it
 * (mismatches on the large majority of rows, often 15-30% off). The name
 * "medianSegmentSec" (not "medianReliableSegmentSec") reflects that on
 * purpose - see the prep file's doc comment for the two example rows.
 */
export function computeMedianSegmentSec(segments: WhisperSegment[]): number {
  if (segments.length === 0) return 0;
  const durs = segments.map((s) => s.end - s.start).sort((a, b) => a - b);
  const n = durs.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (durs[mid - 1] + durs[mid]) / 2 : durs[mid];
}

// ---------------------------------------------------------------------
// Metric 3: reliableSegmentShare
// ---------------------------------------------------------------------
/**
 * reliableSegmentShare = (# reliable segments) / (total segment count).
 *
 * DIRECTION IS A CEILING, NOT A FLOOR, despite the "floor" language in the
 * spec prose: real streams have a LOWER reliable-segment share than the
 * degenerate transcripts the density+median conjuncts alone let through.
 * Genuine crosstalk/game-audio/laughter on a stream produces more opaque
 * (unreliable-word-timing) segments, while a garbled-but-mechanically-
 * confident ASR transcript (wrong language, transliterated noise, a
 * repeating technical code) still produces well-formed monotonic word
 * timings that PASS the reliability check even though the content is
 * meaningless. So "reliable" here measures ASR timing hygiene, not content
 * quality, and genuine streams score LOWER on it - hence
 * `reliableSegmentShare <= cfg.streamReliableShareMax`, not `>=`.
 *
 * Corpus separation (n=3 true streams / 3 relevant degenerate jobs, the
 * 4th already excluded by medianSegmentSec): streams 0.6296 / 0.6468 /
 * 0.7656 (max 0.7656) vs degenerate 0.7951 / 0.8702 / 0.8777 (min 0.7951).
 * Gap 0.0295, both margins ~1.9% relative - a THIN margin on n=3, flagged
 * in config.ts's doc comment for the same knob.
 */
export function computeReliableSegmentShare(segments: WhisperSegment[]): number {
  if (segments.length === 0) return 0;
  const reliableCount = segments.filter(isReliableSegment).length;
  return reliableCount / segments.length;
}

export interface V2Metrics {
  density: number;
  medianSegmentSec: number;
  reliableSegmentShare: number;
  /** Segment count backing the other three fields. Defensive - not part of
   *  the spec's own three conjuncts, but density/medianSegmentSec/
   *  reliableSegmentShare all vacuously satisfy their thresholds at 0
   *  (0 < 0.45, 0 < 2.8, 0 <= 0.78), so an empty segments array would
   *  otherwise read as "passes" on the function's own terms even though
   *  no real transcript exists. */
  segmentCount: number;
}

/**
 * The v2 density-fallback conjunct (mode.ts rule 3, tightened): all THREE
 * spec conjuncts must hold, PLUS a defensive segmentCount > 0 (review nit,
 * not a spec conjunct): density/medianSegmentSec/reliableSegmentShare all
 * vacuously satisfy their thresholds at 0 (0 < 0.45, 0 < 2.8, 0 <= 0.78),
 * so without this an empty segments array would read "passes" on this
 * function's own terms - not reachable from production (the degenerate
 * guard in index.ts returns before mode resolution for a near-empty
 * transcript), but the function itself should not depend on that ordering
 * to be correct. Does NOT apply the >1200s duration gate or the host rules
 * (twitch/youtube-live) - those are mode.ts's own unchanged concerns.
 * Thresholds come from cfg (config.ts), never hardcoded here, so a single
 * env-overridable knob set backs both the resolver and any test that wants
 * to override it via loadAnalyzeConfig.
 */
export function passesV2DensityFallback(
  metrics: V2Metrics,
  cfg: AnalyzeConfig
): boolean {
  return (
    metrics.segmentCount > 0 &&
    metrics.density < cfg.streamDensityMaxV2 &&
    metrics.medianSegmentSec < cfg.streamMedianSegMaxSec &&
    metrics.reliableSegmentShare <= cfg.streamReliableShareMax
  );
}
