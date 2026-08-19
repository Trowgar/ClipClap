import type { AnalyzeConfig } from "./config";

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
}

/**
 * Deterministic, no-LLM mode resolution (spec §1 "S1 - mode resolution").
 * Rules, in order:
 *   1. sourceUrl host is twitch.tv (or a twitch.tv subdomain, which covers
 *      clips.twitch.tv) -> stream.
 *   2. sourceUrl host is youtube.com (or a subdomain, e.g. www./m.) AND the
 *      path starts with /live/ -> stream.
 *   3. else, transcript-shape fallback: source longer than 20 minutes AND
 *      speech density (speechSec / durationSec) under cfg.streamDensityMax
 *      -> stream.
 *   4. else -> standard.
 *
 * The master flag lives HERE, not in each call site: cfg.streamModeEnabled
 * false short-circuits to "standard" before any URL parsing or density math
 * runs, so a caller cannot forget to gate a twitch URL behind the flag.
 *
 * URL parsing must not throw on garbage input - a malformed sourceUrl simply
 * cannot match the host rules and falls through to the density fallback,
 * exactly like a video with no sourceUrl at all.
 */
export function resolveAnalysisMode(
  input: ResolveAnalysisModeInput,
  cfg: AnalyzeConfig
): AnalysisMode {
  if (!cfg.streamModeEnabled) return "standard";

  if (input.sourceUrl) {
    try {
      const url = new URL(input.sourceUrl);
      const host = url.hostname.toLowerCase();
      if (host === "twitch.tv" || host.endsWith(".twitch.tv")) return "stream";
      if (
        (host === "youtube.com" || host.endsWith(".youtube.com")) &&
        url.pathname.startsWith("/live/")
      ) {
        return "stream";
      }
    } catch {
      // Garbage sourceUrl (not a valid URL at all) - fall through to the
      // density fallback rather than throwing. A URL parse failure says
      // nothing about whether the SOURCE is a stream.
    }
  }

  if (
    typeof input.durationSec === "number" &&
    input.durationSec > 1200 &&
    input.speechSec / input.durationSec < cfg.streamDensityMax
  ) {
    return "stream";
  }

  return "standard";
}
