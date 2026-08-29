import type { SentenceNode, SnappedClip } from "./types";

/** Closed outcomes emitted by the isolated normal end-completion audit. */
export type SafeEndNormalOutcome =
  | "safe"
  | "needs_afterbeat"
  | "hard_handoff"
  | "not_evaluable"
  | "audit_failed";

/** Explanation codes intentionally omit model prose and transcript content. */
export type SafeEndReason =
  | "post_payoff_context"
  | "next_question"
  | "topic_switch"
  | "unfinished_turn"
  | null;

/** Feature-local failures are recorded as closed telemetry, never model prose. */
export type SafeEndAuditFailureCode =
  | "model_refusal"
  | "malformed_response"
  | "timeout"
  | "construction_error";

export type RescueArcEvidence = "matching_standing" | "matching_clear" | "stale_or_absent";
export type RescueProposedAction = "none" | "zero_tail_handoff" | "standing_arc" | "both";
export type SafeEndRescueSelectedState = "selected" | "not_selected";

/** Rounded, job-local geometry only. It deliberately carries neither text nor
 * media identity, so it is safe to persist inside ANALYZE telemetry. */
export interface SafeEndGeometryReference {
  candidateId: string;
  startMs: number;
  endMs: number;
  startNode: number;
  endNode: number;
}

export interface SafeEndNormalRecord {
  geometry: SafeEndGeometryReference;
  score: number;
  language: string;
  kind?: string;
  outcome: SafeEndNormalOutcome;
  reason: SafeEndReason;
  failureCode?: SafeEndAuditFailureCode;
  extendToNode?: number | null;
  reconciliation?: SafeEndNormalReconciliation;
}

export interface SafeEndRescueRecord {
  geometry: SafeEndGeometryReference;
  score: number;
  scoreRank: number;
  zeroTailHandoff: boolean;
  arcEvidence: RescueArcEvidence;
  proposedAction: RescueProposedAction;
  selectedState: SafeEndRescueSelectedState;
}

export type SafeEndReconciliationState =
  | "shipped"
  | "removed_before_finalizer"
  | "removed_by_finalizer"
  | "removed_by_soft_cap";

export type SafeEndNormalReconciliation =
  | { state: "shipped"; finalGeometry: SafeEndGeometryReference }
  | {
      state:
        | "removed_before_finalizer"
        | "removed_by_finalizer"
        | "removed_by_soft_cap";
    };

export interface SafeEndCappedRecords<T> {
  records: T[];
  /** Number omitted from detailed telemetry. Aggregates remain the caller's
   * complete count and are never derived from this bounded list. */
  truncatedCount: number;
}

const DETAIL_CAP = 20;

function compareCandidateIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Converts actual snapped geometry to the exact reference used for matching.
 * Milliseconds are rounded once at the seam, so all downstream matching is
 * robust to harmless sub-millisecond floating point variation. */
export function safeEndGeometryReference(clip: SnappedClip): SafeEndGeometryReference {
  return {
    candidateId: clip.verdict.id,
    startMs: Math.round(clip.startSec * 1000),
    endMs: Math.round(clip.endSec * 1000),
    startNode: clip.finalStartNode,
    endNode: clip.finalEndNode,
  };
}

/** Alias kept descriptive at call sites that construct a telemetry record. */
export const geometryReference = safeEndGeometryReference;

/**
 * Pure signal for an immediate spoken handoff. The endpoint node and its
 * immediate following node must both be word-bearing and temporally valid;
 * opaque or malformed graph segments fail closed instead of being skipped.
 */
export function zeroTailHandoff(
  clip: Pick<SnappedClip, "endSec" | "finalEndNode">,
  nodes: ReadonlyArray<Pick<SentenceNode, "start" | "end" | "hasWords">>,
): boolean {
  const last = nodes[clip.finalEndNode];
  const next = nodes[clip.finalEndNode + 1];
  if (!last || !next || !last.hasWords || !next.hasWords) return false;
  if (
    !Number.isFinite(clip.endSec) ||
    !Number.isFinite(last.start) ||
    !Number.isFinite(last.end) ||
    !Number.isFinite(next.start) ||
    !Number.isFinite(next.end) ||
    last.start >= last.end ||
    next.start >= next.end
  ) {
    return false;
  }
  // Decimal timestamps such as 10.05 are not exactly representable in binary.
  // Scale the floating-point allowance to the two inputs so the inclusive
  // 50 ms edge survives representation noise without extending the threshold.
  const withinFiftyMs = (time: number) =>
    Math.abs(time - clip.endSec) <=
    0.05 + Number.EPSILON * Math.max(1, Math.abs(time), Math.abs(clip.endSec)) * 4;
  return withinFiftyMs(last.end) && withinFiftyMs(next.start);
}

const normalSeverity: Record<SafeEndNormalOutcome, number> = {
  hard_handoff: 0,
  needs_afterbeat: 1,
  audit_failed: 2,
  not_evaluable: 3,
  safe: 4,
};

const rescueSeverity: Record<RescueProposedAction, number> = {
  both: 0,
  zero_tail_handoff: 1,
  standing_arc: 2,
  none: 3,
};

function boundedLimit(limit: number): number {
  return Number.isInteger(limit) && limit >= 0 ? Math.min(limit, DETAIL_CAP) : DETAIL_CAP;
}

/** Deterministically bounds normal detail. It never mutates the input records. */
export function capSafeEndNormalRecords(
  records: readonly SafeEndNormalRecord[],
  limit = DETAIL_CAP,
): SafeEndCappedRecords<SafeEndNormalRecord> {
  const bounded = boundedLimit(limit);
  const selected = [...records]
    .sort(
      (left, right) =>
        normalSeverity[left.outcome] - normalSeverity[right.outcome] ||
        compareCandidateIds(left.geometry.candidateId, right.geometry.candidateId),
    )
    .slice(0, bounded);
  return { records: selected, truncatedCount: records.length - selected.length };
}

/** Deterministically bounds rescue detail while preserving the actual selected
 * rescue record in the capped cohort. The existing rescue path has at most one
 * selected candidate; malformed multi-selected input remains deterministically
 * bounded rather than silently expanding telemetry beyond its hard cap. */
export function capSafeEndRescueRecords(
  records: readonly SafeEndRescueRecord[],
  limit = DETAIL_CAP,
): SafeEndCappedRecords<SafeEndRescueRecord> {
  const bounded = boundedLimit(limit);
  const ordered = [...records].sort(
    (left, right) =>
      rescueSeverity[left.proposedAction] - rescueSeverity[right.proposedAction] ||
      compareCandidateIds(left.geometry.candidateId, right.geometry.candidateId),
  );
  const selected = ordered.slice(0, bounded);
  const rescueWinner = ordered.find((record) => record.selectedState === "selected");

  if (rescueWinner && !selected.includes(rescueWinner) && bounded > 0) {
    selected[selected.length - 1] = rescueWinner;
    selected.sort(
      (left, right) =>
        rescueSeverity[left.proposedAction] - rescueSeverity[right.proposedAction] ||
        compareCandidateIds(left.geometry.candidateId, right.geometry.candidateId),
    );
  }

  return { records: selected, truncatedCount: records.length - selected.length };
}

function sameGeometry(
  reference: SafeEndGeometryReference,
  clip: SnappedClip,
): boolean {
  const actual = safeEndGeometryReference(clip);
  return (
    actual.candidateId === reference.candidateId &&
    actual.startMs === reference.startMs &&
    actual.endMs === reference.endMs &&
    actual.startNode === reference.startNode &&
    actual.endNode === reference.endNode
  );
}

function hasGeometry(reference: SafeEndGeometryReference, clips: readonly SnappedClip[]): boolean {
  return clips.some((clip) => sameGeometry(reference, clip));
}

/**
 * Appends outcome metadata from the actual pipeline arrays. Matching requires
 * candidate id and the rounded snapped geometry, preventing an old geometry
 * from being attributed to a later re-snapped clip. No input array, record, or
 * clip is mutated.
 */
export function reconcileSafeEndNormalRecords(
  records: readonly SafeEndNormalRecord[],
  beforeFinalizer: readonly SnappedClip[],
  afterFinalizer: readonly SnappedClip[],
  shipped: readonly SnappedClip[],
): SafeEndNormalRecord[] {
  return records.map((record) => {
    const { reconciliation: _ignored, ...base } = record;
    if (!hasGeometry(record.geometry, beforeFinalizer)) {
      return { ...base, reconciliation: { state: "removed_before_finalizer" } };
    }
    if (!hasGeometry(record.geometry, afterFinalizer)) {
      return { ...base, reconciliation: { state: "removed_by_finalizer" } };
    }
    const shippedClip = shipped.find((clip) => sameGeometry(record.geometry, clip));
    if (!shippedClip) {
      return { ...base, reconciliation: { state: "removed_by_soft_cap" } };
    }
    return {
      ...base,
      reconciliation: { state: "shipped", finalGeometry: safeEndGeometryReference(shippedClip) },
    };
  });
}

export const reconcileSafeEndRecords = reconcileSafeEndNormalRecords;
