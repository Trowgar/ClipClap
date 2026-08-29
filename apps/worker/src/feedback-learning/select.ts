import { types as utilTypes } from "node:util";

import { canonicalJson, parseUtcMillisecond, sha256 } from "./canonical";
import {
  canonicalLedgerState,
  type CapacityState,
  type EffectiveLedger,
  type SetCapacity,
} from "./ledger";
import type {
  ApprovalEvent,
  Candidate,
  Exclusion,
  InvalidDetailCode,
  NormalizedFeedbackRecord,
  NormalizedFeedbackResult,
  ReviewRecord,
  Sha256,
  StaleReason,
  TargetSet,
  Warning,
} from "./types";

export type SelectionInput = Readonly<{
  results: readonly NormalizedFeedbackResult[];
  targetSet: TargetSet;
  limit: number;
  ledger: EffectiveLedger;
  capacity: CapacityState;
}>;
export type SelectionResult = Readonly<{
  queried: number;
  candidates: readonly Candidate[];
  exclusions: readonly Exclusion[];
}>;
export type ValidatedSelectionInput = SelectionInput;
export type SelectionFieldValues = Readonly<{
  results: unknown;
  targetSet: unknown;
  limit: unknown;
  ledger: unknown;
  capacity: unknown;
}>;

const JOB_LIMIT = 2;
const USER_LIMIT = 3;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ROOT_KEYS = ["results", "targetSet", "limit", "ledger", "capacity"] as const;
const LEDGER_KEYS = ["activeDecisions", "retiredTargetIds", "destinationLocks"] as const;
const CAPACITY_KEYS = ["eval", "holdout"] as const;
const SET_CAPACITY_KEYS = [
  "jobCounts",
  "userCounts",
  "freshApprovals",
  "staleReservations",
] as const;
const STALE_RESERVATION_KEYS = ["approval", "reason"] as const;
const RECORD_KEYS = [
  "feedbackId",
  "clipId",
  "jobId",
  "userId",
  "verdict",
  "note",
  "evidenceKey",
  "updatedAt",
  "snapshotCanonical",
  "snapshotSha256",
  "jobProjectionId",
  "jobPresent",
  "transcriptPresent",
  "segmentsIsArray",
  "transcriptPartial",
  "language",
  "clipKind",
  "tier",
  "warnings",
  "review",
] as const;
const REVIEW_KEYS = [
  "title",
  "startTime",
  "endTime",
  "score",
  "transcript",
  "note",
  "evidenceKey",
] as const;
const VALID_RESULT_KEYS = ["status", "candidateVersion", "record"] as const;
const INVALID_RESULT_KEYS = ["status", "invalid"] as const;
const INVALID_KEYS = ["feedbackId", "candidateVersion", "reason", "detailCode"] as const;
const WARNING_ORDER: readonly Warning[] = [
  "job_missing",
  "transcript_missing",
  "transcript_segments_invalid",
  "transcript_partial",
  "snapshot_missing",
  "snapshot_sparse",
  "transcript_slice_missing",
  "evidence_missing",
];
const INVALID_DETAILS: readonly InvalidDetailCode[] = [
  "identity_unavailable",
  "snapshot_not_json",
  "projection_invalid",
];
const STALE_REASONS: readonly StaleReason[] = [
  "missing",
  "verdict_changed",
  "updated_at_changed",
  "snapshot_changed",
];

const mapForEach = Map.prototype.forEach;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapHas = Map.prototype.has;
const mapSizeGetter = Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get;

function invalidInput(): never {
  throw new TypeError("selection_input_invalid");
}
export function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function appendData<T>(array: T[], value: T): void {
  Object.defineProperty(array, String(array.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
function setData<T>(array: T[], index: number, value: T): void {
  Object.defineProperty(array, String(index), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
function dataAt<T>(array: readonly T[], index: number): T {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  if (descriptor === undefined || !("value" in descriptor)) return invalidInput();
  return descriptor.value as T;
}
export function insertionSort<T>(array: T[], compare: (left: T, right: T) => number): void {
  for (let index = 1; index < array.length; index += 1) {
    const value = dataAt(array, index);
    let insertion = index;
    while (insertion > 0 && compare(dataAt(array, insertion - 1), value) > 0) {
      setData(array, insertion, dataAt(array, insertion - 1));
      insertion -= 1;
    }
    setData(array, insertion, value);
  }
}
function contains(expected: readonly string[], key: string): boolean {
  for (let index = 0; index < expected.length; index += 1)
    if (dataAt(expected, index) === key) return true;
  return false;
}
function enumIndex<T>(values: readonly T[], value: unknown): number {
  for (let index = 0; index < values.length; index += 1)
    if (dataAt(values, index) === value) return index;
  return -1;
}

export function captureOwnData(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | undefined {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      utilTypes.isProxy(value) ||
      Array.isArray(value)
    )
      return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length) return undefined;
    const captured: Record<string, unknown> = Object.create(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = dataAt(keys, index);
      if (typeof key !== "string" || !contains(expected, key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
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
export function captureDenseArray(value: unknown): unknown[] | undefined {
  try {
    if (
      !Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    )
      return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    )
      return undefined;
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) return undefined;
    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (dataAt(keys, index) !== String(index)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
      appendData(captured, descriptor.value);
    }
    if (dataAt(keys, length) !== "length") return undefined;
    return captured;
  } catch {
    return undefined;
  }
}
export function captureClosedRoot(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | undefined {
  return captureOwnData(value, expected);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function isString(value: unknown): value is string {
  return typeof value === "string" && isWellFormedUnicode(value);
}
function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}
function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}
function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}
function isUtc(value: unknown): value is string {
  if (!isString(value)) return false;
  try {
    parseUtcMillisecond(value);
    return true;
  } catch {
    return false;
  }
}
function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}
function isNullableFinite(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function validateReview(value: unknown): ReviewRecord {
  const review = captureOwnData(value, REVIEW_KEYS);
  if (
    review === undefined ||
    !isNullableString(review.title) ||
    !isNullableFinite(review.startTime) ||
    !isNullableFinite(review.endTime) ||
    !isNullableFinite(review.score) ||
    !isNullableString(review.transcript) ||
    !isNullableString(review.note) ||
    !isNullableString(review.evidenceKey)
  )
    return invalidInput();
  return {
    title: review.title,
    startTime: review.startTime,
    endTime: review.endTime,
    score: review.score,
    transcript: review.transcript,
    note: review.note,
    evidenceKey: review.evidenceKey,
  };
}
function validateWarnings(value: unknown): readonly Warning[] {
  const raw = captureDenseArray(value);
  if (raw === undefined) return invalidInput();
  const warnings: Warning[] = [];
  let prior = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const warning = dataAt(raw, index);
    const position = enumIndex(WARNING_ORDER, warning);
    if (position <= prior) return invalidInput();
    prior = position;
    appendData(warnings, warning as Warning);
  }
  return warnings;
}
function validateRecord(value: unknown): NormalizedFeedbackRecord {
  const record = captureOwnData(value, RECORD_KEYS);
  if (
    record === undefined ||
    !isNonEmptyString(record.feedbackId) ||
    !isNonEmptyString(record.clipId) ||
    !isNonEmptyString(record.jobId) ||
    !isNonEmptyString(record.userId) ||
    record.verdict !== "AS_IS" ||
    !isNullableString(record.note) ||
    !isNullableString(record.evidenceKey) ||
    !isUtc(record.updatedAt) ||
    !isString(record.snapshotCanonical) ||
    !isSha256(record.snapshotSha256) ||
    sha256(record.snapshotCanonical) !== record.snapshotSha256 ||
    (record.jobProjectionId !== null && !isNonEmptyString(record.jobProjectionId)) ||
    typeof record.jobPresent !== "boolean" ||
    !isNullableBoolean(record.transcriptPresent) ||
    !isNullableBoolean(record.segmentsIsArray) ||
    !isNullableBoolean(record.transcriptPartial) ||
    !isNonEmptyString(record.language) ||
    !isNonEmptyString(record.clipKind) ||
    (record.tier !== "replay-ready" && record.tier !== "reference-only")
  )
    return invalidInput();
  return {
    feedbackId: record.feedbackId,
    clipId: record.clipId,
    jobId: record.jobId,
    userId: record.userId,
    verdict: "AS_IS",
    note: record.note,
    evidenceKey: record.evidenceKey,
    updatedAt: record.updatedAt,
    snapshotCanonical: record.snapshotCanonical,
    snapshotSha256: record.snapshotSha256,
    jobProjectionId: record.jobProjectionId,
    jobPresent: record.jobPresent,
    transcriptPresent: record.transcriptPresent,
    segmentsIsArray: record.segmentsIsArray,
    transcriptPartial: record.transcriptPartial,
    language: record.language,
    clipKind: record.clipKind,
    tier: record.tier,
    warnings: validateWarnings(record.warnings),
    review: validateReview(record.review),
  };
}
function resultCompare(left: NormalizedFeedbackResult, right: NormalizedFeedbackResult): number {
  const leftId = left.status === "valid" ? left.record.feedbackId : (left.invalid.feedbackId ?? "");
  const rightId =
    right.status === "valid" ? right.record.feedbackId : (right.invalid.feedbackId ?? "");
  const id = byteCompare(leftId, rightId);
  return id !== 0 ? id : byteCompare(canonicalJson(left), canonicalJson(right));
}
function validateResults(value: unknown): readonly NormalizedFeedbackResult[] {
  const raw = captureDenseArray(value);
  if (raw === undefined) return invalidInput();
  const results: NormalizedFeedbackResult[] = [];
  const feedbackIds = new Set<string>();
  const versions = new Set<Sha256>();
  for (let index = 0; index < raw.length; index += 1) {
    const item = dataAt(raw, index);
    const valid = captureOwnData(item, VALID_RESULT_KEYS);
    if (valid !== undefined && valid.status === "valid") {
      const record = validateRecord(valid.record);
      if (
        !isSha256(valid.candidateVersion) ||
        valid.candidateVersion !==
          sha256(`${record.feedbackId}\n${record.updatedAt}\n${record.snapshotSha256}`) ||
        feedbackIds.has(record.feedbackId) ||
        versions.has(valid.candidateVersion)
      )
        return invalidInput();
      feedbackIds.add(record.feedbackId);
      versions.add(valid.candidateVersion);
      appendData(results, {
        status: "valid",
        candidateVersion: valid.candidateVersion,
        record,
      });
      continue;
    }
    const invalidResult = captureOwnData(item, INVALID_RESULT_KEYS);
    const invalid =
      invalidResult?.status === "invalid"
        ? captureOwnData(invalidResult.invalid, INVALID_KEYS)
        : undefined;
    if (
      invalid === undefined ||
      (invalid.feedbackId !== null && !isNonEmptyString(invalid.feedbackId)) ||
      invalid.candidateVersion !== null ||
      invalid.reason !== "invalid_row" ||
      enumIndex(INVALID_DETAILS, invalid.detailCode) < 0
    )
      return invalidInput();
    if (invalid.feedbackId !== null) {
      if (feedbackIds.has(invalid.feedbackId)) return invalidInput();
      feedbackIds.add(invalid.feedbackId);
    }
    appendData(results, {
      status: "invalid",
      invalid: {
        feedbackId: invalid.feedbackId as string | null,
        candidateVersion: null,
        reason: "invalid_row",
        detailCode: invalid.detailCode as InvalidDetailCode,
      },
    });
  }
  insertionSort(results, resultCompare);
  return results;
}

function validateLedger(value: unknown): EffectiveLedger {
  const root = captureOwnData(value, LEDGER_KEYS);
  if (root === undefined) return invalidInput();
  const activeDecisions = captureDenseArray(root.activeDecisions);
  const retiredTargetIds = captureDenseArray(root.retiredTargetIds);
  const destinationLocks = captureDenseArray(root.destinationLocks);
  if (
    activeDecisions === undefined ||
    retiredTargetIds === undefined ||
    destinationLocks === undefined
  )
    return invalidInput();
  for (let index = 0; index < activeDecisions.length; index += 1) {
    const item = dataAt(activeDecisions, index);
    if (item !== null && typeof item === "object" && utilTypes.isProxy(item)) return invalidInput();
  }
  for (let index = 0; index < destinationLocks.length; index += 1) {
    const item = dataAt(destinationLocks, index);
    if (item !== null && typeof item === "object" && utilTypes.isProxy(item)) return invalidInput();
  }
  try {
    return JSON.parse(
      canonicalLedgerState({
        activeDecisions: activeDecisions as EffectiveLedger["activeDecisions"],
        retiredTargetIds: retiredTargetIds as EffectiveLedger["retiredTargetIds"],
        destinationLocks: destinationLocks as EffectiveLedger["destinationLocks"],
      }),
    ) as EffectiveLedger;
  } catch {
    return invalidInput();
  }
}
function mapSize(value: Map<unknown, unknown>): number {
  if (mapSizeGetter === undefined) return invalidInput();
  return mapSizeGetter.call(value) as number;
}
function captureCountMap(value: unknown): Map<string, number> {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    !utilTypes.isMap(value)
  )
    return invalidInput();
  const result = new Map<string, number>();
  try {
    mapForEach.call(value as Map<unknown, unknown>, (count, key) => {
      if (
        !isNonEmptyString(key) ||
        !Number.isSafeInteger(count) ||
        (count as number) <= 0 ||
        mapHas.call(result, key)
      )
        return invalidInput();
      mapSet.call(result, key, count as number);
    });
  } catch {
    return invalidInput();
  }
  return result;
}
function incrementMap(counts: Map<string, number>, key: string): void {
  mapSet.call(counts, key, ((mapGet.call(counts, key) as number | undefined) ?? 0) + 1);
}
function sameCounts(left: Map<string, number>, right: Map<string, number>): boolean {
  if (mapSize(left) !== mapSize(right)) return false;
  let equal = true;
  mapForEach.call(left, (count, key) => {
    if (mapGet.call(right, key) !== count) equal = false;
  });
  return equal;
}
type ApprovalLookup = Readonly<{ approval: ApprovalEvent; canonical: string }>;

function validateCapacity(value: unknown, ledger: EffectiveLedger): CapacityState {
  const activeByVersion = new Map<Sha256, ApprovalLookup>();
  for (let index = 0; index < ledger.activeDecisions.length; index += 1) {
    const decision = dataAt(ledger.activeDecisions, index);
    if (decision.action === "approve")
      mapSet.call(activeByVersion, decision.candidateVersion, {
        approval: decision,
        canonical: canonicalJson(decision),
      });
  }
  const root = captureOwnData(value, CAPACITY_KEYS);
  if (root === undefined) return invalidInput();
  const seen = new Set<Sha256>();
  const validatedSets: Partial<Record<TargetSet, SetCapacity>> = Object.create(null);
  for (let setIndex = 0; setIndex < CAPACITY_KEYS.length; setIndex += 1) {
    const set = dataAt(CAPACITY_KEYS, setIndex);
    const rawSet = captureOwnData(root[set], SET_CAPACITY_KEYS);
    if (rawSet === undefined) return invalidInput();
    const suppliedJobs = captureCountMap(rawSet.jobCounts);
    const suppliedUsers = captureCountMap(rawSet.userCounts);
    const rawFresh = captureDenseArray(rawSet.freshApprovals);
    const rawStale = captureDenseArray(rawSet.staleReservations);
    if (rawFresh === undefined || rawStale === undefined) return invalidInput();
    const freshApprovals: ApprovalEvent[] = [];
    const staleReservations: {
      approval: ApprovalEvent;
      reason: StaleReason;
    }[] = [];
    const jobs = new Map<string, number>();
    const users = new Map<string, number>();
    const consume = (rawApproval: unknown): ApprovalEvent => {
      if (rawApproval === null || typeof rawApproval !== "object" || utilTypes.isProxy(rawApproval))
        return invalidInput();
      let capturedCanonical: string;
      let captured: unknown;
      try {
        capturedCanonical = canonicalJson(rawApproval);
        captured = JSON.parse(capturedCanonical) as unknown;
      } catch {
        return invalidInput();
      }
      const descriptor =
        captured !== null && typeof captured === "object"
          ? Object.getOwnPropertyDescriptor(captured, "candidateVersion")
          : undefined;
      const version =
        descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
      if (!isSha256(version)) return invalidInput();
      const expected = mapGet.call(activeByVersion, version) as ApprovalLookup | undefined;
      if (
        expected === undefined ||
        expected.canonical !== capturedCanonical ||
        expected.approval.set !== set ||
        seen.has(version)
      )
        return invalidInput();
      seen.add(version);
      incrementMap(jobs, expected.approval.jobId);
      incrementMap(users, expected.approval.userId);
      return expected.approval;
    };
    for (let index = 0; index < rawFresh.length; index += 1)
      appendData(freshApprovals, consume(dataAt(rawFresh, index)));
    for (let index = 0; index < rawStale.length; index += 1) {
      const reservation = captureOwnData(dataAt(rawStale, index), STALE_RESERVATION_KEYS);
      if (reservation === undefined || enumIndex(STALE_REASONS, reservation.reason) < 0)
        return invalidInput();
      appendData(staleReservations, {
        approval: consume(reservation.approval),
        reason: reservation.reason as StaleReason,
      });
    }
    if (!sameCounts(suppliedJobs, jobs) || !sameCounts(suppliedUsers, users)) return invalidInput();
    validatedSets[set] = {
      jobCounts: jobs,
      userCounts: users,
      freshApprovals,
      staleReservations,
    };
  }
  if (seen.size !== mapSize(activeByVersion)) return invalidInput();
  return {
    eval: validatedSets.eval as SetCapacity,
    holdout: validatedSets.holdout as SetCapacity,
  };
}

export function validateSelectionFields(fields: SelectionFieldValues): ValidatedSelectionInput {
  try {
    if (
      (fields.targetSet !== "eval" && fields.targetSet !== "holdout") ||
      !Number.isSafeInteger(fields.limit) ||
      (fields.limit as number) <= 0
    )
      return invalidInput();
    const ledger = validateLedger(fields.ledger);
    return {
      results: validateResults(fields.results),
      targetSet: fields.targetSet,
      limit: fields.limit as number,
      ledger,
      capacity: validateCapacity(fields.capacity, ledger),
    };
  } catch {
    return invalidInput();
  }
}
function captureSelectionInput(value: unknown): ValidatedSelectionInput {
  const root = captureClosedRoot(value, ROOT_KEYS);
  if (root === undefined) return invalidInput();
  return validateSelectionFields({
    results: root.results,
    targetSet: root.targetSet,
    limit: root.limit,
    ledger: root.ledger,
    capacity: root.capacity,
  });
}
function requestedCapacity(capacity: CapacityState, set: TargetSet): SetCapacity {
  return set === "eval" ? capacity.eval : capacity.holdout;
}
function cloneCounts(source: ReadonlyMap<string, number>): Map<string, number> {
  const result = new Map<string, number>();
  mapForEach.call(source, (count, key) => mapSet.call(result, key, count));
  return result;
}
function capExclusion(
  result: Extract<NormalizedFeedbackResult, { status: "valid" }>,
  reason: "job_cap" | "user_cap",
  limit: number,
  occupied: number,
): Exclusion {
  return {
    schemaVersion: 1,
    feedbackId: result.record.feedbackId,
    candidateVersion: result.candidateVersion,
    reason,
    cap: { limit, occupied },
  };
}
function simpleExclusion(
  result: Extract<NormalizedFeedbackResult, { status: "valid" }>,
  reason:
    | "stale_review_requires_retirement"
    | "already_approved"
    | "already_rejected"
    | "limit_reached",
): Exclusion {
  return {
    schemaVersion: 1,
    feedbackId: result.record.feedbackId,
    candidateVersion: result.candidateVersion,
    reason,
  };
}
function candidate(
  result: Extract<NormalizedFeedbackResult, { status: "valid" }>,
  targetSet: TargetSet,
): Candidate {
  const record = result.record;
  return {
    schemaVersion: 1,
    candidateVersion: result.candidateVersion,
    targetSet,
    feedbackId: record.feedbackId,
    clipId: record.clipId,
    jobId: record.jobId,
    userId: record.userId,
    updatedAt: record.updatedAt,
    snapshotSha256: record.snapshotSha256,
    language: record.language,
    clipKind: record.clipKind,
    tier: record.tier,
    warnings: record.warnings,
    review: {
      title: record.review.title,
      startTime: record.review.startTime,
      endTime: record.review.endTime,
      score: record.review.score,
      transcript: record.review.transcript,
      note: record.review.note,
      evidenceKey: record.review.evidenceKey,
    },
  };
}
type ValidResult = Extract<NormalizedFeedbackResult, { status: "valid" }>;
type Stratum = {
  language: string;
  clipKind: string;
  rows: ValidResult[];
  cursor: number;
};
function rowCompare(left: ValidResult, right: ValidResult): number {
  const time = byteCompare(right.record.updatedAt, left.record.updatedAt);
  if (time !== 0) return time;
  const feedback = byteCompare(left.record.feedbackId, right.record.feedbackId);
  return feedback !== 0 ? feedback : byteCompare(left.candidateVersion, right.candidateVersion);
}

export function selectValidatedCandidates(input: ValidatedSelectionInput): SelectionResult {
  const exclusions: Exclusion[] = [];
  const undecided: ValidResult[] = [];
  const decisions = new Map<Sha256, "approve" | "reject">();
  const staleByFeedback = new Map<string, Sha256>();
  for (let index = 0; index < input.ledger.activeDecisions.length; index += 1) {
    const decision = dataAt(input.ledger.activeDecisions, index);
    mapSet.call(decisions, decision.candidateVersion, decision.action);
  }
  for (const set of ["eval", "holdout"] as const) {
    const stale = requestedCapacity(input.capacity, set).staleReservations;
    for (let index = 0; index < stale.length; index += 1) {
      const approval = dataAt(stale, index).approval;
      mapSet.call(staleByFeedback, approval.feedbackId, approval.candidateVersion);
    }
  }
  for (let index = 0; index < input.results.length; index += 1) {
    const result = dataAt(input.results, index);
    if (result.status === "invalid") {
      appendData(exclusions, {
        schemaVersion: 1,
        feedbackId: result.invalid.feedbackId,
        candidateVersion: null,
        reason: "invalid_row",
        detailCode: result.invalid.detailCode,
      });
      continue;
    }
    const staleVersion = mapGet.call(staleByFeedback, result.record.feedbackId) as
      | Sha256
      | undefined;
    if (staleVersion !== undefined && staleVersion !== result.candidateVersion) {
      appendData(exclusions, simpleExclusion(result, "stale_review_requires_retirement"));
      continue;
    }
    const decision = mapGet.call(decisions, result.candidateVersion) as
      | "approve"
      | "reject"
      | undefined;
    if (decision === "approve") {
      appendData(exclusions, simpleExclusion(result, "already_approved"));
      continue;
    }
    if (decision === "reject") {
      appendData(exclusions, simpleExclusion(result, "already_rejected"));
      continue;
    }
    appendData(undecided, result);
  }
  const strataByKey = new Map<string, Stratum>();
  for (let index = 0; index < undecided.length; index += 1) {
    const result = dataAt(undecided, index);
    const key = `${Buffer.from(result.record.language, "utf8").toString("hex")}:${Buffer.from(result.record.clipKind, "utf8").toString("hex")}`;
    let stratum = mapGet.call(strataByKey, key) as Stratum | undefined;
    if (stratum === undefined) {
      stratum = {
        language: result.record.language,
        clipKind: result.record.clipKind,
        rows: [],
        cursor: 0,
      };
      mapSet.call(strataByKey, key, stratum);
    }
    appendData(stratum.rows, result);
  }
  const strata: Stratum[] = [];
  mapForEach.call(strataByKey, (stratum) => appendData(strata, stratum));
  insertionSort(strata, (left, right) => {
    const language = byteCompare(left.language, right.language);
    return language !== 0 ? language : byteCompare(left.clipKind, right.clipKind);
  });
  for (let index = 0; index < strata.length; index += 1)
    insertionSort(dataAt(strata, index).rows, rowCompare);
  const starting = requestedCapacity(input.capacity, input.targetSet);
  const startingJobs = cloneCounts(starting.jobCounts);
  const startingUsers = cloneCounts(starting.userCounts);
  for (let stratumIndex = 0; stratumIndex < strata.length; stratumIndex += 1) {
    const stratum = dataAt(strata, stratumIndex);
    const eligible: ValidResult[] = [];
    for (let rowIndex = 0; rowIndex < stratum.rows.length; rowIndex += 1) {
      const result = dataAt(stratum.rows, rowIndex);
      const jobOccupied =
        (mapGet.call(startingJobs, result.record.jobId) as number | undefined) ?? 0;
      const userOccupied =
        (mapGet.call(startingUsers, result.record.userId) as number | undefined) ?? 0;
      if (jobOccupied >= JOB_LIMIT)
        appendData(exclusions, capExclusion(result, "job_cap", JOB_LIMIT, jobOccupied));
      else if (userOccupied >= USER_LIMIT)
        appendData(exclusions, capExclusion(result, "user_cap", USER_LIMIT, userOccupied));
      else appendData(eligible, result);
    }
    stratum.rows = eligible;
  }
  const provisionalJobs = cloneCounts(startingJobs);
  const provisionalUsers = cloneCounts(startingUsers);
  const candidates: Candidate[] = [];
  let remaining = 0;
  for (let index = 0; index < strata.length; index += 1)
    remaining += dataAt(strata, index).rows.length;
  while (remaining > 0) {
    for (let stratumIndex = 0; stratumIndex < strata.length; stratumIndex += 1) {
      const stratum = dataAt(strata, stratumIndex);
      if (stratum.cursor >= stratum.rows.length) continue;
      const result = dataAt(stratum.rows, stratum.cursor);
      stratum.cursor += 1;
      remaining -= 1;
      const jobOccupied =
        (mapGet.call(provisionalJobs, result.record.jobId) as number | undefined) ?? 0;
      if (jobOccupied >= JOB_LIMIT) {
        appendData(exclusions, capExclusion(result, "job_cap", JOB_LIMIT, jobOccupied));
        continue;
      }
      const userOccupied =
        (mapGet.call(provisionalUsers, result.record.userId) as number | undefined) ?? 0;
      if (userOccupied >= USER_LIMIT) {
        appendData(exclusions, capExclusion(result, "user_cap", USER_LIMIT, userOccupied));
        continue;
      }
      if (candidates.length >= input.limit) {
        appendData(exclusions, simpleExclusion(result, "limit_reached"));
        continue;
      }
      appendData(candidates, candidate(result, input.targetSet));
      incrementMap(provisionalJobs, result.record.jobId);
      incrementMap(provisionalUsers, result.record.userId);
    }
  }
  return { queried: input.results.length, candidates, exclusions };
}
export function selectCandidates(input: SelectionInput): SelectionResult {
  try {
    return selectValidatedCandidates(captureSelectionInput(input));
  } catch {
    return invalidInput();
  }
}
