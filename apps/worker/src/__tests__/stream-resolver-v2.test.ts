import { describe, expect, it } from "vitest";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { resolveAnalysisMode, computeModeResolution, resolveMode } from "../analyze-v2/mode";
import {
  computeDensity,
  computeMedianSegmentSec,
  computeReliableSegmentShare,
  passesV2DensityFallback,
} from "../analyze-v2/mode-metrics";
import type { WhisperSegment } from "@clipclap/shared";

/**
 * Stream resolver v2 (spec 2026-08-25-mid-rescue-and-stream-resolver-v2,
 * part 2): behind ANALYZE_STREAM_RESOLVER_V2=on, the density fallback in
 * mode.ts's resolveAnalysisMode requires all three: density <
 * streamDensityMaxV2 (0.45), medianSegmentSec < streamMedianSegMaxSec
 * (2.8), reliableSegmentShare <= streamReliableShareMax (0.78, a CEILING -
 * real streams have LOWER reliable share than degenerate transcripts, see
 * mode-metrics.ts's computeReliableSegmentShare doc comment). Host rules
 * (twitch, youtube.com/live/) and the existing durationSec > 1200 gate are
 * unchanged. Flag off -> byte-identical to today (density < 0.55 alone).
 *
 * Fixtures below are synthetic and deliberately decouple the two fields
 * each metric reads: computeDensity only reads word timestamps (min start /
 * max end of each RELIABLE segment's words), computeMedianSegmentSec only
 * reads segment.start/segment.end, and computeReliableSegmentShare only
 * reads segment counts. That decoupling (real transcripts happen to keep
 * word timestamps inside their segment's [start,end], these fixtures do
 * not bother to) is what lets each fixture isolate one conjunct at its
 * exact boundary while holding the other two safely inside their passing
 * range - see each fixture's own comment for the arithmetic.
 */

const cfgV2 = loadAnalyzeConfig({
  ANALYZE_STREAM_MODE: "on",
  ANALYZE_STREAM_RESOLVER_V2: "on",
});
const cfgOldOn = loadAnalyzeConfig({ ANALYZE_STREAM_MODE: "on" }); // v2 flag off
const cfgOff = loadAnalyzeConfig({});

function seg(
  start: number,
  end: number,
  words?: { start: number; end: number }[]
): WhisperSegment {
  return {
    start,
    end,
    text: "x",
    words: words?.map((w) => ({ text: "w", start: w.start, end: w.end })),
  };
}

describe("mode-metrics.ts - pure metric functions", () => {
  it("computeDensity: word-span (max end - min start) of RELIABLE segments only, over sourceDurationSec", () => {
    const segments: WhisperSegment[] = [
      seg(0, 2, [{ start: 0, end: 3 }, { start: 42, end: 45 }]), // reliable, span 45
      seg(2, 4), // opaque (no words) - excluded
    ];
    expect(computeDensity(segments, 100)).toBeCloseTo(0.45, 10);
  });

  it("computeMedianSegmentSec: median of (end - start) over ALL segments, reliable and opaque both", () => {
    const segments: WhisperSegment[] = [
      seg(0, 2.8, [{ start: 0, end: 1 }]),
      seg(2.8, 5.6, [{ start: 2.8, end: 3.8 }]),
      seg(5.6, 5.7), // opaque
    ];
    // durations [2.8, 2.8, 0.1] sorted -> median is the middle value, 2.8
    expect(computeMedianSegmentSec(segments)).toBeCloseTo(2.8, 10);
  });

  it("computeReliableSegmentShare: reliable segment count / total segment count", () => {
    const segments: WhisperSegment[] = [
      seg(0, 1, [{ start: 0, end: 1 }]),
      seg(1, 2, [{ start: 1, end: 2 }]),
      seg(2, 3), // opaque
      seg(3, 4), // opaque
    ];
    expect(computeReliableSegmentShare(segments)).toBeCloseTo(0.5, 10);
  });
});

describe("passesV2DensityFallback - the 5 boundary fixtures", () => {
  // ---------------------------------------------------------------------
  // Fixture 1: density boundary. Reliable segment's words span exactly
  // 0.45 * sourceDurationSec (45 / 100) -> density === 0.45 exactly ->
  // must NOT pass (strict <). Shaving one word-second off the span drops
  // density to 0.44 and it passes. medianSegmentSec (both segments 2s) and
  // reliableSegmentShare (1 reliable / 2 total = 0.5) stay safely inside
  // range throughout, so only the density conjunct is under test.
  // ---------------------------------------------------------------------
  it("fixture 1 - density boundary: exactly 0.45 rejects (strict <), 0.44 passes", () => {
    const atBoundary: WhisperSegment[] = [
      seg(0, 2, [{ start: 0, end: 3 }, { start: 42, end: 45 }]), // span 45
      seg(2, 4),
    ];
    const metricsAt = {
      density: computeDensity(atBoundary, 100),
      medianSegmentSec: computeMedianSegmentSec(atBoundary),
      reliableSegmentShare: computeReliableSegmentShare(atBoundary),
      segmentCount: atBoundary.length,
    };
    expect(metricsAt.density).toBeCloseTo(0.45, 10);
    expect(metricsAt.medianSegmentSec).toBeLessThan(2.8);
    expect(metricsAt.reliableSegmentShare).toBeLessThanOrEqual(0.78);
    expect(passesV2DensityFallback(metricsAt, cfgV2)).toBe(false);

    const justUnder: WhisperSegment[] = [
      seg(0, 2, [{ start: 0, end: 3 }, { start: 42, end: 44 }]), // span 44
      seg(2, 4),
    ];
    const metricsUnder = {
      density: computeDensity(justUnder, 100),
      medianSegmentSec: computeMedianSegmentSec(justUnder),
      reliableSegmentShare: computeReliableSegmentShare(justUnder),
      segmentCount: justUnder.length,
    };
    expect(metricsUnder.density).toBeCloseTo(0.44, 10);
    expect(passesV2DensityFallback(metricsUnder, cfgV2)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Fixture 2: medianSegmentSec boundary. Durations [2.8, 2.8, 0.1] ->
  // median 2.8 exactly -> must NOT pass (strict <). Shaving the second
  // segment's duration to 2.7 drops the median to 2.7 and it passes.
  // density (0.002) and reliableSegmentShare (2/3 = 0.667) stay safely
  // inside range throughout (word spans untouched by the shave, since
  // computeMedianSegmentSec never reads words).
  // ---------------------------------------------------------------------
  it("fixture 2 - medianSegmentSec boundary: exactly 2.8 rejects (strict <), 2.7 passes", () => {
    const atBoundary: WhisperSegment[] = [
      seg(0, 2.8, [{ start: 0, end: 1 }]),
      seg(2.8, 5.6, [{ start: 2.8, end: 3.8 }]),
      seg(5.6, 5.7),
    ];
    const metricsAt = {
      density: computeDensity(atBoundary, 1000),
      medianSegmentSec: computeMedianSegmentSec(atBoundary),
      reliableSegmentShare: computeReliableSegmentShare(atBoundary),
      segmentCount: atBoundary.length,
    };
    expect(metricsAt.medianSegmentSec).toBeCloseTo(2.8, 10);
    expect(metricsAt.density).toBeLessThan(0.45);
    expect(metricsAt.reliableSegmentShare).toBeLessThanOrEqual(0.78);
    expect(passesV2DensityFallback(metricsAt, cfgV2)).toBe(false);

    const justUnder: WhisperSegment[] = [
      seg(0, 2.8, [{ start: 0, end: 1 }]),
      seg(2.8, 5.5, [{ start: 2.8, end: 3.8 }]), // duration now 2.7
      seg(5.5, 5.6),
    ];
    const metricsUnder = {
      density: computeDensity(justUnder, 1000),
      medianSegmentSec: computeMedianSegmentSec(justUnder),
      reliableSegmentShare: computeReliableSegmentShare(justUnder),
      segmentCount: justUnder.length,
    };
    expect(metricsUnder.medianSegmentSec).toBeCloseTo(2.7, 10);
    expect(passesV2DensityFallback(metricsUnder, cfgV2)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Fixture 3: reliableSegmentShare boundary, <= not <. 100 uniform
  // 1-second segments, 78 reliable / 22 opaque -> share === 0.78 exactly
  // -> MUST pass (the gate is <=). Flipping one more opaque segment to
  // reliable (79/100 = 0.79) pushes it just over 0.78 and it must fail.
  // density (0.078) and medianSegmentSec (1, all segments equal) stay
  // safely inside range throughout.
  // ---------------------------------------------------------------------
  it("fixture 3 - reliableSegmentShare boundary: exactly 0.78 passes (<=), 0.79 fails", () => {
    function build(reliableCount: number): WhisperSegment[] {
      return Array.from({ length: 100 }, (_, i) => {
        const isReliable = i < reliableCount;
        return seg(i, i + 1, isReliable ? [{ start: i, end: i + 1 }] : undefined);
      });
    }

    const atBoundary = build(78);
    const metricsAt = {
      density: computeDensity(atBoundary, 1000),
      medianSegmentSec: computeMedianSegmentSec(atBoundary),
      reliableSegmentShare: computeReliableSegmentShare(atBoundary),
      segmentCount: atBoundary.length,
    };
    expect(metricsAt.reliableSegmentShare).toBeCloseTo(0.78, 10);
    expect(metricsAt.density).toBeLessThan(0.45);
    expect(metricsAt.medianSegmentSec).toBeLessThan(2.8);
    expect(passesV2DensityFallback(metricsAt, cfgV2)).toBe(true);

    const justOver = build(79);
    const metricsOver = {
      density: computeDensity(justOver, 1000),
      medianSegmentSec: computeMedianSegmentSec(justOver),
      reliableSegmentShare: computeReliableSegmentShare(justOver),
      segmentCount: justOver.length,
    };
    expect(metricsOver.reliableSegmentShare).toBeCloseTo(0.79, 10);
    expect(passesV2DensityFallback(metricsOver, cfgV2)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Fixture 4: all-three-pass, modeled on cmt5lnand's real corpus numbers
  // (density ~0.30, medianSegmentSec ~2.36, reliableSegmentShare ~0.77) -
  // the only true stream in the corpus NOT caught by a host rule. All
  // three conjuncts comfortably true, well clear of any boundary.
  // ---------------------------------------------------------------------
  it("fixture 4 - all three comfortably pass (cmt5lnand-shaped) -> stream", () => {
    const segments: WhisperSegment[] = [
      seg(0, 2.36, [{ start: 0, end: 3 }, { start: 297, end: 300 }]), // span 300
      seg(2.36, 4.72, [{ start: 300, end: 303 }]), // span 3
      seg(4.72, 7.08), // opaque
    ];
    // density = (300 + 3) / 1000 = 0.303
    const metrics = {
      density: computeDensity(segments, 1000),
      medianSegmentSec: computeMedianSegmentSec(segments),
      reliableSegmentShare: computeReliableSegmentShare(segments),
      segmentCount: segments.length,
    };
    expect(metrics.density).toBeCloseTo(0.303, 10);
    expect(metrics.medianSegmentSec).toBeCloseTo(2.36, 10);
    expect(metrics.reliableSegmentShare).toBeCloseTo(2 / 3, 10);
    expect(passesV2DensityFallback(metrics, cfgV2)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Fixture 5: degenerate-shaped, modeled on cmt42w0fw (very low density,
  // very low medianSegmentSec, but HIGH reliableSegmentShare ~0.87 -
  // fully-reliable here: 2/2 = 1.0, well past the 0.78 ceiling). Density
  // and median both pass comfortably; reliableSegmentShare ALONE must
  // reject it - proving the third conjunct is load-bearing, not redundant
  // with the first two.
  // ---------------------------------------------------------------------
  it("fixture 5 - degenerate-shaped (cmt42w0fw-like): reliableSegmentShare alone rejects", () => {
    const segments: WhisperSegment[] = [
      seg(0, 0.16, [{ start: 0, end: 3 }, { start: 19, end: 22 }]), // span 22, reliable (each word's own span stays <= 3s)
      seg(0.16, 0.32, [{ start: 30, end: 33 }]), // span 3, reliable
    ];
    // density = (22 + 3) / 100 = 0.25
    const metrics = {
      density: computeDensity(segments, 100),
      medianSegmentSec: computeMedianSegmentSec(segments),
      reliableSegmentShare: computeReliableSegmentShare(segments),
      segmentCount: segments.length,
    };
    expect(metrics.density).toBeCloseTo(0.25, 10);
    expect(metrics.medianSegmentSec).toBeCloseTo(0.16, 10);
    expect(metrics.reliableSegmentShare).toBe(1); // 2/2 - no opaque segment at all
    expect(metrics.density).toBeLessThan(0.45);
    expect(metrics.medianSegmentSec).toBeLessThan(2.8);
    expect(metrics.reliableSegmentShare).toBeGreaterThan(0.78);
    expect(passesV2DensityFallback(metrics, cfgV2)).toBe(false);
  });
});

describe("resolveAnalysisMode - v2 wiring, host/live/flag-off behaviour", () => {
  it("flag off -> byte-identical to today, including a 0.50-density job that flips under v2", () => {
    // Old-style: speechSec/durationSec = 1000/2000 = 0.50 < streamDensityMax
    // (0.55) -> stream, exactly like the pre-existing analyze-mode.test.ts
    // density-fallback tests.
    const oldInput = { durationSec: 2000, speechSec: 1000, segments: [] };
    expect(resolveAnalysisMode(oldInput, cfgOldOn)).toBe("stream");

    // Same job, v2 flag on: segments-derived density computed by mode-
    // metrics.ts's computeDensity is ALSO ~0.50 (>= streamDensityMaxV2's
    // 0.45), so the v2 density conjunct alone now rejects it.
    const segments: WhisperSegment[] = [
      seg(0, 2, [{ start: 0, end: 3 }, { start: 997, end: 1000 }]), // span 1000 (each word's own span <= 3s), reliable
    ];
    const v2Input = { durationSec: 2000, speechSec: 1000, segments };
    expect(resolveAnalysisMode(v2Input, cfgV2)).toBe("standard");
  });

  it("flag off -> resolveAnalysisMode ignores segments entirely (density boundary fixture stays 'stream' under the old 0.55 rule)", () => {
    // Fixture 1's exact-boundary segments (v2 density 0.45) fail the v2
    // fallback, but flag off never even computes segment density - the old
    // rule reads speechSec/durationSec only, and here that ratio (0.50)
    // is comfortably under the old 0.55 ceiling.
    const segments: WhisperSegment[] = [
      seg(0, 2, [{ start: 0, end: 3 }, { start: 42, end: 45 }]),
      seg(2, 4),
    ];
    const input = { durationSec: 2000, speechSec: 1000, segments };
    expect(resolveAnalysisMode(input, cfgOldOn)).toBe("stream");
  });

  it("host rule (twitch) fires identically with the v2 flag on, independent of density/segments", () => {
    const input = {
      sourceUrl: "https://www.twitch.tv/somechannel",
      durationSec: 100,
      speechSec: 90,
      segments: [],
    };
    expect(resolveAnalysisMode(input, cfgV2)).toBe("stream");
    expect(computeModeResolution(input, cfgV2)?.branch).toBe("host");
  });

  it("live rule (youtube.com/live/) fires identically with the v2 flag on, independent of density/segments", () => {
    const input = {
      sourceUrl: "https://www.youtube.com/live/abc123XYZ",
      durationSec: 100,
      speechSec: 90,
      segments: [],
    };
    expect(resolveAnalysisMode(input, cfgV2)).toBe("stream");
    expect(computeModeResolution(input, cfgV2)?.branch).toBe("live");
  });

  it("v2 density fallback fires and reports branch density_v2, rounded to 3 decimals", () => {
    const segments: WhisperSegment[] = [
      seg(0, 2.36, [{ start: 0, end: 3 }, { start: 297, end: 300 }]),
      seg(2.36, 4.72, [{ start: 300, end: 303 }]),
      seg(4.72, 7.08),
    ];
    const input = { durationSec: 1300, speechSec: 0, segments };
    expect(resolveAnalysisMode(input, cfgV2)).toBe("stream");
    const resolution = computeModeResolution(input, cfgV2);
    // density = (300 + 3) / 1300 = 0.23307... -> rounded to 0.233
    expect(resolution).toEqual({
      density: 0.233,
      medianSegmentSec: 2.36,
      reliableSegmentShare: Math.round((2 / 3) * 1000) / 1000,
      durationSec: 1300,
      branch: "density_v2",
    });
  });

  it("modeResolution is absent (undefined) when streamModeEnabled is false, mirroring analysisMode's not-a-key discipline", () => {
    const input = { durationSec: 1300, speechSec: 0, segments: [] };
    expect(resolveAnalysisMode(input, cfgOff)).toBe("standard");
    expect(computeModeResolution(input, cfgOff)).toBeUndefined();
  });

  it("standard branch still reports modeResolution when v2 is on but every conjunct fails", () => {
    // A dense, ordinary long video: reliable speech covers 90% of the
    // source (density 0.9, well past 0.45) - the density conjunct alone is
    // enough to reject it, and computeModeResolution must still report the
    // real measured values (not a dark/absent object) so a false demotion
    // would be diagnosable from telemetry, per the spec's own observability
    // rationale.
    const segments: WhisperSegment[] = [
      seg(0, 2, [{ start: 0, end: 3 }, { start: 897, end: 900 }]), // span 900 (each word's own span <= 3s), reliable
    ];
    const input = { durationSec: 1000, speechSec: 0, segments };
    expect(resolveAnalysisMode(input, cfgV2)).toBe("standard");
    const resolution = computeModeResolution(input, cfgV2);
    expect(resolution).toEqual({
      density: 0.9,
      medianSegmentSec: 2,
      reliableSegmentShare: 1,
      durationSec: 1000,
      branch: "standard",
    });
  });

  it("empty segments array resolves standard, not a vacuous stream (review nit: passesV2DensityFallback's own segmentCount > 0 guard)", () => {
    // Without a defensive segmentCount conjunct, an empty segments array
    // (density 0, medianSegmentSec 0 from an empty array, reliableSegmentShare
    // 0) would satisfy all three spec conjuncts trivially (0 < 0.45, 0 < 2.8,
    // 0 <= 0.78) and read as a stream. mode-metrics.ts's passesV2DensityFallback
    // rejects segmentCount === 0 on its own terms, so this stays "standard"
    // even though real callers always pass a non-empty transcription.segments
    // (the degenerate-guard return in index.ts fires first for a near-empty
    // transcript) - the guard does not depend on that ordering to be correct.
    const input = { durationSec: 1300, speechSec: 0, segments: [] };
    expect(resolveAnalysisMode(input, cfgV2)).toBe("standard");
    expect(computeModeResolution(input, cfgV2)?.branch).toBe("standard");
  });
});

// ---------------------------------------------------------------------------
// resolveMode (review follow-up, spec part 2): resolveAnalysisMode and
// computeModeResolution used to each independently recompute the segment
// metrics - two full passes over the same job's segments for one decision.
// resolveMode is the single entry point that computes them once and returns
// both; the two older functions are now thin wrappers over it, kept for
// callers/tests that only need one half.
// ---------------------------------------------------------------------------
describe("resolveMode - single entry point, consistent with and cheaper than the two wrappers", () => {
  function streamShapedInput(segments: WhisperSegment[]) {
    return { durationSec: 1300, speechSec: 0, segments };
  }

  it("resolveMode's { mode, modeResolution } matches resolveAnalysisMode/computeModeResolution exactly", () => {
    const input = streamShapedInput([
      seg(0, 2.36, [{ start: 0, end: 3 }, { start: 297, end: 300 }]),
      seg(2.36, 4.72, [{ start: 300, end: 303 }]),
      seg(4.72, 7.08),
    ]);
    const result = resolveMode(input, cfgV2);
    expect(result.mode).toBe(resolveAnalysisMode(input, cfgV2));
    expect(result.modeResolution).toEqual(computeModeResolution(input, cfgV2));
    expect(result.mode).toBe("stream");
    expect(result.modeResolution?.branch).toBe("density_v2");
  });

  it("resolveMode computes the segment metrics exactly once per call; pairing the two older wrappers doubles the work", () => {
    // Wraps a real segments array in a Proxy that counts every access to
    // .map/.filter/[Symbol.iterator] - the three ways mode-metrics.ts's
    // computeDensity (for...of), computeMedianSegmentSec (.map) and
    // computeReliableSegmentShare (.filter) each touch the array once. One
    // full metrics pass (one resolveMode call, or the internal resolve()
    // logic it wraps) therefore touches the array exactly 3 times; a second,
    // redundant pass would double that to 6 - which is what calling
    // resolveAnalysisMode and computeModeResolution back to back used to do
    // before resolveMode existed (each independently invoked the same
    // internal logic).
    function countingSegments(target: WhisperSegment[]) {
      let touches = 0;
      const proxy = new Proxy(target, {
        get(t, prop, receiver) {
          if (prop === "map" || prop === "filter" || prop === Symbol.iterator) touches++;
          return Reflect.get(t, prop, receiver);
        },
      });
      return { proxy, touches: () => touches };
    }

    const base: WhisperSegment[] = [
      seg(0, 2.36, [{ start: 0, end: 3 }, { start: 297, end: 300 }]),
      seg(2.36, 4.72, [{ start: 300, end: 303 }]),
      seg(4.72, 7.08),
    ];

    const single = countingSegments(base);
    resolveMode(streamShapedInput(single.proxy), cfgV2);
    expect(single.touches()).toBe(3);

    const doubled = countingSegments(base);
    const doubledInput = streamShapedInput(doubled.proxy);
    resolveAnalysisMode(doubledInput, cfgV2);
    computeModeResolution(doubledInput, cfgV2);
    expect(doubled.touches()).toBe(6);
  });
});

describe("loadAnalyzeConfig - stream resolver v2 knobs", () => {
  it("defaults: flag off, documented knob values", () => {
    const cfg = loadAnalyzeConfig({});
    expect(cfg.streamResolverV2Enabled).toBe(false);
    expect(cfg.streamDensityMaxV2).toBe(0.45);
    expect(cfg.streamMedianSegMaxSec).toBe(2.8);
    expect(cfg.streamReliableShareMax).toBe(0.78);
  });

  it("exact-literal flag - only the literal \"on\" enables it", () => {
    expect(loadAnalyzeConfig({ ANALYZE_STREAM_RESOLVER_V2: "on" }).streamResolverV2Enabled).toBe(true);
    expect(loadAnalyzeConfig({ ANALYZE_STREAM_RESOLVER_V2: "true" }).streamResolverV2Enabled).toBe(false);
    expect(loadAnalyzeConfig({ ANALYZE_STREAM_RESOLVER_V2: "1" }).streamResolverV2Enabled).toBe(false);
    expect(loadAnalyzeConfig({ ANALYZE_STREAM_RESOLVER_V2: "ON" }).streamResolverV2Enabled).toBe(false);
  });

  it("knob overrides", () => {
    const cfg = loadAnalyzeConfig({
      STREAM_DENSITY_MAX_V2: "0.4",
      STREAM_MEDIAN_SEG_MAX_SEC: "3.0",
      STREAM_RELIABLE_SHARE_MAX: "0.8",
    });
    expect(cfg.streamDensityMaxV2).toBe(0.4);
    expect(cfg.streamMedianSegMaxSec).toBe(3.0);
    expect(cfg.streamReliableShareMax).toBe(0.8);
  });
});
