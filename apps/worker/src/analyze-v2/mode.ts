import type { WhisperSegment } from "@clipclap/shared";
import type { AnalyzeConfig } from "./config";
import {
  computeDensity,
  computeMedianSegmentSec,
  computeReliableSegmentShare,
  passesV2DensityFallback,
} from "./mode-metrics";

/**
 * S1 of the stream-analyze-mode spec (2026-08-19). "stream" unlocks the
 * stream-aware critic rubric, budget and merge behaviour tasks T2-T4 build;
 * "standard" is today's engine, byte for byte.
 */
export type AnalysisMode = "standard" | "stream";

export interface ResolveAnalysisModeInput {
  sourceUrl?: string;
  durationSec?: number;
  speechSec: number;
  /** RAW transcript segments (spec 2026-08-25-mid-rescue-and-stream-
   *  resolver-v2, part 2). Only consumed by the v2 density fallback (density/
   *  medianSegmentSec/reliableSegmentShare) and by computeModeResolution's
   *  diagnostic telemetry - the flag-off path below still decides purely off
   *  `speechSec`/`durationSec`, unchanged. Optional so every caller of the
   *  pre-existing resolveAnalysisMode (this module's own tests included)
   *  that never touches stream-mode-v2 keeps compiling and behaving exactly
   *  as before; defaults to `[]` when omitted. */
  segments?: WhisperSegment[];
}

/** The branch that decided this job's mode - additive observability (spec
 *  part 2, "no flag" telemetry). Not every value is reachable from
 *  resolveAnalysisMode's own logic today (host/live/density/density_v2/
 *  standard are; "short" is reserved per the spec's own branch enum) - kept
 *  as one shared literal type rather than narrowed, so a future caller that
 *  legitimately produces a "short" resolution does not need a second type. */
export type ModeResolutionBranch =
  | "host"
  | "live"
  | "density"
  | "density_v2"
  | "short"
  | "standard";

export interface ModeResolution {
  density: number;
  medianSegmentSec: number;
  reliableSegmentShare: number;
  durationSec: number;
  branch: ModeResolutionBranch;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface ModeResolutionResult {
  mode: AnalysisMode;
  modeResolution: ModeResolution | undefined;
}

/**
 * Single source of truth for BOTH the mode decision and its diagnostic
 * telemetry - computed ONCE per call (one segment scan, one host-rule parse)
 * so the two can never disagree about which branch fired, and so a caller
 * that needs both (index.ts) does not pay for two full resolutions of the
 * same input (review nit, spec 2026-08-25-mid-rescue-and-stream-resolver-v2
 * part 2 follow-up: the metrics were being computed twice per job before
 * this export existed - once via resolveAnalysisMode, once via
 * computeModeResolution, each calling this same logic independently).
 * modeResolution stays `undefined` whenever cfg.streamModeEnabled is false,
 * mirroring the not-a-key discipline index.ts already applies to
 * `analysisMode` (spec part 2's observability note: "keep the existing
 * not-a-key discipline"). resolveAnalysisMode and computeModeResolution
 * below are thin wrappers over this for callers (and tests) that only need
 * one half of the result.
 */
export function resolveMode(
  input: ResolveAnalysisModeInput,
  cfg: AnalyzeConfig
): ModeResolutionResult {
  if (!cfg.streamModeEnabled) {
    return { mode: "standard", modeResolution: undefined };
  }

  const segments = input.segments ?? [];
  const durationSec = input.durationSec ?? 0;
  const density = computeDensity(segments, durationSec);
  const medianSegmentSec = computeMedianSegmentSec(segments);
  const reliableSegmentShare = computeReliableSegmentShare(segments);

  const withBranch = (
    mode: AnalysisMode,
    branch: ModeResolutionBranch
  ): ModeResolutionResult => ({
    mode,
    modeResolution: {
      density: round3(density),
      medianSegmentSec: round3(medianSegmentSec),
      reliableSegmentShare: round3(reliableSegmentShare),
      durationSec: round3(durationSec),
      branch,
    },
  });

  if (input.sourceUrl) {
    try {
      const url = new URL(input.sourceUrl);
      const host = url.hostname.toLowerCase();
      if (host === "twitch.tv" || host.endsWith(".twitch.tv")) {
        return withBranch("stream", "host");
      }
      if (
        (host === "youtube.com" || host.endsWith(".youtube.com")) &&
        url.pathname.startsWith("/live/")
      ) {
        return withBranch("stream", "live");
      }
    } catch {
      // Garbage sourceUrl (not a valid URL at all) - fall through to the
      // density fallback rather than throwing. A URL parse failure says
      // nothing about whether the SOURCE is a stream.
    }
  }

  if (typeof input.durationSec === "number" && input.durationSec > 1200) {
    if (cfg.streamResolverV2Enabled) {
      // v2 density fallback (spec part 2): the SAME durationSec > 1200 gate
      // as today, unchanged, but the density branch itself now requires all
      // three conjuncts (plus a defensive segmentCount > 0 - review nit, see
      // mode-metrics.ts's passesV2DensityFallback doc comment) - see that
      // same doc comment for the corpus derivation of each threshold.
      const metrics = { density, medianSegmentSec, reliableSegmentShare, segmentCount: segments.length };
      if (passesV2DensityFallback(metrics, cfg)) {
        return withBranch("stream", "density_v2");
      }
    } else if (input.speechSec / input.durationSec < cfg.streamDensityMax) {
      // Flag off: BYTE-IDENTICAL to the pre-v2 rule - same predicate, same
      // speechSec/durationSec inputs, density/medianSegmentSec/
      // reliableSegmentShare computed above only for the telemetry object,
      // never consulted by this branch.
      return withBranch("stream", "density");
    }
  }

  return withBranch("standard", "standard");
}

/**
 * Deterministic, no-LLM mode resolution (spec §1 "S1 - mode resolution").
 * Rules, in order:
 *   1. sourceUrl host is twitch.tv (or a twitch.tv subdomain, which covers
 *      clips.twitch.tv) -> stream.
 *   2. sourceUrl host is youtube.com (or a subdomain, e.g. www./m.) AND the
 *      path starts with /live/ -> stream.
 *   3. else, transcript-shape fallback: source longer than 20 minutes AND
 *      - flag ANALYZE_STREAM_RESOLVER_V2 off (default, byte-identical to
 *        today): speech density (speechSec / durationSec) under
 *        cfg.streamDensityMax -> stream.
 *      - flag on (spec 2026-08-25-mid-rescue-and-stream-resolver-v2, part
 *        2): density < cfg.streamDensityMaxV2 AND medianSegmentSec <
 *        cfg.streamMedianSegMaxSec AND reliableSegmentShare <=
 *        cfg.streamReliableShareMax, ALL THREE (mode-metrics.ts). Provisional
 *        constants (n=3 true streams on the corpus) - see config.ts's doc
 *        comments on the three knobs.
 *   4. else -> standard.
 *
 * The master flag lives HERE, not in each call site: cfg.streamModeEnabled
 * false short-circuits to "standard" before any URL parsing or density math
 * runs, so a caller cannot forget to gate a twitch URL behind the flag.
 *
 * URL parsing must not throw on garbage input - a malformed sourceUrl simply
 * cannot match the host rules and falls through to the density fallback,
 * exactly like a video with no sourceUrl at all.
 *
 * Thin wrapper over resolveMode - kept for callers (and this module's own
 * pre-v2 tests) that only need the mode string, not the telemetry. A caller
 * that needs BOTH should call resolveMode once directly instead of pairing
 * this with computeModeResolution, which would resolve the same input twice.
 */
export function resolveAnalysisMode(
  input: ResolveAnalysisModeInput,
  cfg: AnalyzeConfig
): AnalysisMode {
  return resolveMode(input, cfg).mode;
}

/**
 * Additive observability companion to resolveAnalysisMode (spec part 2,
 * "no flag" telemetry - independent of ANALYZE_STREAM_RESOLVER_V2, but NOT
 * independent of the pre-existing cfg.streamModeEnabled master switch, whose
 * not-a-key discipline this mirrors exactly: `undefined` when stream mode is
 * disabled, a fully-populated object otherwise, regardless of which branch
 * decided the mode). Callers spread its result into telemetry the same way
 * they already spread `analysisMode`. Values rounded to 3 decimals.
 *
 * Thin wrapper over resolveMode - see resolveAnalysisMode's own doc comment
 * for why a caller needing both fields should call resolveMode once instead
 * of pairing these two wrappers.
 */
export function computeModeResolution(
  input: ResolveAnalysisModeInput,
  cfg: AnalyzeConfig
): ModeResolution | undefined {
  return resolveMode(input, cfg).modeResolution;
}
