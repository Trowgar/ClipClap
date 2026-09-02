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
 * Preserves an inclusive decimal threshold after binary subtraction. The
 * allowance is scaled to the inputs' floating-point representation error, not
 * a product tolerance: a value measurably beyond `threshold` still fails.
 */
function withinInclusiveSeconds(value: number, target: number, threshold: number): boolean {
  const difference = Math.abs(value - target);
  if (difference <= threshold) return true;
  const representationAllowance =
    Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(target)) * 4;
  return difference - threshold <= representationAllowance;
}

/**
 * Pure signal for an immediate spoken handoff. It finds the final valid
 * word-bearing node inside the candidate range and the first such node after
 * it; opaque and malformed timing nodes are not speech boundaries.
 */
export function zeroTailHandoff(
  clip: Pick<SnappedClip, "endSec" | "finalStartNode" | "finalEndNode">,
  nodes: ReadonlyArray<Pick<SentenceNode, "start" | "end" | "hasWords">>,
): boolean {
  if (
    !Number.isFinite(clip.endSec) ||
    !Number.isInteger(clip.finalStartNode) ||
    !Number.isInteger(clip.finalEndNode) ||
    clip.finalStartNode < 0 ||
    clip.finalEndNode < clip.finalStartNode
  ) {
    return false;
  }
  const isValidWordNode = (
    node: Pick<SentenceNode, "start" | "end" | "hasWords"> | undefined,
  ): node is Pick<SentenceNode, "start" | "end" | "hasWords"> =>
    Boolean(
      node &&
        node.hasWords &&
        Number.isFinite(node.start) &&
        Number.isFinite(node.end) &&
        node.start < node.end,
    );
  let last: Pick<SentenceNode, "start" | "end" | "hasWords"> | undefined;
  for (let index = clip.finalEndNode; index >= clip.finalStartNode; index--) {
    if (isValidWordNode(nodes[index])) {
      last = nodes[index];
      break;
    }
  }
  let next: Pick<SentenceNode, "start" | "end" | "hasWords"> | undefined;
  for (let index = clip.finalEndNode + 1; index < nodes.length; index++) {
    if (isValidWordNode(nodes[index])) {
      next = nodes[index];
      break;
    }
  }
  return Boolean(
    last &&
      next &&
      withinInclusiveSeconds(last.end, clip.endSec, 0.05) &&
      withinInclusiveSeconds(next.start, clip.endSec, 0.05),
  );
}

const normalSeverity: Record<SafeEndNormalOutcome, number> = {
  hard_handoff: 0,
  needs_afterbeat: 1,
  audit_failed: 2,
  not_evaluable: 3,
  safe: 4,
};

/** Deterministically bounds normal detail. It never mutates the input records. */
export function capSafeEndNormalRecords(
  records: readonly SafeEndNormalRecord[],
): SafeEndCappedRecords<SafeEndNormalRecord> {
  const selected = [...records]
    .sort(
      (left, right) =>
        normalSeverity[left.outcome] - normalSeverity[right.outcome] ||
        compareCandidateIds(left.geometry.candidateId, right.geometry.candidateId),
    )
    .slice(0, DETAIL_CAP);
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
 * Appends outcome metadata from the actual pipeline arrays. The audited input
 * geometry establishes identity before finalization; after finalization, the
 * candidate id carries that identity through legitimate finalizer trims. No
 * input array, record, or clip is mutated.
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
    if (!afterFinalizer.some((clip) => clip.verdict.id === record.geometry.candidateId)) {
      return { ...base, reconciliation: { state: "removed_by_finalizer" } };
    }
    const shippedClip = shipped.find((clip) => clip.verdict.id === record.geometry.candidateId);
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
