import type { PostBoundaryHookGateMode } from "./config";
import type { SentenceNode, SnappedClip } from "./types";

export type PostBoundaryHookGateReason = "hook_delay" | "pre_hook_gap";
export type PostBoundaryHookGateScoreBand =
  | "below_threshold"
  | "threshold_to_0_8"
  | "above_0_8";
export type PostBoundaryHookGateDurationBand = "short" | "target" | "long";

/** Explicit boundary-change facts supplied by the pipeline. The pure policy
 * deliberately does not infer them from critic proposals or node indices. */
export interface PostBoundaryHookGateProvenance {
  startRepairApplied?: boolean;
  endExtensionApplied?: boolean;
}

export interface PostBoundaryHookGateOptions {
  mode: PostBoundaryHookGateMode;
  maxDelaySec?: number;
  maxPreHookGapSec?: number;
  scoreThreshold: number;
  targetMinSec: number;
  maxSec: number;
  provenanceForClip?: (clip: SnappedClip) => PostBoundaryHookGateProvenance | undefined;
}

export interface PostBoundaryHookGateMetricDistribution {
  count: number;
  hookDelaySec: number[];
  preHookGapSec: number[];
  maxHookDelaySec?: number;
  maxPreHookGapSec?: number;
}

export interface PostBoundaryHookGateProvenanceDistributions {
  startRepairApplied: Record<"yes" | "no", PostBoundaryHookGateMetricDistribution>;
  endExtensionApplied: Record<"yes" | "no", PostBoundaryHookGateMetricDistribution>;
}

export interface PostBoundaryHookGateDiagnosticBase {
  id: string;
  startSec: number;
  hookStartSec: number;
  hookDelaySec: number;
  preHookGapSec: number;
  score: number;
  kind?: string;
  startRepairApplied: boolean;
  endExtensionApplied: boolean;
}

/** Raw outlier diagnostics are used only by observe mode. */
export interface PostBoundaryHookGateObserveDiagnostic extends PostBoundaryHookGateDiagnosticBase {
  language: string;
}

/** Threshold diagnostics intentionally exclude language, which is not needed
 * to explain a drop decision. */
export interface PostBoundaryHookGateThresholdDiagnostic extends PostBoundaryHookGateDiagnosticBase {
  reasons: PostBoundaryHookGateReason[];
}

export interface PostBoundaryHookGateDistributions {
  overall: PostBoundaryHookGateMetricDistribution;
  byKind: Record<string, PostBoundaryHookGateMetricDistribution>;
  byLanguage: Record<string, PostBoundaryHookGateMetricDistribution>;
  byScoreBand: Record<PostBoundaryHookGateScoreBand, PostBoundaryHookGateMetricDistribution>;
  byDurationBand: Record<PostBoundaryHookGateDurationBand, PostBoundaryHookGateMetricDistribution>;
  provenance: PostBoundaryHookGateProvenanceDistributions;
}

interface PostBoundaryHookGateTelemetryBase<TDiagnostic> {
  evaluated: number;
  notEvaluable: number;
  maxHookDelaySec?: number;
  maxPreHookGapSec?: number;
  distributions: PostBoundaryHookGateDistributions;
  diagnostics: TDiagnostic[];
}

export interface PostBoundaryHookGateObserveTelemetry
  extends PostBoundaryHookGateTelemetryBase<PostBoundaryHookGateObserveDiagnostic> {
  mode: "observe";
}

export interface PostBoundaryHookGateThresholdTelemetry
  extends PostBoundaryHookGateTelemetryBase<PostBoundaryHookGateThresholdDiagnostic> {
  mode: "shadow" | "enforce";
  passed: number;
  reasons: Record<PostBoundaryHookGateReason, number>;
  exceeds: Record<PostBoundaryHookGateReason, { count: number; rate: number }>;
  estimatedOutputCountLoss: number;
}

export interface PostBoundaryHookGateShadowTelemetry extends PostBoundaryHookGateThresholdTelemetry {
  mode: "shadow";
  wouldDrop: number;
}

export interface PostBoundaryHookGateEnforceTelemetry extends PostBoundaryHookGateThresholdTelemetry {
  mode: "enforce";
  dropped: number;
}

export type PostBoundaryHookGateTelemetry =
  | PostBoundaryHookGateObserveTelemetry
  | PostBoundaryHookGateShadowTelemetry
  | PostBoundaryHookGateEnforceTelemetry;

export interface PostBoundaryHookGateDrop {
  id: string;
  reasons: PostBoundaryHookGateReason[];
}

export interface PostBoundaryHookGateResult {
  clips: SnappedClip[];
  drops: PostBoundaryHookGateDrop[];
  telemetry?: PostBoundaryHookGateTelemetry;
}

interface Evaluation {
  clip: SnappedClip;
  diagnostic: PostBoundaryHookGateObserveDiagnostic;
  reasons: PostBoundaryHookGateReason[];
}

function compareCandidateIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emptyDistributions(): PostBoundaryHookGateDistributions {
  const emptyMetric = (): PostBoundaryHookGateMetricDistribution => ({
    count: 0,
    hookDelaySec: [],
    preHookGapSec: [],
  });
  return {
    overall: emptyMetric(),
    // Kind and language originate outside this module. Null-prototype maps
    // preserve literal keys such as "__proto__" instead of treating them as
    // inherited object members.
    byKind: Object.create(null) as Record<string, PostBoundaryHookGateMetricDistribution>,
    byLanguage: Object.create(null) as Record<string, PostBoundaryHookGateMetricDistribution>,
    byScoreBand: {
      below_threshold: emptyMetric(),
      threshold_to_0_8: emptyMetric(),
      above_0_8: emptyMetric(),
    },
    byDurationBand: { short: emptyMetric(), target: emptyMetric(), long: emptyMetric() },
    provenance: {
      startRepairApplied: { yes: emptyMetric(), no: emptyMetric() },
      endExtensionApplied: { yes: emptyMetric(), no: emptyMetric() },
    },
  };
}

function addMetric(
  metric: PostBoundaryHookGateMetricDistribution,
  hookDelaySec: number,
  preHookGapSec: number,
): void {
  metric.count++;
  metric.hookDelaySec.push(hookDelaySec);
  metric.preHookGapSec.push(preHookGapSec);
  metric.maxHookDelaySec = Math.max(metric.maxHookDelaySec ?? hookDelaySec, hookDelaySec);
  metric.maxPreHookGapSec = Math.max(metric.maxPreHookGapSec ?? preHookGapSec, preHookGapSec);
}

function metricFor(
  metrics: Record<string, PostBoundaryHookGateMetricDistribution>,
  key: string,
): PostBoundaryHookGateMetricDistribution {
  if (!Object.hasOwn(metrics, key)) {
    metrics[key] = { count: 0, hookDelaySec: [], preHookGapSec: [] };
  }
  return metrics[key];
}

function scoreBand(score: number, threshold: number): PostBoundaryHookGateScoreBand {
  if (score < threshold) return "below_threshold";
  if (score <= 0.8) return "threshold_to_0_8";
  return "above_0_8";
}

function durationBand(
  durationSec: number,
  targetMinSec: number,
  maxSec: number,
): PostBoundaryHookGateDurationBand {
  if (durationSec < targetMinSec) return "short";
  if (durationSec <= maxSec) return "target";
  return "long";
}

function isEvaluable(clip: SnappedClip, nodes: SentenceNode[] | undefined): nodes is SentenceNode[] {
  // This policy owns only the half-open [startSec, hookStartSec) interval.
  // Final-end validation stays with the existing boundary validator and does
  // not make an otherwise measurable opening fail open here.
  return (
    Array.isArray(nodes) &&
    Number.isFinite(clip.startSec) &&
    clip.startSec >= 0 &&
    Number.isFinite(clip.hookStartSec) &&
    clip.hookStartSec >= 0 &&
    clip.hookStartSec >= clip.startSec
  );
}

/** Returns the greatest uncovered duration within the half-open interval. */
export function largestPreHookGap(
  nodes: readonly SentenceNode[],
  startSec: number,
  hookStartSec: number,
): number {
  if (!Number.isFinite(startSec) || !Number.isFinite(hookStartSec) || hookStartSec <= startSec) {
    return 0;
  }

  const ranges = nodes
    .filter(
      (node) =>
        Number.isFinite(node.start) &&
        Number.isFinite(node.end) &&
        node.start < node.end &&
        node.start < hookStartSec &&
        node.end > startSec,
    )
    .map((node) => ({ start: Math.max(startSec, node.start), end: Math.min(hookStartSec, node.end) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);

  let cursor = startSec;
  let largest = 0;
  for (const range of ranges) {
    if (range.start > cursor) largest = Math.max(largest, range.start - cursor);
    cursor = Math.max(cursor, range.end);
  }
  return Math.max(largest, hookStartSec - cursor);
}

function boundedRawDiagnostics(evaluations: Evaluation[]): PostBoundaryHookGateObserveDiagnostic[] {
  const byDelay = [...evaluations].sort(
    (left, right) =>
      right.diagnostic.hookDelaySec - left.diagnostic.hookDelaySec ||
      compareCandidateIds(left.diagnostic.id, right.diagnostic.id),
  );
  const byGap = [...evaluations].sort(
    (left, right) =>
      right.diagnostic.preHookGapSec - left.diagnostic.preHookGapSec ||
      compareCandidateIds(left.diagnostic.id, right.diagnostic.id),
  );
  const seen = new Set<string>();

  return [...byDelay.slice(0, 20), ...byGap.slice(0, 20)].flatMap((evaluation) => {
    const { id } = evaluation.diagnostic;
    if (seen.has(id)) return [];
    seen.add(id);
    return [evaluation.diagnostic];
  });
}

function thresholdDiagnostics(
  failures: Evaluation[],
): PostBoundaryHookGateThresholdDiagnostic[] {
  return failures.map(({ diagnostic, reasons }) => {
    const { language: _language, ...thresholdDiagnostic } = diagnostic;
    return { ...thresholdDiagnostic, reasons };
  });
}

function requireThresholds(options: PostBoundaryHookGateOptions): asserts options is PostBoundaryHookGateOptions & {
  maxDelaySec: number;
  maxPreHookGapSec: number;
} {
  if (
    !Number.isFinite(options.maxDelaySec) ||
    options.maxDelaySec === undefined ||
    options.maxDelaySec < 0 ||
    !Number.isFinite(options.maxPreHookGapSec) ||
    options.maxPreHookGapSec === undefined ||
    options.maxPreHookGapSec < 0
  ) {
    throw new Error("Thresholded post-boundary hook gate requires finite non-negative limits");
  }
}

export function applyPostBoundaryHookGate(
  clips: SnappedClip[],
  nodes: SentenceNode[] | undefined,
  options: PostBoundaryHookGateOptions,
): PostBoundaryHookGateResult {
  if (options.mode === "off") return { clips, drops: [] };
  if (options.mode === "shadow" || options.mode === "enforce") requireThresholds(options);

  const distributions = emptyDistributions();
  const evaluations: Evaluation[] = [];
  let notEvaluable = 0;

  for (const clip of clips) {
    if (!isEvaluable(clip, nodes)) {
      notEvaluable++;
      continue;
    }

    const hookDelaySec = clip.hookStartSec - clip.startSec;
    const preHookGapSec = largestPreHookGap(nodes, clip.startSec, clip.hookStartSec);
    const provenance = options.provenanceForClip?.(clip);
    const startRepairApplied = provenance?.startRepairApplied === true;
    const endExtensionApplied = provenance?.endExtensionApplied === true;
    const candidateScoreBand = scoreBand(clip.verdict.score, options.scoreThreshold);
    const candidateDurationBand = durationBand(
      clip.endSec - clip.startSec,
      options.targetMinSec,
      options.maxSec,
    );
    const reasons: PostBoundaryHookGateReason[] = [];
    if (options.mode === "shadow" || options.mode === "enforce") {
      const { maxDelaySec, maxPreHookGapSec } = options;
      // requireThresholds above guarantees both values for thresholded modes.
      if (hookDelaySec > maxDelaySec!) reasons.push("hook_delay");
      if (preHookGapSec > maxPreHookGapSec!) reasons.push("pre_hook_gap");
    }

    addMetric(distributions.overall, hookDelaySec, preHookGapSec);
    addMetric(metricFor(distributions.byKind, clip.verdict.kind ?? "unknown"), hookDelaySec, preHookGapSec);
    addMetric(metricFor(distributions.byLanguage, clip.verdict.language ?? "unknown"), hookDelaySec, preHookGapSec);
    addMetric(distributions.byScoreBand[candidateScoreBand], hookDelaySec, preHookGapSec);
    addMetric(distributions.byDurationBand[candidateDurationBand], hookDelaySec, preHookGapSec);
    addMetric(
      distributions.provenance.startRepairApplied[startRepairApplied ? "yes" : "no"],
      hookDelaySec,
      preHookGapSec,
    );
    addMetric(
      distributions.provenance.endExtensionApplied[endExtensionApplied ? "yes" : "no"],
      hookDelaySec,
      preHookGapSec,
    );

    evaluations.push({
      clip,
      reasons,
      diagnostic: {
        id: clip.verdict.id,
        startSec: clip.startSec,
        hookStartSec: clip.hookStartSec,
        hookDelaySec,
        preHookGapSec,
        score: clip.verdict.score,
        ...(clip.verdict.kind === undefined ? {} : { kind: clip.verdict.kind }),
        language: clip.verdict.language ?? "unknown",
        startRepairApplied,
        endExtensionApplied,
      },
    });
  }

  const { maxHookDelaySec, maxPreHookGapSec } = distributions.overall;
  const base = {
    evaluated: evaluations.length,
    notEvaluable,
    ...(maxHookDelaySec === undefined ? {} : { maxHookDelaySec }),
    ...(maxPreHookGapSec === undefined ? {} : { maxPreHookGapSec }),
    distributions,
  };

  if (options.mode === "observe") {
    return {
      clips,
      drops: [],
      telemetry: { mode: "observe", ...base, diagnostics: boundedRawDiagnostics(evaluations) },
    };
  }

  const failures = evaluations.filter((evaluation) => evaluation.reasons.length > 0);
  const reasons: Record<PostBoundaryHookGateReason, number> = { hook_delay: 0, pre_hook_gap: 0 };
  for (const failure of failures) {
    for (const reason of failure.reasons) reasons[reason]++;
  }
  const telemetryBase = {
    ...base,
    passed: evaluations.length - failures.length,
    reasons,
    exceeds: {
      hook_delay: {
        count: reasons.hook_delay,
        rate: evaluations.length === 0 ? 0 : reasons.hook_delay / evaluations.length,
      },
      pre_hook_gap: {
        count: reasons.pre_hook_gap,
        rate: evaluations.length === 0 ? 0 : reasons.pre_hook_gap / evaluations.length,
      },
    },
    estimatedOutputCountLoss: failures.length,
    diagnostics: thresholdDiagnostics(failures),
  };

  if (options.mode === "shadow") {
    return {
      clips,
      drops: [],
      telemetry: { mode: "shadow", ...telemetryBase, wouldDrop: failures.length },
    };
  }

  const failuresByObject = new Set(failures.map((failure) => failure.clip));
  return {
    clips: clips.filter((clip) => !failuresByObject.has(clip)),
    drops: failures.map((failure) => ({ id: failure.diagnostic.id, reasons: failure.reasons })),
    telemetry: { mode: "enforce", ...telemetryBase, dropped: failures.length },
  };
}
