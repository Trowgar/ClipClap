import type { AnalyzeConfig } from "./config";
import type { ScanCandidate, SentenceNode } from "./types";

export type VisualRecallConfig = Pick<
  AnalyzeConfig,
  | "scanWindowSec"
  | "visualRecallMaxCandidates"
  | "visualRecallClusterSec"
  | "visualRecallPreSec"
  | "visualRecallPostSec"
  | "visualRecallMaxNodeDistanceSec"
>;

/** Pure numeric diagnostics for one visual-recall nomination pass. */
export interface VisualRecallTelemetry {
  envelopeLength: number;
  median: number;
  mad: number;
  p75: number;
  robustThreshold: number;
  threshold: number;
  rawPeakCount: number;
  clusteredPeakCount: number;
  mappedCandidates: number;
  rejectedNoSpeech: number;
  diversityDropped: number;
  capped: number;
}

export interface VisualCandidateResult {
  candidates: ScanCandidate[];
  telemetry: VisualRecallTelemetry;
}

interface Peak {
  index: number;
  value: number;
}

const DIVERSITY_REGION_SEC = 60;
const ROBUST_MAD_MULTIPLIER = 3;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function emptyResult(): VisualCandidateResult {
  return {
    candidates: [],
    telemetry: {
      envelopeLength: 0,
      median: 0,
      mad: 0,
      p75: 0,
      robustThreshold: 0,
      threshold: 0,
      rawPeakCount: 0,
      clusteredPeakCount: 0,
      mappedCandidates: 0,
      rejectedNoSpeech: 0,
      diversityDropped: 0,
      capped: 0,
    },
  };
}

function distanceToNode(second: number, node: SentenceNode): number {
  if (second < node.start) return node.start - second;
  if (second > node.end) return second - node.end;
  return 0;
}

function isUsableNode(node: SentenceNode | undefined): node is SentenceNode {
  return Boolean(
    node &&
      Number.isFinite(node.start) &&
      Number.isFinite(node.end) &&
      node.end >= node.start,
  );
}

function clusterPeaks(peaks: Peak[], clusterSec: number): Peak[] {
  const sorted = [...peaks].sort((a, b) => a.index - b.index);
  const clustered: Peak[] = [];
  let previousIndex = -Infinity;
  for (const peak of sorted) {
    const previous = clustered[clustered.length - 1];
    if (previous && peak.index - previousIndex <= clusterSec) {
      if (peak.value > previous.value) clustered[clustered.length - 1] = peak;
      previousIndex = peak.index;
      continue;
    }
    clustered.push(peak);
    previousIndex = peak.index;
  }
  return clustered;
}

/**
 * Nominate transcript-grounded visual moments from a per-second motion
 * envelope. This function deliberately has no I/O, model, or media-runtime
 * dependency: it is safe to run in shadow mode and easy to replay in tests.
 */
export function nominateVisualCandidates(
  nodes: SentenceNode[],
  motionEnvelope: unknown,
  cfg: VisualRecallConfig,
): VisualCandidateResult {
  // YDIF is an 8-bit per-pixel difference signal. Rejecting finite values
  // outside that physical domain keeps malformed/extreme input from
  // overflowing median/MAD arithmetic or becoming non-JSON telemetry.
  if (
    !Array.isArray(motionEnvelope) ||
    motionEnvelope.length === 0 ||
    !motionEnvelope.every(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 255,
    )
  ) {
    return emptyResult();
  }

  const envelope = motionEnvelope;
  const center = median(envelope);
  const mad = median(envelope.map((value) => Math.abs(value - center)));
  const p75 = percentile(envelope, 0.75);
  const robustThreshold = center + ROBUST_MAD_MULTIPLIER * mad;
  const threshold = Math.max(robustThreshold, p75);
  const minValue = Math.min(...envelope);
  const maxValue = Math.max(...envelope);
  const telemetry: VisualRecallTelemetry = {
    envelopeLength: envelope.length,
    median: center,
    mad,
    p75,
    robustThreshold,
    threshold,
    rawPeakCount: 0,
    clusteredPeakCount: 0,
    mappedCandidates: 0,
    rejectedNoSpeech: 0,
    diversityDropped: 0,
    capped: 0,
  };

  if (maxValue <= minValue) return { candidates: [], telemetry };

  const peaks: Peak[] = [];
  for (let index = 0; index < envelope.length; index++) {
    const value = envelope[index];
    if (value <= threshold) continue;
    const left = envelope[index - 1];
    const right = envelope[index + 1];
    // Require a strict rise on at least one side. That rejects static signals
    // and makes a plateau nominate one edge deterministically.
    if (
      (left !== undefined && value < left) ||
      (right !== undefined && value < right) ||
      ((left === undefined || value === left) && (right === undefined || value === right))
    ) {
      continue;
    }
    if ((left === undefined || value > left) || (right === undefined || value > right)) {
      peaks.push({ index, value });
    }
  }
  telemetry.rawPeakCount = peaks.length;

  const clusterSec = Number.isFinite(cfg.visualRecallClusterSec) && cfg.visualRecallClusterSec > 0
    ? cfg.visualRecallClusterSec
    : 12;
  const clustered = clusterPeaks(peaks, clusterSec);
  telemetry.clusteredPeakCount = clustered.length;

  // Pick the strongest peak from every temporal region first. Filling spare
  // capacity afterwards preserves strength without letting one burst consume
  // the complete global budget.
  const strongestFirst = [...clustered].sort((a, b) => b.value - a.value || a.index - b.index);
  const selected: Peak[] = [];
  const regions = new Set<number>();
  for (const peak of strongestFirst) {
    const region = Math.floor(peak.index / DIVERSITY_REGION_SEC);
    if (regions.has(region)) continue;
    regions.add(region);
    selected.push(peak);
  }
  telemetry.diversityDropped = clustered.length - selected.length;
  const cap = Number.isInteger(cfg.visualRecallMaxCandidates) && cfg.visualRecallMaxCandidates > 0
    ? cfg.visualRecallMaxCandidates
    : 12;
  if (selected.length > cap) selected.length = cap;
  for (const peak of strongestFirst) {
    if (selected.length >= cap) break;
    if (!selected.includes(peak)) selected.push(peak);
  }
  telemetry.capped = clustered.length - selected.length;

  const preSec = Number.isFinite(cfg.visualRecallPreSec) && cfg.visualRecallPreSec > 0 ? cfg.visualRecallPreSec : 8;
  const postSec = Number.isFinite(cfg.visualRecallPostSec) && cfg.visualRecallPostSec > 0 ? cfg.visualRecallPostSec : 18;
  const maxDistance = Number.isFinite(cfg.visualRecallMaxNodeDistanceSec) && cfg.visualRecallMaxNodeDistanceSec > 0
    ? cfg.visualRecallMaxNodeDistanceSec
    : 20;
  const scanWindowSec = Number.isFinite(cfg.scanWindowSec) && cfg.scanWindowSec > 0 ? cfg.scanWindowSec : 600;
  const candidates: Array<ScanCandidate & { peakSec: number }> = [];

  for (const peak of selected) {
    const peakSec = peak.index;
    const startSecond = peakSec - preSec;
    const endSecond = peakSec + postSec;
    let startNode = -1;
    let endNode = -1;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (!isUsableNode(node) || node.end < startSecond || node.start > endSecond) continue;
      if (startNode < 0) startNode = index;
      endNode = index;
    }
    if (startNode < 0 || endNode < startNode) {
      telemetry.rejectedNoSpeech++;
      continue;
    }

    // Ground the payoff only against reliable speech that is actually inside
    // the bounded candidate range. A globally nearest node can sit just
    // outside the pre-roll, and clamping that index would incorrectly turn an
    // opaque visual node into the payoff.
    let payoffNode = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = startNode; index <= endNode; index++) {
      const node = nodes[index];
      if (!isUsableNode(node) || node.hasWords !== true) continue;
      const distance = distanceToNode(peakSec, node);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        payoffNode = index;
      }
    }
    if (payoffNode < 0 || nearestDistance > maxDistance) {
      telemetry.rejectedNoSpeech++;
      continue;
    }

    const normalized = (peak.value - threshold) / Math.max(maxValue - threshold, Number.EPSILON);
    candidates.push({
      startNode,
      endNode,
      payoffNode,
      interest: Math.min(0.95, Math.max(0.55, 0.55 + Math.max(0, Math.min(1, normalized)) * 0.4)),
      type: "visual_action",
      windowIndex: Math.max(0, Math.floor(peakSec / scanWindowSec)),
      peakSec,
    });
  }

  candidates.sort((a, b) => a.peakSec - b.peakSec);
  telemetry.mappedCandidates = candidates.length;
  return {
    candidates: candidates.map(({ peakSec: _peakSec, ...candidate }) => candidate),
    telemetry,
  };
}
