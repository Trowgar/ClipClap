import { analyzeHighlightsV2, type AnalyzeV2Options } from "../analyze-v2";
import type { TranscriptionResult } from "@clipclap/shared";
import type { MaterializedCase } from "./promote";
import type { QualityCaseResult, QualityMetrics } from "./types";
import { buildSentenceGraph } from "../analyze-v2/sentence-graph";
import { largestPreHookGap } from "../analyze-v2/post-boundary-hook-gate";
import { loadAnalyzeConfig } from "../analyze-v2/config";

export type SelectionAttempt = Readonly<{
  name: string;
  result: { highlights?: readonly unknown[]; telemetry?: Record<string, unknown> };
}>;
export type SelectionResultPayload = SelectionAttempt["result"];

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

function selectedHighlight(highlights: readonly unknown[], expected: MaterializedCase["expected"]["sourceWindow"]): { start: number; end: number; hookStart: number; payoffAt: number; score: number; lowQuality?: boolean } | undefined {
  const valid = highlights.filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== "object") return false;
    const value = item as Record<string, unknown>;
    return finite(value.start) && finite(value.end);
  });
  const first = valid.reduce<Record<string, unknown> | undefined>((best, item) => {
    if (!best || !expected) return best ?? item;
    const overlap = Math.max(0, Math.min(item.end as number, expected.end) - Math.max(item.start as number, expected.start));
    const priorOverlap = Math.max(0, Math.min(best.end as number, expected.end) - Math.max(best.start as number, expected.start));
    return overlap > priorOverlap ? item : best;
  }, undefined);
  if (!first || !finite(first.start) || !finite(first.end) || !finite(first.hookStart) || !finite(first.payoffAt) || typeof first.score !== "number" || !Number.isFinite(first.score)) throw new Error("selection highlight fields missing");
  return first as unknown as { start: number; end: number; hookStart: number; payoffAt: number; score: number; lowQuality?: boolean };
}

function deterministicBoundaryErrors(highlight: { start: number; end: number }, qualityCase: MaterializedCase, transcript: TranscriptionResult): number {
  const duration = qualityCase.inputs.sourceDurationSec;
  const segments = transcript.segments.filter((segment) => finite(segment.start) && finite(segment.end) && segment.end >= segment.start);
  const transcriptStart = segments.length ? Math.min(...segments.map((segment) => segment.start)) : 0;
  const transcriptEnd = segments.length ? Math.max(...segments.map((segment) => segment.end)) : duration ?? 0;
  let errors = 0;
  if (highlight.start < 0 || highlight.end <= highlight.start || (duration !== null && duration !== undefined && highlight.end > duration)) errors += 1;
  if (highlight.start < transcriptStart || highlight.end > transcriptEnd) errors += 1;
  const expected = qualityCase.expected.sourceWindow;
  if (qualityCase.expected.completeBoundary && expected && (highlight.start > expected.start || highlight.end < expected.end)) errors += 1;
  return errors;
}

function selectionMetrics(result: SelectionAttempt["result"], qualityCase: MaterializedCase, options: SelectionLaneOptions): QualityMetrics {
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
  const requiredTelemetry = ["kept", "criticVerdicts", "omittedDrops", "truncatedDrops", "refusalDrops", "invariantDrops"];
  if (requiredTelemetry.some((key) => !Object.prototype.hasOwnProperty.call(telemetry, key))) throw new Error("selection telemetry missing");
  const first = highlights.length ? selectedHighlight(highlights, expected) : undefined;
  const hookDelay = first ? first.hookStart - first.start : 0;
  let preHookGap = 0;
  if (first) {
    try {
      preHookGap = largestPreHookGap(buildSentenceGraph(options.transcript.segments.length ? options.transcript.segments : [], options.analyzeOptions?.cfg ?? loadAnalyzeConfig()), first.start, first.hookStart);
      if (!Number.isFinite(preHookGap) || preHookGap < 0) throw new Error("invalid pre-hook gap");
    } catch { throw new Error("selection pre-hook gap unavailable"); }
  }
  const payoffContainment = first ? (first.payoffAt >= first.start && first.payoffAt <= first.end ? 1 : 0) : 0;
  const boundaryErrors = first ? deterministicBoundaryErrors(first, qualityCase, options.transcript) : highlights.length;
  return {
    approvedMomentRetained,
    approvedWindowOverlap,
    emptyResult: highlights.length === 0 ? 1 : 0,
    zeroClipFalseNegative: qualityCase.expected.approvedMoment && highlights.length === 0 ? 1 : 0,
    boundaryErrors,
    lowQuality: highlights.filter((item) => (item as { lowQuality?: unknown }).lowQuality === true).length,
    rescueCandidates: telemetry.rescue && typeof telemetry.rescue === "object" ? number((telemetry.rescue as Record<string, unknown>).evaluated) ?? 0 : 0,
    criticFailures: ["omittedDrops", "truncatedDrops", "refusalDrops", "invariantDrops"].reduce((sum, key) => sum + (number(telemetry[key]) ?? 0), 0),
    hookDelay,
    preHookGap,
    payoffContainment,
    score: first?.score ?? 0,
  };
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
    metrics: selectionMetrics(first.result, qualityCase, options),
  };
}
