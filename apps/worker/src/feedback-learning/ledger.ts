import { canonicalJson, jsonLine, parseUtcMillisecond, sha256 } from "./canonical";
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

export type Freshness = Readonly<{ fresh: true }> | Readonly<{ fresh: false; reason: StaleReason }>;

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

const EFFECTIVE_LEDGER_KEYS = ["activeDecisions", "retiredTargetIds", "destinationLocks"] as const;

const DESTINATION_LOCK_KEYS = ["feedbackId", "set"] as const;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapHas = Map.prototype.has;
const mapDelete = Map.prototype.delete;
const mapForEach = Map.prototype.forEach;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const setForEach = Set.prototype.forEach;

function invalid(code: LedgerErrorCode): never {
  throw new LedgerError(code);
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareMany(...parts: readonly (readonly [string, string])[]): number {
  for (let index = 0; index < parts.length; index += 1) {
    const pair = dataAt(parts, index);
    const compared = byteCompare(dataAt(pair, 0), dataAt(pair, 1));
    if (compared !== 0) return compared;
  }
  return 0;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (keys[index] !== expected[index]) return false;
  }
  return true;
}

function hasExactKeySet(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const key = dataAt(expected, index);
    if (Object.getOwnPropertyDescriptor(value, key) === undefined) return false;
  }
  return true;
}

function defineArrayElement<T>(array: T[], index: number, value: T): void {
  Object.defineProperty(array, String(index), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function appendData<T>(array: T[], value: T): void {
  defineArrayElement(array, array.length, value);
}

function dataAt<T>(array: readonly T[], index: number): T {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  if (descriptor === undefined || !("value" in descriptor)) return invalid("invalid_event");
  return descriptor.value as T;
}

function insertionSort<T>(array: T[], compare: (left: T, right: T) => number): void {
  for (let index = 1; index < array.length; index += 1) {
    const value = dataAt(array, index);
    let insertion = index;
    while (insertion > 0 && compare(dataAt(array, insertion - 1), value) > 0) {
      defineArrayElement(array, insertion, dataAt(array, insertion - 1));
      insertion -= 1;
    }
    defineArrayElement(array, insertion, value);
  }
}

function copyArray<T>(source: readonly T[]): T[] {
  const result: T[] = [];
  for (let index = 0; index < source.length; index += 1) appendData(result, dataAt(source, index));
  return result;
}

function captureOwnData(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const captured: Record<string, unknown> = Object.create(null);
    const keys = Reflect.ownKeys(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = dataAt(keys, index);
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
      Object.defineProperty(captured, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
    return captured;
  } catch {
    return undefined;
  }
}

function captureDenseArray(value: unknown): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return undefined;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return undefined;
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || keys[keys.length - 1] !== "length") return undefined;

    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (keys[index] !== key) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
      defineArrayElement(captured, index, descriptor.value);
    }
    return captured;
  } catch {
    return undefined;
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isWellFormedUnicode(value);
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
  if (
    !isSha256(value.candidateVersion) ||
    !isNonEmptyString(value.feedbackId) ||
    !isUtcMillisecond(value.feedbackUpdatedAt) ||
    !isSha256(value.snapshotSha256) ||
    !isNonEmptyString(value.clipId) ||
    !isNonEmptyString(value.jobId) ||
    !isNonEmptyString(value.userId)
  ) {
    return false;
  }
  return (
    value.candidateVersion ===
    sha256(`${value.feedbackId}\n${value.feedbackUpdatedAt}\n${value.snapshotSha256}`)
  );
}

function validateEvent(value: unknown, requireKeyOrder = false): ReviewEvent {
  const captured = captureOwnData(value);
  if (captured === undefined) return invalid("invalid_event");
  const keysMatch = requireKeyOrder ? hasExactKeys : hasExactKeySet;

  if (captured.action === "approve") {
    if (
      !keysMatch(captured, APPROVAL_KEYS) ||
      !hasValidCommonFields(captured) ||
      !hasValidFrozenFields(captured) ||
      (captured.set !== "eval" && captured.set !== "holdout")
    ) {
      return invalid("invalid_event");
    }
    return captured as unknown as ApprovalEvent;
  }

  if (captured.action === "reject") {
    if (
      !keysMatch(captured, REJECTION_KEYS) ||
      !hasValidCommonFields(captured) ||
      !hasValidFrozenFields(captured) ||
      !isNonEmptyString(captured.reason)
    ) {
      return invalid("invalid_event");
    }
    return captured as unknown as RejectionEvent;
  }

  if (captured.action === "correct") {
    if (
      !keysMatch(captured, CORRECTION_KEYS) ||
      !hasValidCommonFields(captured) ||
      captured.operation !== "retire" ||
      !isNonEmptyString(captured.targetEventId) ||
      !isNonEmptyString(captured.reason)
    ) {
      return invalid("invalid_event");
    }
    return captured as unknown as ReviewEvent;
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
  const lines = contents.slice(0, -1).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = dataAt(lines, index);
    if (line.length === 0) return invalid("invalid_jsonl");

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return invalid("invalid_jsonl");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalid("invalid_jsonl");
    }
    const event = validateEvent(value, true);
    const compact = jsonLine(event).subarray(0, -1).toString("utf8");
    if (compact !== line) return invalid("invalid_jsonl");
    appendData(parsed, event);
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

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const rawEvent = dataAt(events, eventIndex);
    const event = validateEvent(rawEvent);
    if (setHas.call(seenEventIds, event.eventId)) return invalid("duplicate_event_id");
    setAdd.call(seenEventIds, event.eventId);

    if (event.action === "correct") {
      const target = mapGet.call(priorEvents, event.targetEventId) as ReviewEvent | undefined;
      if (target === undefined || target.action === "correct") {
        return invalid("invalid_transition");
      }
      const active = mapGet.call(activeByCandidate, target.candidateVersion) as
        | DecisionEvent
        | undefined;
      if (active?.eventId !== target.eventId) return invalid("invalid_transition");

      mapDelete.call(activeByCandidate, target.candidateVersion);
      if (
        target.action === "approve" &&
        (mapGet.call(activeApprovalByFeedback, target.feedbackId) as ApprovalEvent | undefined)
          ?.eventId === target.eventId
      ) {
        mapDelete.call(activeApprovalByFeedback, target.feedbackId);
      }
      setAdd.call(retiredTargetIds, target.eventId);
      mapSet.call(priorEvents, event.eventId, event);
      continue;
    }

    if (mapHas.call(activeByCandidate, event.candidateVersion)) {
      return invalid("invalid_transition");
    }

    if (event.action === "approve") {
      const lockedSet = mapGet.call(destinationLocks, event.feedbackId) as TargetSet | undefined;
      if (lockedSet !== undefined && lockedSet !== event.set) {
        return invalid("invalid_transition");
      }
      if (mapHas.call(activeApprovalByFeedback, event.feedbackId)) {
        return invalid("invalid_transition");
      }
      if (lockedSet === undefined) mapSet.call(destinationLocks, event.feedbackId, event.set);
      mapSet.call(activeApprovalByFeedback, event.feedbackId, event);
    }

    mapSet.call(activeByCandidate, event.candidateVersion, event);
    mapSet.call(priorEvents, event.eventId, event);
  }

  const activeDecisions: DecisionEvent[] = [];
  mapForEach.call(activeByCandidate, (decision) => appendData(activeDecisions, decision));
  insertionSort(activeDecisions, compareDecisions);
  const retired: string[] = [];
  setForEach.call(retiredTargetIds, (eventId) => appendData(retired, eventId));
  insertionSort(retired, byteCompare);
  const locks: DestinationLock[] = [];
  mapForEach.call(destinationLocks, (set, feedbackId) => appendData(locks, { feedbackId, set }));
  insertionSort(locks, compareLocks);

  return {
    activeDecisions,
    retiredTargetIds: retired,
    destinationLocks: locks,
  };
}

function validateDestinationLock(value: unknown): DestinationLock {
  const captured = captureOwnData(value);
  if (
    captured === undefined ||
    !hasExactKeySet(captured, DESTINATION_LOCK_KEYS) ||
    !isNonEmptyString(captured.feedbackId) ||
    (captured.set !== "eval" && captured.set !== "holdout")
  ) {
    return invalid("invalid_event");
  }
  return captured as DestinationLock;
}

function validateEffectiveLedger(value: unknown): EffectiveLedger {
  const root = captureOwnData(value);
  if (root === undefined || !hasExactKeySet(root, EFFECTIVE_LEDGER_KEYS)) {
    return invalid("invalid_event");
  }

  const rawDecisions = captureDenseArray(root.activeDecisions);
  const rawRetired = captureDenseArray(root.retiredTargetIds);
  const rawLocks = captureDenseArray(root.destinationLocks);
  if (rawDecisions === undefined || rawRetired === undefined || rawLocks === undefined) {
    return invalid("invalid_event");
  }

  const activeDecisions: DecisionEvent[] = [];
  const activeCandidateVersions = new Set<Sha256>();
  const activeEventIds = new Set<string>();
  const activeApprovalFeedbackIds = new Set<string>();
  for (let index = 0; index < rawDecisions.length; index += 1) {
    const rawDecision = dataAt(rawDecisions, index);
    const event = validateEvent(rawDecision);
    if (event.action === "correct") return invalid("invalid_event");
    if (
      setHas.call(activeCandidateVersions, event.candidateVersion) ||
      setHas.call(activeEventIds, event.eventId)
    ) {
      return invalid("invalid_transition");
    }
    setAdd.call(activeCandidateVersions, event.candidateVersion);
    setAdd.call(activeEventIds, event.eventId);
    if (event.action === "approve") {
      if (setHas.call(activeApprovalFeedbackIds, event.feedbackId)) {
        return invalid("invalid_transition");
      }
      setAdd.call(activeApprovalFeedbackIds, event.feedbackId);
    }
    appendData(activeDecisions, event);
  }

  const destinationLocks: DestinationLock[] = [];
  const lockByFeedback = new Map<string, TargetSet>();
  for (let index = 0; index < rawLocks.length; index += 1) {
    const rawLock = dataAt(rawLocks, index);
    const lock = validateDestinationLock(rawLock);
    if (mapHas.call(lockByFeedback, lock.feedbackId)) return invalid("invalid_transition");
    mapSet.call(lockByFeedback, lock.feedbackId, lock.set);
    appendData(destinationLocks, lock);
  }
  for (let index = 0; index < activeDecisions.length; index += 1) {
    const decision = dataAt(activeDecisions, index);
    if (
      decision.action === "approve" &&
      mapGet.call(lockByFeedback, decision.feedbackId) !== decision.set
    ) {
      return invalid("invalid_transition");
    }
  }

  const retiredTargetIds: string[] = [];
  const retiredIds = new Set<string>();
  for (let index = 0; index < rawRetired.length; index += 1) {
    const rawRetiredId = dataAt(rawRetired, index);
    if (!isNonEmptyString(rawRetiredId)) return invalid("invalid_event");
    if (setHas.call(retiredIds, rawRetiredId) || setHas.call(activeEventIds, rawRetiredId)) {
      return invalid("invalid_transition");
    }
    setAdd.call(retiredIds, rawRetiredId);
    appendData(retiredTargetIds, rawRetiredId);
  }

  return { activeDecisions, retiredTargetIds, destinationLocks };
}

export function canonicalLedgerState(state: EffectiveLedger): string {
  const validated = validateEffectiveLedger(state);
  const activeDecisions = copyArray(validated.activeDecisions);
  const retiredTargetIds = copyArray(validated.retiredTargetIds);
  const destinationLocks = copyArray(validated.destinationLocks);
  insertionSort(activeDecisions, compareDecisions);
  insertionSort(retiredTargetIds, byteCompare);
  insertionSort(destinationLocks, compareLocks);
  return canonicalJson({
    activeDecisions,
    retiredTargetIds,
    destinationLocks,
  });
}

export function classifyApprovalFreshness(
  approval: ApprovalEvent,
  current: FeedbackProjection | null
): Freshness {
  const validatedApproval = validateEvent(approval);
  if (validatedApproval.action !== "approve") return invalid("invalid_event");
  if (current === null) {
    return { fresh: false, reason: "missing" };
  }
  const capturedCurrent = captureOwnData(current);
  if (
    capturedCurrent === undefined ||
    Object.getOwnPropertyDescriptor(capturedCurrent, "id") === undefined ||
    Object.getOwnPropertyDescriptor(capturedCurrent, "verdict") === undefined ||
    Object.getOwnPropertyDescriptor(capturedCurrent, "updatedAt") === undefined ||
    Object.getOwnPropertyDescriptor(capturedCurrent, "snapshot") === undefined ||
    !isNonEmptyString(capturedCurrent.id) ||
    typeof capturedCurrent.verdict !== "string" ||
    !isWellFormedUnicode(capturedCurrent.verdict)
  ) {
    return invalid("invalid_event");
  }
  if (capturedCurrent.id !== validatedApproval.feedbackId) {
    return { fresh: false, reason: "missing" };
  }
  if (capturedCurrent.verdict !== "AS_IS") {
    return { fresh: false, reason: "verdict_changed" };
  }

  let currentUpdatedAt: string;
  try {
    currentUpdatedAt = Date.prototype.toISOString.call(capturedCurrent.updatedAt);
  } catch {
    return { fresh: false, reason: "updated_at_changed" };
  }
  if (currentUpdatedAt !== validatedApproval.feedbackUpdatedAt) {
    return { fresh: false, reason: "updated_at_changed" };
  }

  try {
    if (sha256(canonicalJson(capturedCurrent.snapshot)) !== validatedApproval.snapshotSha256) {
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
  mapSet.call(counts, key, ((mapGet.call(counts, key) as number | undefined) ?? 0) + 1);
}

function compareApprovals(left: ApprovalEvent, right: ApprovalEvent): number {
  return compareMany(
    [left.feedbackId, right.feedbackId],
    [left.candidateVersion, right.candidateVersion],
    [left.eventId, right.eventId]
  );
}

function sortedCounts(counts: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  const entries: [string, number][] = [];
  mapForEach.call(counts, (count, key) => appendData(entries, [key, count]));
  insertionSort(entries, (left, right) =>
    byteCompare(dataAt(left, 0) as string, dataAt(right, 0) as string));
  const result = new Map<string, number>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = dataAt(entries, index);
    const key = dataAt(entry, 0) as string;
    const count = dataAt(entry, 1) as number;
    mapSet.call(result, key, count);
  }
  return result;
}

function finalizeCapacity(capacity: MutableSetCapacity): SetCapacity {
  insertionSort(capacity.freshApprovals, compareApprovals);
  insertionSort(capacity.staleReservations, (left, right) =>
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
  const validated = validateEffectiveLedger(state);
  const capacities = {
    eval: emptyCapacity(),
    holdout: emptyCapacity(),
  };
  const countedFeedbackIds = {
    eval: new Set<string>(),
    holdout: new Set<string>(),
  };
  const approvals: ApprovalEvent[] = [];
  for (let index = 0; index < validated.activeDecisions.length; index += 1) {
    const event = dataAt(validated.activeDecisions, index);
    if (event.action === "approve") appendData(approvals, event);
  }
  insertionSort(approvals, compareApprovals);

  for (let index = 0; index < approvals.length; index += 1) {
    const approval = dataAt(approvals, index);
    const countedInDestination = countedFeedbackIds[approval.set];
    if (setHas.call(countedInDestination, approval.feedbackId)) continue;
    setAdd.call(countedInDestination, approval.feedbackId);

    const capacity = capacities[approval.set];
    const freshness = classifyApprovalFreshness(
      approval,
      (mapGet.call(currentRows, approval.feedbackId) as FeedbackProjection | null | undefined) ??
        null
    );
    if (freshness.fresh) appendData(capacity.freshApprovals, approval);
    else
      appendData(capacity.staleReservations, {
        approval,
        reason: freshness.reason,
      });
    increment(capacity.jobCounts, approval.jobId);
    increment(capacity.userCounts, approval.userId);
  }

  return {
    eval: finalizeCapacity(capacities.eval),
    holdout: finalizeCapacity(capacities.holdout),
  };
}
