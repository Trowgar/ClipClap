import { OUTCOME_RECOVERY_VERSION, type OutcomeRecoveryMode } from "./config";
import type { LlmUsage, ModelUsage } from "./types";
import { isCandidateType, isNormalizedCandidateInterest } from "./types";
import type {
  MergedCandidate,
  NoClipsReasonValue,
  SentenceNode,
  V2Highlight,
} from "./types";

const PAYOFF_REGION_SEC = 600;
const HARD_MAX_CANDIDATES = 12;

export type RecoveryOutcome =
  | "not_eligible" | "no_candidate" | "empty_pool" | "rejected" | "failed"
  | "shadow_hit" | "shadow_miss" | "shipped";
export type RecoveryReason =
  | "mode_off" | "non_empty" | "wrong_content_reason" | "partial_transcript"
  | "missing_range" | "degenerate" | "song_gate" | "music_short" | "no_unjudged_tail"
  | "unjudged_tail" | "empty_pool" | "quality_error" | "malformed_state";

export interface RecoveryRange {
  startMs: number;
  endMs: number;
}

export interface OutcomeRecoveryTelemetryInput {
  mode: OutcomeRecoveryMode;
  eligible: boolean;
  reason: RecoveryReason;
  tailSize: number;
  poolSize: number;
  excludedMissingRange: number;
  judged: number;
  counters: { selectedForFinalizer: number; finalizerSurvivors: number };
  primaryDispositions: Record<string, number>;
  recoveryDispositions: Record<string, number>;
  addedUsage: LlmUsage;
  elapsedMs: number;
  outcome: RecoveryOutcome;
  ranges?: readonly RecoveryRange[];
}

function safeUsage(usage: LlmUsage): LlmUsage {
  const read = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : 0;
  const byModel: Record<string, ModelUsage> = {};
  if (usage?.byModel && typeof usage.byModel === "object") {
    for (const [model, raw] of Object.entries(usage.byModel)) {
      if (!model || raw === null || typeof raw !== "object") continue;
      const bucket = raw as Partial<ModelUsage>;
      byModel[model] = { inputTokens: read(bucket.inputTokens), outputTokens: read(bucket.outputTokens), requests: read(bucket.requests) };
    }
  }
  return { inputTokens: read(usage?.inputTokens), outputTokens: read(usage?.outputTokens), requests: read(usage?.requests), byModel };
}

const SAFE_PRIMARY_DISPOSITIONS = new Set([
  "not_selected_for_critic", "critic_unjudged", "missing_range_rejected",
  "critic_rejected", "evidence_rejected", "snap_rejected", "selection_not_chosen",
  "arc_rejected", "post_boundary_rejected", "standalone_rejected",
  "finalizer_rejected", "shipped",
]);
const SAFE_RECOVERY_DISPOSITIONS = new Set([
  "critic_unjudged", "critic_rejected", "evidence_rejected", "snap_rejected",
  "selection_not_chosen", "arc_rejected", "post_boundary_rejected",
  "standalone_rejected", "finalizer_rejected", "shipped", "finalizer_unjudged",
]);

function safeDispositionCounts(
  counts: Record<string, number> | null | undefined,
  allowed: ReadonlySet<string>,
): Record<string, number> {
  const result: Record<string, number> = {};
  if (!counts || typeof counts !== "object") return result;
  for (const [key, value] of Object.entries(counts)) {
    if (!allowed.has(key) || !Number.isInteger(value) || value < 0) continue;
    result[key] = value;
  }
  return result;
}

/** Build the only public recovery telemetry shape. Ranges are geometry only. */
export function buildOutcomeRecoveryTelemetry(input: OutcomeRecoveryTelemetryInput): Record<string, unknown> {
  const ranges = (Array.isArray(input.ranges) ? input.ranges : []).slice(0, HARD_MAX_CANDIDATES).filter((range) =>
    range !== null && typeof range === "object" &&
    Number.isFinite(range.startMs) && Number.isFinite(range.endMs) &&
    Number.isInteger(range.startMs) && Number.isInteger(range.endMs) &&
    range.startMs >= 0 && range.endMs >= range.startMs
  ).map((range) => ({ startMs: range.startMs, endMs: range.endMs }));
  return {
    version: OUTCOME_RECOVERY_VERSION,
    mode: input.mode,
    eligible: input.eligible,
    reason: input.reason,
    tailSize: input.tailSize,
    poolSize: input.poolSize,
    excludedMissingRange: input.excludedMissingRange,
    judged: input.judged,
    counters: {
      selectedForFinalizer: Number.isInteger(input.counters?.selectedForFinalizer) && input.counters.selectedForFinalizer >= 0 ? input.counters.selectedForFinalizer : 0,
      finalizerSurvivors: Number.isInteger(input.counters?.finalizerSurvivors) && input.counters.finalizerSurvivors >= 0 ? input.counters.finalizerSurvivors : 0,
    },
    primaryDispositions: safeDispositionCounts(input.primaryDispositions, SAFE_PRIMARY_DISPOSITIONS),
    recoveryDispositions: safeDispositionCounts(input.recoveryDispositions, SAFE_RECOVERY_DISPOSITIONS),
    addedUsage: safeUsage(input.addedUsage),
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    ranges,
    outcome: input.outcome,
  };
}

/**
 * Add one isolated lane's usage to the job accumulator. Recovery deliberately
 * runs with a fresh accumulator, then crosses this seam exactly once. The
 * source buckets are snapshotted before mutation so an accidentally aliased
 * `byModel` object cannot be counted twice.
 */
export function mergeUsage(target: LlmUsage, addition: LlmUsage): void {
  if (target === addition) return;
  if (target === null || typeof target !== "object" || addition === null || typeof addition !== "object") {
    throw new Error("outcome_recovery_usage_invariant");
  }
  const read = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
      ? value
      : 0;
  const buckets: Array<[string, ModelUsage]> = [];
  if (addition.byModel && typeof addition.byModel === "object") {
    for (const [model, raw] of Object.entries(addition.byModel)) {
      if (!model || raw === null || typeof raw !== "object") continue;
      const bucket = raw as Partial<ModelUsage>;
      buckets.push([model, {
        inputTokens: read(bucket.inputTokens),
        outputTokens: read(bucket.outputTokens),
        requests: read(bucket.requests),
      }]);
    }
  }
  const inputTokens = read(addition.inputTokens);
  const outputTokens = read(addition.outputTokens);
  const requests = read(addition.requests);
  target.inputTokens = read(target.inputTokens) + inputTokens;
  target.outputTokens = read(target.outputTokens) + outputTokens;
  target.requests = read(target.requests) + requests;
  if (target.byModel === null || typeof target.byModel !== "object") target.byModel = {};
  for (const [model, bucket] of buckets) {
    const current = target.byModel[model] ?? { inputTokens: 0, outputTokens: 0, requests: 0 };
    target.byModel[model] = {
      inputTokens: read(current.inputTokens) + bucket.inputTokens,
      outputTokens: read(current.outputTokens) + bucket.outputTokens,
      requests: read(current.requests) + bucket.requests,
    };
  }
}

function invariantFailure(): never {
  // Deliberately no candidate id, transcript, URL, or other source prose.
  throw new Error("outcome_recovery_input_invariant");
}

export interface RecoveryPoolResult {
  candidates: MergedCandidate[];
  excludedMissingRange: number;
}

export type RecoveryEligibility =
  | { eligible: true; reason: "unjudged_tail" }
  | {
      eligible: false;
      reason:
        | "mode_off"
        | "non_empty"
        | "wrong_content_reason"
        | "partial_transcript"
        | "missing_range"
        | "degenerate"
        | "song_gate"
        | "no_unjudged_tail";
    };

function compareStableId(a: MergedCandidate, b: MergedCandidate): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareWithinRegion(a: MergedCandidate, b: MergedCandidate): number {
  return b.interest - a.interest || compareStableId(a, b);
}

function validatePoolInput(input: {
  candidates: readonly MergedCandidate[];
  nodes: readonly SentenceNode[];
  missingRanges: readonly { start: number; end: number }[];
  maxCandidates: number;
}): void {
  if (
    !Array.isArray(input.candidates) ||
    !Array.isArray(input.nodes) ||
    !Array.isArray(input.missingRanges) ||
    !Number.isFinite(input.maxCandidates) ||
    !Number.isInteger(input.maxCandidates) ||
    input.maxCandidates < 0
  ) {
    invariantFailure();
  }

  for (const range of input.missingRanges) {
    if (
      range === null ||
      typeof range !== "object" ||
      !Number.isFinite(range.start) ||
      !Number.isFinite(range.end) ||
      range.start < 0 ||
      range.end < 0 ||
      range.start >= range.end
    ) {
      invariantFailure();
    }
  }

  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      ids.has(candidate.id) ||
      !Number.isInteger(candidate.startNode) ||
      !Number.isInteger(candidate.payoffNode) ||
      !Number.isInteger(candidate.endNode) ||
      candidate.startNode < 0 ||
      candidate.endNode >= input.nodes.length ||
      candidate.startNode > candidate.payoffNode ||
      candidate.payoffNode > candidate.endNode ||
      !isNormalizedCandidateInterest(candidate.interest) ||
      !isCandidateType(candidate.type)
    ) {
      invariantFailure();
    }
    ids.add(candidate.id);

    const startNode = input.nodes[candidate.startNode];
    const payoffNode = input.nodes[candidate.payoffNode];
    const endNode = input.nodes[candidate.endNode];
    if (startNode === undefined || payoffNode === undefined || endNode === undefined) {
      invariantFailure();
    }
    for (let nodeIndex = candidate.startNode; nodeIndex <= candidate.endNode; nodeIndex += 1) {
      const node = input.nodes[nodeIndex];
      if (
        node === undefined ||
        node === null ||
        typeof node !== "object" ||
        !Number.isFinite(node.start) ||
        !Number.isFinite(node.end) ||
        node.start < 0 ||
        node.start > node.end
      ) {
        invariantFailure();
      }
    }
    if (
      startNode.start > payoffNode.start ||
      payoffNode.start > endNode.end
    ) {
      invariantFailure();
    }
  }
}

function intersectsMissingRange(
  candidate: MergedCandidate,
  nodes: readonly SentenceNode[],
  missingRanges: readonly { start: number; end: number }[],
): boolean {
  const start = nodes[candidate.startNode]?.start;
  const end = nodes[candidate.endNode]?.end;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return missingRanges.some(
    (range) =>
      Number.isFinite(range.start) &&
      Number.isFinite(range.end) &&
      start < range.end &&
      end > range.start,
  );
}

function regionFor(
  candidate: MergedCandidate,
  nodes: readonly SentenceNode[],
): number | undefined {
  const payoff = nodes[candidate.payoffNode]?.start;
  return Number.isFinite(payoff) ? Math.floor(payoff / PAYOFF_REGION_SEC) : undefined;
}

function boundedCap(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(HARD_MAX_CANDIDATES, Math.floor(value));
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Build a deterministic, diversity-first pool from the primary lane's
 * unselected tail. This function only reads candidates/nodes and returns a
 * fresh ordering; neither input array nor candidate object is mutated.
 */
export function buildOutcomeRecoveryPool(input: {
  candidates: readonly MergedCandidate[];
  nodes: readonly SentenceNode[];
  missingRanges: readonly { start: number; end: number }[];
  maxCandidates: number;
}): RecoveryPoolResult {
  if (input === null || typeof input !== "object") invariantFailure();
  validatePoolInput(input);
  const cap = boundedCap(input.maxCandidates);
  let excludedMissingRange = 0;
  const byRegion = new Map<number, MergedCandidate[]>();

  for (const candidate of input.candidates) {
    if (intersectsMissingRange(candidate, input.nodes, input.missingRanges)) {
      excludedMissingRange += 1;
      continue;
    }
    const region = regionFor(candidate, input.nodes)!;
    const bucket = byRegion.get(region) ?? [];
    bucket.push(candidate);
    byRegion.set(region, bucket);
  }

  if (cap === 0 || byRegion.size === 0) {
    return { candidates: [], excludedMissingRange };
  }

  const regions = [...byRegion.keys()].sort((a, b) => a - b);
  for (const region of regions) byRegion.get(region)!.sort(compareWithinRegion);

  const result: MergedCandidate[] = [];
  let rank = 0;
  while (result.length < cap) {
    let added = false;
    for (const region of regions) {
      const candidate = byRegion.get(region)![rank];
      if (candidate === undefined) continue;
      result.push(candidate);
      added = true;
      if (result.length >= cap) break;
    }
    if (!added) break;
    rank += 1;
  }

  return { candidates: result, excludedMissingRange };
}

/**
 * Eligibility is deliberately ordered. The first matching guard wins, so a
 * malformed combination of flags cannot produce an ambiguous telemetry key.
 */
export function isOutcomeRecoveryEligible(input: {
  mode: OutcomeRecoveryMode;
  primaryHighlights: readonly V2Highlight[];
  noClipsReason: NoClipsReasonValue | undefined;
  transcriptPartial: boolean;
  missingRangeDrops: number;
  path: string;
  unselectedCount: number;
}): RecoveryEligibility {
  if (
    input === null ||
    typeof input !== "object" ||
    !Array.isArray(input.primaryHighlights) ||
    typeof input.transcriptPartial !== "boolean"
  ) {
    invariantFailure();
  }
  if (input.mode !== "shadow" && input.mode !== "on") {
    return { eligible: false, reason: "mode_off" };
  }
  if (input.primaryHighlights.length > 0) {
    return { eligible: false, reason: "non_empty" };
  }
  if (input.transcriptPartial) {
    return { eligible: false, reason: "partial_transcript" };
  }
  if (input.noClipsReason !== "NO_VIABLE_MOMENTS") {
    return { eligible: false, reason: "wrong_content_reason" };
  }
  if (!isNonNegativeInteger(input.missingRangeDrops) || input.missingRangeDrops > 0) {
    return { eligible: false, reason: "missing_range" };
  }
  if (input.path === "degenerate") {
    return { eligible: false, reason: "degenerate" };
  }
  if (input.path === "song-gate" || input.path === "song_gate" || input.path === "song") {
    return { eligible: false, reason: "song_gate" };
  }
  // Tiny/music-short/unknown paths do not retain the full scanner tail. Keep
  // the reason vocabulary closed while failing such inconsistent input shut.
  if (input.path !== "full") {
    return { eligible: false, reason: "no_unjudged_tail" };
  }
  if (!isNonNegativeInteger(input.unselectedCount) || input.unselectedCount === 0) {
    return { eligible: false, reason: "no_unjudged_tail" };
  }
  return { eligible: true, reason: "unjudged_tail" };
}

export { HARD_MAX_CANDIDATES, PAYOFF_REGION_SEC };
