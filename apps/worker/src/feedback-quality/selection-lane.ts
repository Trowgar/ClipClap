import { analyzeHighlightsV2, type AnalyzeV2Options } from "../analyze-v2";
import type { TranscriptionResult } from "@clipclap/shared";
import type { MaterializedCase } from "./promote";
import type { QualityCaseResult, QualityMetrics } from "./types";

export type SelectionAttempt = Readonly<{
  name: string;
  result: { highlights?: readonly unknown[]; telemetry?: Record<string, unknown> };
}>;

export type SelectionLaneOptions = Readonly<{
  transcript: TranscriptionResult;
  analyze?: (transcript: TranscriptionResult, options: AnalyzeV2Options) => Promise<SelectionAttempt["result"]>;
  analyzeOptions?: AnalyzeV2Options;
  attempts?: readonly string[];
}>;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function number(value: unknown): number | undefined { return finite(value) ? value : undefined; }

function selectionMetrics(result: SelectionAttempt["result"], qualityCase: MaterializedCase): QualityMetrics {
  const highlights = Array.isArray(result.highlights) ? result.highlights : [];
  const expected = qualityCase.expected.sourceWindow;
  const approvedMomentRetained = highlights.length > 0 && qualityCase.expected.approvedMoment ? 1 : 0;
  let approvedWindowOverlap = approvedMomentRetained;
  if (expected && highlights.length > 0) {
    const best = highlights.reduce((max, item) => {
      const value = item as { start?: number; end?: number };
      if (!finite(value.start) || !finite(value.end)) return max;
      const overlap = Math.max(0, Math.min(value.end, expected.end) - Math.max(value.start, expected.start));
      return Math.max(max, overlap / Math.max(0.001, expected.end - expected.start));
    }, 0);
    approvedWindowOverlap = best;
  }
  const telemetry = result.telemetry ?? {};
  const pick = (...keys: string[]) => keys.map((key) => number(telemetry[key])).find((value) => value !== undefined) ?? 0;
  return {
    approvedMomentRetained,
    approvedWindowOverlap,
    emptyResult: highlights.length === 0 ? 1 : 0,
    zeroClipFalseNegative: qualityCase.expected.approvedMoment && highlights.length === 0 ? 1 : 0,
    boundaryErrors: pick("boundaryErrors", "boundary_errors"),
    focalFailures: pick("focalFailures", "focal_failures"),
    subtitleFailures: pick("subtitleFailures", "subtitle_failures"),
    lowQuality: pick("lowQuality", "low_quality"),
    rescueCandidates: pick("rescueCandidates", "rescue_candidates"),
    criticFailures: pick("criticFailures", "critic_failures"),
  } as QualityMetrics;
}

/** Runs the real V2 analyzer through an injected client/options. The adapter
 * deliberately returns one result per call; the observer owns live attempt
 * naming and never combines responses. */
export async function observeSelectionCase(
  qualityCase: MaterializedCase,
  options: SelectionLaneOptions,
): Promise<QualityCaseResult> {
  const analyze = options.analyze ?? (async (transcript, analyzeOptions) => analyzeHighlightsV2(transcript, analyzeOptions));
  const names = options.attempts?.length ? options.attempts : ["recorded"];
  if (new Set(names).size !== names.length) throw new Error("duplicate selection attempt");
  const attempts: SelectionAttempt[] = [];
  for (const name of names) {
    const result = await analyze(options.transcript, options.analyzeOptions ?? {});
    attempts.push({ name, result });
  }
  if (attempts.length === 0) throw new Error("selection input missing");
  const first = attempts[0];
  return {
    schemaVersion: 1,
    caseVersion: qualityCase.caseVersion,
    disposition: qualityCase.disposition,
    subsystem: qualityCase.subsystem,
    status: "ok",
    metrics: selectionMetrics(first.result, qualityCase),
  };
}

