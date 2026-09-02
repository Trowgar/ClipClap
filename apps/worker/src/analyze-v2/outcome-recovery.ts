import type { OutcomeRecoveryMode } from "./config";
import { isCandidateType, isNormalizedCandidateInterest } from "./types";
import type {
  MergedCandidate,
  NoClipsReasonValue,
  SentenceNode,
  V2Highlight,
} from "./types";

const PAYOFF_REGION_SEC = 600;
const HARD_MAX_CANDIDATES = 12;

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
  if (input.mode !== "shadow" && input.mode !== "on") {
    return { eligible: false, reason: "mode_off" };
  }
  if (input.primaryHighlights.length > 0) {
    return { eligible: false, reason: "non_empty" };
  }
  if (input.noClipsReason !== "NO_VIABLE_MOMENTS") {
    return { eligible: false, reason: "wrong_content_reason" };
  }
  if (input.transcriptPartial) {
    return { eligible: false, reason: "partial_transcript" };
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
