import { canonicalJson, parseUtcMillisecond, sha256 } from "./canonical";
import type {
  ApprovalEvent,
  FeedbackProjection,
  RejectionEvent,
  ReviewEvent,
  Sha256,
  StaleReason,
  TargetSet,
} from "./types";

type DecisionEvent = ApprovalEvent | RejectionEvent;

export type LedgerErrorCode =
  | "invalid_encoding"
  | "invalid_jsonl"
  | "invalid_event"
  | "duplicate_event_id"
  | "invalid_transition";

export class LedgerError extends Error {
  constructor(readonly code: LedgerErrorCode) {
    super(code);
    this.name = "LedgerError";
  }
}

export type DestinationLock = Readonly<{
  feedbackId: string;
  set: TargetSet;
}>;

export type EffectiveLedger = Readonly<{
  activeDecisions: readonly DecisionEvent[];
  retiredTargetIds: readonly string[];
  destinationLocks: readonly DestinationLock[];
}>;

export type Freshness =
  | Readonly<{ fresh: true }>
  | Readonly<{ fresh: false; reason: StaleReason }>;

export type StaleReservation = Readonly<{
  approval: ApprovalEvent;
  reason: StaleReason;
}>;

export type SetCapacity = Readonly<{
  jobCounts: ReadonlyMap<string, number>;
  userCounts: ReadonlyMap<string, number>;
  freshApprovals: readonly ApprovalEvent[];
  staleReservations: readonly StaleReservation[];
}>;

export type CapacityState = Readonly<{
  eval: SetCapacity;
  holdout: SetCapacity;
}>;

const APPROVAL_KEYS = [
  "schemaVersion",
  "eventId",
  "action",
  "occurredAt",
  "candidateVersion",
  "feedbackId",
  "feedbackUpdatedAt",
  "snapshotSha256",
  "clipId",
  "jobId",
  "userId",
  "set",
] as const;

const REJECTION_KEYS = [
  "schemaVersion",
  "eventId",
  "action",
  "occurredAt",
  "candidateVersion",
  "feedbackId",
  "feedbackUpdatedAt",
  "snapshotSha256",
  "clipId",
  "jobId",
  "userId",
  "reason",
] as const;

const CORRECTION_KEYS = [
  "schemaVersion",
  "eventId",
  "action",
  "occurredAt",
  "operation",
  "targetEventId",
  "reason",
] as const;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function invalid(code: LedgerErrorCode): never {
  throw new LedgerError(code);
}

function byteCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareMany(...parts: readonly (readonly [string, string])[]): number {
  for (const [left, right] of parts) {
    const compared = byteCompare(left, right);
    if (compared !== 0) return compared;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (keys[index] !== expected[index]) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, expected[index]);
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isUtcMillisecond(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    parseUtcMillisecond(value);
    return true;
  } catch {
    return false;
  }
}

function hasValidCommonFields(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === 1 &&
    isNonEmptyString(value.eventId) &&
    isUtcMillisecond(value.occurredAt)
  );
}

function hasValidFrozenFields(value: Record<string, unknown>): boolean {
  return (
    isSha256(value.candidateVersion) &&
    isNonEmptyString(value.feedbackId) &&
    isUtcMillisecond(value.feedbackUpdatedAt) &&
    isSha256(value.snapshotSha256) &&
    isNonEmptyString(value.clipId) &&
    isNonEmptyString(value.jobId) &&
    isNonEmptyString(value.userId)
  );
}

function validateEvent(value: unknown): ReviewEvent {
  if (!isRecord(value) || !hasValidCommonFields(value)) return invalid("invalid_event");

  if (value.action === "approve") {
    if (
      !hasExactDataKeys(value, APPROVAL_KEYS) ||
      !hasValidFrozenFields(value) ||
      (value.set !== "eval" && value.set !== "holdout")
    ) {
      return invalid("invalid_event");
    }
    return value as unknown as ApprovalEvent;
  }

  if (value.action === "reject") {
    if (
      !hasExactDataKeys(value, REJECTION_KEYS) ||
      !hasValidFrozenFields(value) ||
      !isNonEmptyString(value.reason)
    ) {
      return invalid("invalid_event");
    }
    return value as unknown as RejectionEvent;
  }

  if (value.action === "correct") {
    if (
      !hasExactDataKeys(value, CORRECTION_KEYS) ||
      value.operation !== "retire" ||
      !isNonEmptyString(value.targetEventId) ||
      !isNonEmptyString(value.reason)
    ) {
      return invalid("invalid_event");
    }
    return value as unknown as ReviewEvent;
  }

  return invalid("invalid_event");
}

export function parseLedger(bytes: Buffer): readonly ReviewEvent[] {
  if (bytes.byteLength === 0) return [];
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return invalid("invalid_encoding");
  }

  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("invalid_encoding");
  }

  if (
    bytes[bytes.byteLength - 1] !== 0x0a ||
    contents.includes("\r") ||
    contents.endsWith("\n\n")
  ) {
    return invalid("invalid_jsonl");
  }

  const parsed: ReviewEvent[] = [];
  for (const line of contents.slice(0, -1).split("\n")) {
    if (line.length === 0) return invalid("invalid_jsonl");

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return invalid("invalid_jsonl");
    }
    if (!isRecord(value) || JSON.stringify(value) !== line) {
      return invalid("invalid_jsonl");
    }
    parsed.push(validateEvent(value));
  }
  return parsed;
}

function compareDecisions(left: DecisionEvent, right: DecisionEvent): number {
  return compareMany(
    [left.candidateVersion, right.candidateVersion],
    [left.eventId, right.eventId]
  );
}

function compareLocks(left: DestinationLock, right: DestinationLock): number {
  return compareMany([left.feedbackId, right.feedbackId], [left.set, right.set]);
}

export function foldLedger(events: readonly ReviewEvent[]): EffectiveLedger {
  const seenEventIds = new Set<string>();
  const priorEvents = new Map<string, ReviewEvent>();
  const activeByCandidate = new Map<Sha256, DecisionEvent>();
  const activeApprovalByFeedback = new Map<string, ApprovalEvent>();
  const destinationLocks = new Map<string, TargetSet>();
  const retiredTargetIds = new Set<string>();

  for (const rawEvent of events) {
    const event = validateEvent(rawEvent);
    if (seenEventIds.has(event.eventId)) return invalid("duplicate_event_id");
    seenEventIds.add(event.eventId);

    if (event.action === "correct") {
      const target = priorEvents.get(event.targetEventId);
      if (target === undefined || target.action === "correct") {
        return invalid("invalid_transition");
      }
      const active = activeByCandidate.get(target.candidateVersion);
      if (active?.eventId !== target.eventId) return invalid("invalid_transition");

      activeByCandidate.delete(target.candidateVersion);
      if (
        target.action === "approve" &&
        activeApprovalByFeedback.get(target.feedbackId)?.eventId === target.eventId
      ) {
        activeApprovalByFeedback.delete(target.feedbackId);
      }
      retiredTargetIds.add(target.eventId);
      priorEvents.set(event.eventId, event);
      continue;
    }

    if (activeByCandidate.has(event.candidateVersion)) {
      return invalid("invalid_transition");
    }

    if (event.action === "approve") {
      const lockedSet = destinationLocks.get(event.feedbackId);
      if (lockedSet !== undefined && lockedSet !== event.set) {
        return invalid("invalid_transition");
      }
      if (activeApprovalByFeedback.has(event.feedbackId)) {
        return invalid("invalid_transition");
      }
      if (lockedSet === undefined) destinationLocks.set(event.feedbackId, event.set);
      activeApprovalByFeedback.set(event.feedbackId, event);
    }

    activeByCandidate.set(event.candidateVersion, event);
    priorEvents.set(event.eventId, event);
  }

  const activeDecisions = [...activeByCandidate.values()].sort(compareDecisions);
  const retired = [...retiredTargetIds].sort(byteCompare);
  const locks = [...destinationLocks].map(([feedbackId, set]) => ({ feedbackId, set }));
  locks.sort(compareLocks);

  return {
    activeDecisions,
    retiredTargetIds: retired,
    destinationLocks: locks,
  };
}

export function canonicalLedgerState(state: EffectiveLedger): string {
  return canonicalJson({
    activeDecisions: [...state.activeDecisions].sort(compareDecisions),
    retiredTargetIds: [...state.retiredTargetIds].sort(byteCompare),
    destinationLocks: [...state.destinationLocks].sort(compareLocks),
  });
}

export function classifyApprovalFreshness(
  approval: ApprovalEvent,
  current: FeedbackProjection | null
): Freshness {
  if (current === null || current.id !== approval.feedbackId) {
    return { fresh: false, reason: "missing" };
  }
  if (current.verdict !== "AS_IS") return { fresh: false, reason: "verdict_changed" };

  let currentUpdatedAt: string;
  try {
    currentUpdatedAt = current.updatedAt.toISOString();
  } catch {
    return { fresh: false, reason: "updated_at_changed" };
  }
  if (currentUpdatedAt !== approval.feedbackUpdatedAt) {
    return { fresh: false, reason: "updated_at_changed" };
  }

  try {
    if (sha256(canonicalJson(current.snapshot)) !== approval.snapshotSha256) {
      return { fresh: false, reason: "snapshot_changed" };
    }
  } catch {
    return { fresh: false, reason: "snapshot_changed" };
  }
  return { fresh: true };
}

type MutableSetCapacity = {
  jobCounts: Map<string, number>;
  userCounts: Map<string, number>;
  freshApprovals: ApprovalEvent[];
  staleReservations: StaleReservation[];
};

function emptyCapacity(): MutableSetCapacity {
  return {
    jobCounts: new Map<string, number>(),
    userCounts: new Map<string, number>(),
    freshApprovals: [],
    staleReservations: [],
  };
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function compareApprovals(left: ApprovalEvent, right: ApprovalEvent): number {
  return compareMany(
    [left.feedbackId, right.feedbackId],
    [left.candidateVersion, right.candidateVersion],
    [left.eventId, right.eventId]
  );
}

function sortedCounts(counts: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  return new Map([...counts].sort(([left], [right]) => byteCompare(left, right)));
}

function finalizeCapacity(capacity: MutableSetCapacity): SetCapacity {
  capacity.freshApprovals.sort(compareApprovals);
  capacity.staleReservations.sort((left, right) =>
    compareMany(
      [left.approval.feedbackId, right.approval.feedbackId],
      [left.approval.candidateVersion, right.approval.candidateVersion],
      [left.approval.eventId, right.approval.eventId],
      [left.reason, right.reason]
    )
  );
  return {
    jobCounts: sortedCounts(capacity.jobCounts),
    userCounts: sortedCounts(capacity.userCounts),
    freshApprovals: capacity.freshApprovals,
    staleReservations: capacity.staleReservations,
  };
}

export function buildCapacity(
  state: EffectiveLedger,
  currentRows: ReadonlyMap<string, FeedbackProjection | null>
): CapacityState {
  const capacities = {
    eval: emptyCapacity(),
    holdout: emptyCapacity(),
  };
  const countedFeedbackIds = {
    eval: new Set<string>(),
    holdout: new Set<string>(),
  };
  const approvals = state.activeDecisions
    .filter((event): event is ApprovalEvent => event.action === "approve")
    .sort(compareApprovals);

  for (const approval of approvals) {
    const countedInDestination = countedFeedbackIds[approval.set];
    if (countedInDestination.has(approval.feedbackId)) continue;
    countedInDestination.add(approval.feedbackId);

    const capacity = capacities[approval.set];
    const freshness = classifyApprovalFreshness(
      approval,
      currentRows.get(approval.feedbackId) ?? null
    );
    if (freshness.fresh) capacity.freshApprovals.push(approval);
    else capacity.staleReservations.push({ approval, reason: freshness.reason });
    increment(capacity.jobCounts, approval.jobId);
    increment(capacity.userCounts, approval.userId);
  }

  return {
    eval: finalizeCapacity(capacities.eval),
    holdout: finalizeCapacity(capacities.holdout),
  };
}
