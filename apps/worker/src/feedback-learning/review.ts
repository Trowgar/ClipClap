import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";

import { canonicalJson, jsonLine, parseUtcMillisecond, sha256 } from "./canonical";
import { buildCapacity, foldLedger, parseLedger, type EffectiveLedger } from "./ledger";
import {
  ensurePrivateTree as defaultEnsurePrivateTree,
  readLedgerSnapshot,
  readPublishedCandidateSnapshot,
  replaceLedgerAtomically,
  type CommitResult,
  type LedgerWrite,
  type PrivatePaths,
} from "./persistence";
import type { FeedbackLearningRepository, ReviewDatabaseSnapshot } from "./repository";
import type {
  ApprovalEvent,
  Candidate,
  FeedbackProjection,
  RejectionEvent,
  ReviewEvent,
  Sha256,
  TargetSet,
  Tier,
  Warning,
} from "./types";

const DEFAULT_ROOT = resolve(__dirname, "../../.corpus/feedback-learning");
const RUN_PATTERN = /^(eval|holdout)-[0-9a-f]{16}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REQUEST_APPROVE_KEYS = ["action", "runId", "candidateVersion"] as const;
const REQUEST_REJECT_KEYS = ["action", "runId", "candidateVersion", "reason"] as const;
const REQUEST_CORRECT_KEYS = ["action", "targetEventId", "operation", "reason"] as const;
const REQUEST_KEYS = ["action", "runId", "candidateVersion", "reason", "targetEventId", "operation"] as const;
const DEPENDENCY_KEYS = ["repository", "root", "ensurePrivateTree", "withCorpusLock", "readLedger", "readCandidate", "replaceLedger", "eventId", "now"] as const;
const REPOSITORY_KEYS = ["captureExportSnapshot", "captureReviewSnapshot"] as const;
const PATH_KEYS = ["root", "exportsDir", "ledgerDir", "reviewsFile", "lockFile"] as const;
const SNAPSHOT_KEYS = ["candidate", "currentApprovals"] as const;
const FEEDBACK_KEYS = ["id", "clipId", "jobId", "userId", "verdict", "note", "snapshot", "evidenceKey", "updatedAt"] as const;
const CANDIDATE_KEYS = ["schemaVersion", "candidateVersion", "targetSet", "feedbackId", "clipId", "jobId", "userId", "updatedAt", "snapshotSha256", "language", "clipKind", "tier", "warnings", "review"] as const;
const REVIEW_KEYS = ["title", "startTime", "endTime", "score", "transcript", "note", "evidenceKey"] as const;
const RESULT_KEYS = ["status"] as const;
const WARNINGS: readonly Warning[] = ["job_missing", "transcript_missing", "transcript_segments_invalid", "transcript_partial", "snapshot_missing", "snapshot_sparse", "transcript_slice_missing", "evidence_missing"];
const TIERS: readonly Tier[] = ["replay-ready", "reference-only"];
const SAFE_CODES = new Set([
  "invalid_encoding", "invalid_jsonl", "invalid_event", "duplicate_event_id", "invalid_transition",
  "unsafe_path", "run_integrity", "invalid_input", "lock_timeout", "lock_unavailable",
]);
const getDescriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const isArray = Array.isArray;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const regexpTest = RegExp.prototype.test;
const stringStartsWith = String.prototype.startsWith;
const stringIncludes = String.prototype.includes;
const stringEndsWith = String.prototype.endsWith;
const stringSlice = String.prototype.slice;
const stringSplit = String.prototype.split;
const stringCharCodeAt = String.prototype.charCodeAt;
const bufferSubarray = Buffer.prototype.subarray;
const bufferToString = Buffer.prototype.toString;
const dateGetTime = Date.prototype.getTime;
const dateToISOString = Date.prototype.toISOString;
const reflectApply = Reflect.apply;

export type ReviewRequest =
  | { action: "approve" | "reject"; runId: string; candidateVersion: string; reason?: string }
  | { action: "correct"; targetEventId: string; operation: "retire"; reason: string };

type LockOperation = <T>(lockPath: string, operation: () => Promise<T>) => Promise<T>;
export interface ReviewDependencies {
  repository: FeedbackLearningRepository;
  root?: string;
  ensurePrivateTree?: (root: string) => Promise<PrivatePaths>;
  withCorpusLock?: LockOperation;
  readLedger?: (paths: PrivatePaths) => Promise<Uint8Array>;
  readCandidate?: (paths: PrivatePaths, runId: string) => Promise<Uint8Array>;
  replaceLedger?: (input: LedgerWrite) => Promise<CommitResult>;
  eventId?: () => string;
  now?: () => Date;
}

export type SafeReviewResult = Readonly<{
  operation: "review";
  eventId: string;
  status: CommitResult["status"];
}>;

type ValidatedDecisionRequest = Readonly<{ action: "approve" | "reject"; runId: string; candidateVersion: Sha256; targetSet: TargetSet; reason?: string }>;
type ValidatedCorrectionRequest = Readonly<{ action: "correct"; targetEventId: string; operation: "retire"; reason: string }>;
type ValidatedRequest = ValidatedDecisionRequest | ValidatedCorrectionRequest;
type CapturedDependencies = Required<Omit<ReviewDependencies, "root">> & { root: string };
type ReviewErrorCode =
  | "review_request_invalid" | "private_tree_failed" | "candidate_read_failed" | "candidate_file_invalid"
  | "candidate_not_found" | "ledger_read_failed" | "database_snapshot_failed" | "projection_failed"
  | "candidate_missing" | "candidate_not_as_is" | "candidate_changed" | "destination_locked"
  | "stale_review_requires_retirement" | "already_approved" | "already_rejected" | "job_cap"
  | "user_cap" | "event_identity_invalid" | "ledger_write_failed" | "review_failed"
  | "lock_unavailable" | "invalid_transition";

class ReviewBoundaryError extends Error {
  readonly code: ReviewErrorCode | string;
  constructor(code: ReviewErrorCode | string) { super(code); this.name = "ReviewBoundaryError"; this.code = code; }
}

function boundary(code: ReviewErrorCode | string): never { throw new ReviewBoundaryError(code); }
function isProxy(value: unknown): boolean {
  try { return value !== null && (typeof value === "object" || typeof value === "function") && utilTypes.isProxy(value); }
  catch { return true; }
}
function ownCode(error: unknown): unknown {
  try {
    if (error === null || typeof error !== "object" || isProxy(error)) return undefined;
    const descriptor = getDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
function isBoundary(error: unknown): boolean {
  try { return !isProxy(error) && error instanceof ReviewBoundaryError; }
  catch { return false; }
}
function translate(error: unknown, fallback: ReviewErrorCode): never {
  if (isBoundary(error)) throw error;
  const code = ownCode(error);
  if (typeof code === "string" && setHas.call(SAFE_CODES, code)) return boundary(code);
  return boundary(fallback);
}
function appendData<T>(array: T[], value: T): void {
  Object.defineProperty(array, String(array.length), { configurable: true, enumerable: true, value, writable: true });
}
function dataAt<T>(array: readonly T[], index: number, code: ReviewErrorCode = "projection_failed"): T {
  const descriptor = getDescriptor(array, String(index));
  if (descriptor === undefined || !("value" in descriptor)) return boundary(code);
  return descriptor.value as T;
}
function setData<T>(array: T[], index: number, value: T): void {
  Object.defineProperty(array, String(index), { configurable: true, enumerable: true, value, writable: true });
}
function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function sortStrings(values: string[]): void {
  for (let index = 1; index < values.length; index += 1) {
    const value = dataAt(values, index);
    let insertion = index;
    while (insertion > 0 && byteCompare(dataAt(values, insertion - 1), value) > 0) {
      setData(values, insertion, dataAt(values, insertion - 1));
      insertion -= 1;
    }
    setData(values, insertion, value);
  }
}
function contains(values: readonly string[], key: string): boolean {
  for (let index = 0; index < values.length; index += 1) if (dataAt(values, index) === key) return true;
  return false;
}
function captureObject(value: unknown, allowed: readonly string[], exact: boolean, code: ReviewErrorCode): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || isProxy(value) || isArray(value)) return boundary(code);
    const prototype = getPrototype(value);
    if (prototype !== Object.prototype && prototype !== null) return boundary(code);
    const keys = ownKeys(value);
    if (exact && keys.length !== allowed.length) return boundary(code);
    const captured: Record<string, unknown> = Object.create(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = dataAt(keys, index, code);
      if (typeof key !== "string" || !contains(allowed, key)) return boundary(code);
      const descriptor = getDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return boundary(code);
      Object.defineProperty(captured, key, { configurable: true, enumerable: true, value: descriptor.value, writable: true });
    }
    return captured;
  } catch (error) {
    if (isBoundary(error)) throw error;
    return boundary(code);
  }
}
function captureArray(value: unknown, code: ReviewErrorCode): unknown[] {
  try {
    if (!isArray(value) || isProxy(value) || getPrototype(value) !== Array.prototype) return boundary(code);
    const lengthDescriptor = getDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return boundary(code);
    const length = lengthDescriptor.value as number;
    const keys = ownKeys(value);
    if (keys.length !== length + 1) return boundary(code);
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (dataAt(keys, index, code) !== String(index)) return boundary(code);
      const descriptor = getDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return boundary(code);
      appendData(result, descriptor.value);
    }
    if (dataAt(keys, length, code) !== "length") return boundary(code);
    return result;
  } catch (error) {
    if (isBoundary(error)) throw error;
    return boundary(code);
  }
}
function captureFunction(value: unknown): (...args: never[]) => unknown {
  if (typeof value !== "function" || isProxy(value)) return boundary("review_request_invalid");
  return value as (...args: never[]) => unknown;
}
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = stringCharCodeAt.call(value, index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = stringCharCodeAt.call(value, index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && isWellFormed(value); }
function nullableString(value: unknown): boolean { return value === null || (typeof value === "string" && isWellFormed(value)); }
function sha(value: unknown): value is Sha256 { return typeof value === "string" && regexpTest.call(SHA256_PATTERN, value); }
function utc(value: unknown): value is string {
  if (typeof value !== "string" || !isWellFormed(value)) return false;
  try { parseUtcMillisecond(value); return true; } catch { return false; }
}
function enumValue<T>(values: readonly T[], value: unknown): value is T {
  for (let index = 0; index < values.length; index += 1) if (dataAt(values, index) === value) return true;
  return false;
}

function validateRequest(raw: ReviewRequest): ValidatedRequest {
  const broad = captureObject(raw, REQUEST_KEYS, false, "review_request_invalid");
  if (broad.action === "approve") {
    const value = captureObject(raw, REQUEST_APPROVE_KEYS, true, "review_request_invalid");
    if (typeof value.runId !== "string" || !regexpTest.call(RUN_PATTERN, value.runId) || !sha(value.candidateVersion)) return boundary("review_request_invalid");
    return { action: "approve", runId: value.runId, candidateVersion: value.candidateVersion, targetSet: stringStartsWith.call(value.runId, "eval-") ? "eval" : "holdout" };
  }
  if (broad.action === "reject") {
    const value = captureObject(raw, REQUEST_REJECT_KEYS, true, "review_request_invalid");
    if (typeof value.runId !== "string" || !regexpTest.call(RUN_PATTERN, value.runId) || !sha(value.candidateVersion) || !nonEmpty(value.reason)) return boundary("review_request_invalid");
    return { action: "reject", runId: value.runId, candidateVersion: value.candidateVersion, targetSet: stringStartsWith.call(value.runId, "eval-") ? "eval" : "holdout", reason: value.reason };
  }
  if (broad.action === "correct") {
    const value = captureObject(raw, REQUEST_CORRECT_KEYS, true, "review_request_invalid");
    if (value.operation !== "retire" || !nonEmpty(value.targetEventId) || !nonEmpty(value.reason)) return boundary("review_request_invalid");
    return { action: "correct", operation: "retire", targetEventId: value.targetEventId, reason: value.reason };
  }
  return boundary("review_request_invalid");
}

const defaultLock: LockOperation = async (path, operation) => {
  try {
    const lock = await import("./lock");
    return await lock.withCorpusLock(path, operation);
  } catch (error) { return translate(error, "lock_unavailable"); }
};
function captureDependencies(raw: ReviewDependencies): CapturedDependencies {
  const value = captureObject(raw, DEPENDENCY_KEYS, false, "review_request_invalid");
  if (!("repository" in value)) return boundary("review_request_invalid");
  const repository = captureObject(value.repository, REPOSITORY_KEYS, true, "review_request_invalid");
  if (value.root !== undefined && (!nonEmpty(value.root) || stringIncludes.call(value.root, "\0"))) return boundary("review_request_invalid");
  return {
    repository: { captureExportSnapshot: captureFunction(repository.captureExportSnapshot) as FeedbackLearningRepository["captureExportSnapshot"], captureReviewSnapshot: captureFunction(repository.captureReviewSnapshot) as FeedbackLearningRepository["captureReviewSnapshot"] },
    root: (value.root as string | undefined) ?? DEFAULT_ROOT,
    ensurePrivateTree: (value.ensurePrivateTree === undefined ? defaultEnsurePrivateTree : captureFunction(value.ensurePrivateTree)) as CapturedDependencies["ensurePrivateTree"],
    withCorpusLock: (value.withCorpusLock === undefined ? defaultLock : captureFunction(value.withCorpusLock)) as LockOperation,
    readLedger: (value.readLedger === undefined ? readLedgerSnapshot : captureFunction(value.readLedger)) as CapturedDependencies["readLedger"],
    readCandidate: (value.readCandidate === undefined ? readPublishedCandidateSnapshot : captureFunction(value.readCandidate)) as CapturedDependencies["readCandidate"],
    replaceLedger: (value.replaceLedger === undefined ? replaceLedgerAtomically : captureFunction(value.replaceLedger)) as CapturedDependencies["replaceLedger"],
    eventId: (value.eventId === undefined ? randomUUID : captureFunction(value.eventId)) as CapturedDependencies["eventId"],
    now: (value.now === undefined ? (() => new Date()) : captureFunction(value.now)) as CapturedDependencies["now"],
  };
}

function capturePaths(raw: unknown, root: string): PrivatePaths {
  const value = captureObject(raw, PATH_KEYS, true, "private_tree_failed");
  if (
    value.root !== root ||
    value.exportsDir !== join(root, "exports") ||
    value.ledgerDir !== join(root, "ledger") ||
    value.reviewsFile !== join(root, "ledger", "reviews.jsonl") ||
    value.lockFile !== join(root, "ledger", "reviews.lock")
  ) return boundary("private_tree_failed");
  return value as unknown as PrivatePaths;
}
function validateReview(raw: unknown): Candidate["review"] {
  const value = captureObject(raw, REVIEW_KEYS, true, "candidate_file_invalid");
  if (!nullableString(value.title) || (value.startTime !== null && (typeof value.startTime !== "number" || !Number.isFinite(value.startTime))) ||
      (value.endTime !== null && (typeof value.endTime !== "number" || !Number.isFinite(value.endTime))) ||
      (value.score !== null && (typeof value.score !== "number" || !Number.isFinite(value.score))) ||
      !nullableString(value.transcript) || !nullableString(value.note) || !nullableString(value.evidenceKey)) return boundary("candidate_file_invalid");
  return value as unknown as Candidate["review"];
}
function validateWarnings(raw: unknown): readonly Warning[] {
  const values = captureArray(raw, "candidate_file_invalid");
  const result: Warning[] = [];
  const seen = new Set<Warning>();
  for (let index = 0; index < values.length; index += 1) {
    const value = dataAt(values, index, "candidate_file_invalid");
    if (!enumValue(WARNINGS, value) || setHas.call(seen, value)) return boundary("candidate_file_invalid");
    setAdd.call(seen, value); appendData(result, value);
  }
  return result;
}
function validateCandidate(raw: unknown, targetSet: TargetSet): Candidate {
  const value = captureObject(raw, CANDIDATE_KEYS, true, "candidate_file_invalid");
  if (value.schemaVersion !== 1 || !sha(value.candidateVersion) || value.targetSet !== targetSet || !nonEmpty(value.feedbackId) || !nonEmpty(value.clipId) || !nonEmpty(value.jobId) || !nonEmpty(value.userId) || !utc(value.updatedAt) || !sha(value.snapshotSha256) || !nonEmpty(value.language) || !nonEmpty(value.clipKind) || !enumValue(TIERS, value.tier)) return boundary("candidate_file_invalid");
  if (value.candidateVersion !== sha256(`${value.feedbackId}\n${value.updatedAt}\n${value.snapshotSha256}`)) return boundary("candidate_file_invalid");
  return { schemaVersion: 1, candidateVersion: value.candidateVersion, targetSet, feedbackId: value.feedbackId,
    clipId: value.clipId, jobId: value.jobId, userId: value.userId, updatedAt: value.updatedAt,
    snapshotSha256: value.snapshotSha256, language: value.language, clipKind: value.clipKind,
    tier: value.tier, warnings: validateWarnings(value.warnings), review: validateReview(value.review) };
}
function parseCandidateFile(bytes: Uint8Array, requested: Sha256, targetSet: TargetSet): Candidate {
  const copied = Buffer.from(bytes);
  if (copied.byteLength === 0) return boundary("candidate_missing");
  if (copied[0] === 0xef && copied[1] === 0xbb && copied[2] === 0xbf) return boundary("candidate_file_invalid");
  let contents: string;
  try { contents = new TextDecoder("utf-8", { fatal: true }).decode(copied); } catch { return boundary("candidate_file_invalid"); }
  if (copied[copied.byteLength - 1] !== 0x0a || stringIncludes.call(contents, "\r") || stringEndsWith.call(contents, "\n\n")) return boundary("candidate_file_invalid");
  const versions = new Set<string>(); const feedbackIds = new Set<string>(); let selected: Candidate | undefined;
  const lines = reflectApply(
    stringSplit,
    stringSlice.call(contents, 0, -1),
    ["\n"],
  ) as string[];
  for (let index = 0; index < lines.length; index += 1) {
    const line = dataAt(lines, index, "candidate_file_invalid");
    if (line.length === 0) return boundary("candidate_file_invalid");
    let parsed: unknown; try { parsed = JSON.parse(line); } catch { return boundary("candidate_file_invalid"); }
    const item = validateCandidate(parsed, targetSet);
    const compact = bufferToString.call(bufferSubarray.call(jsonLine(item), 0, -1), "utf8");
    if (compact !== line || setHas.call(versions, item.candidateVersion) || setHas.call(feedbackIds, item.feedbackId)) return boundary("candidate_file_invalid");
    setAdd.call(versions, item.candidateVersion); setAdd.call(feedbackIds, item.feedbackId);
    if (item.candidateVersion === requested) {
      if (selected !== undefined) return boundary("candidate_file_invalid");
      selected = item;
    }
  }
  return selected ?? boundary("candidate_not_found");
}

function captureFeedback(raw: unknown): FeedbackProjection {
  const value = captureObject(raw, FEEDBACK_KEYS, true, "projection_failed");
  if (!nonEmpty(value.id) || !nonEmpty(value.clipId) || !nonEmpty(value.jobId) || !nonEmpty(value.userId) || typeof value.verdict !== "string" || !isWellFormed(value.verdict) || !nullableString(value.note) || !nullableString(value.evidenceKey)) return boundary("projection_failed");
  let updatedAt: Date;
  try { const milliseconds = dateGetTime.call(value.updatedAt); if (!Number.isFinite(milliseconds)) return boundary("projection_failed"); updatedAt = new Date(milliseconds); }
  catch { return boundary("projection_failed"); }
  try { canonicalJson(value.snapshot); } catch { return boundary("projection_failed"); }
  return { id: value.id, clipId: value.clipId, jobId: value.jobId, userId: value.userId, verdict: value.verdict,
    note: value.note as string | null, snapshot: value.snapshot, evidenceKey: value.evidenceKey as string | null, updatedAt };
}
function captureDatabaseSnapshot(raw: unknown, activeIds: readonly string[]): ReviewDatabaseSnapshot {
  const value = captureObject(raw, SNAPSHOT_KEYS, true, "projection_failed");
  const candidate = value.candidate === null ? null : captureFeedback(value.candidate);
  const values = captureArray(value.currentApprovals, "projection_failed");
  const currentApprovals: FeedbackProjection[] = []; const seen = new Set<string>(); const expected = new Set<string>();
  for (let index = 0; index < activeIds.length; index += 1) setAdd.call(expected, dataAt(activeIds, index));
  for (let index = 0; index < values.length; index += 1) {
    const item = captureFeedback(dataAt(values, index));
    if (!setHas.call(expected, item.id) || setHas.call(seen, item.id)) return boundary("projection_failed");
    setAdd.call(seen, item.id); appendData(currentApprovals, item);
  }
  return { candidate, currentApprovals };
}
function activeApprovalIds(state: EffectiveLedger): string[] {
  const ids: string[] = [];
  for (let index = 0; index < state.activeDecisions.length; index += 1) {
    const event = dataAt(state.activeDecisions, index);
    if (event.action === "approve") appendData(ids, event.feedbackId);
  }
  sortStrings(ids);
  return ids;
}
function assertCurrent(candidate: Candidate, current: FeedbackProjection | null): FeedbackProjection {
  if (current === null) return boundary("candidate_missing");
  if (current.verdict !== "AS_IS") return boundary("candidate_not_as_is");
  const updatedAt = dateToISOString.call(current.updatedAt);
  const snapshotSha256 = sha256(canonicalJson(current.snapshot));
  const version = sha256(`${current.id}\n${updatedAt}\n${snapshotSha256}`);
  if (version !== candidate.candidateVersion || current.id !== candidate.feedbackId || updatedAt !== candidate.updatedAt ||
      snapshotSha256 !== candidate.snapshotSha256 || current.clipId !== candidate.clipId || current.jobId !== candidate.jobId || current.userId !== candidate.userId) return boundary("candidate_changed");
  return current;
}
function currentMap(ids: readonly string[], rows: readonly FeedbackProjection[]): ReadonlyMap<string, FeedbackProjection | null> {
  const result = new Map<string, FeedbackProjection | null>();
  for (let index = 0; index < ids.length; index += 1) mapSet.call(result, dataAt(ids, index), null);
  for (let index = 0; index < rows.length; index += 1) { const row = dataAt(rows, index); mapSet.call(result, row.id, row); }
  return result;
}
function mint(dependencies: CapturedDependencies): Readonly<{ eventId: string; occurredAt: string }> {
  let eventId: unknown; let occurredAt: string;
  try { eventId = dependencies.eventId.call(undefined); } catch { return boundary("event_identity_invalid"); }
  if (!nonEmpty(eventId)) return boundary("event_identity_invalid");
  try { occurredAt = dateToISOString.call(dependencies.now.call(undefined)); parseUtcMillisecond(occurredAt); }
  catch { return boundary("event_identity_invalid"); }
  return { eventId, occurredAt };
}
function validateCommit(raw: unknown): CommitResult {
  const value = captureObject(raw, RESULT_KEYS, true, "ledger_write_failed");
  if (value.status !== "committed" && value.status !== "noop" && value.status !== "committed_durability_uncertain" && value.status !== "indeterminate") return boundary("ledger_write_failed");
  return { status: value.status };
}
function appendLedger(prior: Uint8Array, event: ReviewEvent): Uint8Array {
  const line = jsonLine(event); const result = new Uint8Array(prior.byteLength + line.byteLength);
  for (let index = 0; index < prior.byteLength; index += 1) result[index] = prior[index];
  for (let index = 0; index < line.byteLength; index += 1) result[prior.byteLength + index] = line[index];
  return result;
}

async function insideLock(request: ValidatedRequest, candidate: Candidate | undefined, paths: PrivatePaths, dependencies: CapturedDependencies): Promise<SafeReviewResult> {
  let prior: Uint8Array;
  try { prior = new Uint8Array(await dependencies.readLedger.call(undefined, paths)); } catch (error) { return translate(error, "ledger_read_failed"); }
  let events: readonly ReviewEvent[]; let state: EffectiveLedger;
  try { events = parseLedger(Buffer.from(prior)); state = foldLedger(events); } catch (error) { return translate(error, "ledger_read_failed"); }
  let event: ReviewEvent;
  if (request.action === "correct") {
    const identity = mint(dependencies);
    event = { schemaVersion: 1, eventId: identity.eventId, action: "correct", occurredAt: identity.occurredAt,
      operation: "retire", targetEventId: request.targetEventId, reason: request.reason };
  } else {
    if (candidate === undefined) return boundary("candidate_not_found");
    const approvalIds = activeApprovalIds(state);
    let rawSnapshot: unknown;
    try { rawSnapshot = await dependencies.repository.captureReviewSnapshot.call(undefined, { candidateFeedbackId: candidate.feedbackId, activeApprovalFeedbackIds: approvalIds }); }
    catch (error) { return translate(error, "database_snapshot_failed"); }
    const snapshot = captureDatabaseSnapshot(rawSnapshot, approvalIds);
    const current = assertCurrent(candidate, snapshot.candidate);
    for (let index = 0; index < state.activeDecisions.length; index += 1) {
      const decision = dataAt(state.activeDecisions, index);
      if (decision.candidateVersion === candidate.candidateVersion) return boundary(decision.action === "approve" ? "already_approved" : "already_rejected");
      if (decision.action === "approve" && decision.feedbackId === candidate.feedbackId) return boundary("stale_review_requires_retirement");
    }
    for (let index = 0; index < state.destinationLocks.length; index += 1) {
      const lock = dataAt(state.destinationLocks, index);
      if (lock.feedbackId === current.id && lock.set !== request.targetSet) return boundary("destination_locked");
    }
    if (request.action === "approve") {
      const rows = currentMap(approvalIds, snapshot.currentApprovals);
      const capacity = buildCapacity(state, rows)[request.targetSet];
      const jobCount = (mapGet.call(capacity.jobCounts, current.jobId) as number | undefined) ?? 0;
      if (jobCount >= 2) return boundary("job_cap");
      const userCount = (mapGet.call(capacity.userCounts, current.userId) as number | undefined) ?? 0;
      if (userCount >= 3) return boundary("user_cap");
    }
    const identity = mint(dependencies);
    const frozen = {
      candidateVersion: candidate.candidateVersion, feedbackId: current.id,
      feedbackUpdatedAt: dateToISOString.call(current.updatedAt), snapshotSha256: sha256(canonicalJson(current.snapshot)),
      clipId: current.clipId, jobId: current.jobId, userId: current.userId,
    };
    event = request.action === "approve"
      ? { schemaVersion: 1, eventId: identity.eventId, action: "approve", occurredAt: identity.occurredAt,
          ...frozen, set: request.targetSet } as ApprovalEvent
      : { schemaVersion: 1, eventId: identity.eventId, action: "reject", occurredAt: identity.occurredAt,
          ...frozen, reason: request.reason as string } as RejectionEvent;
  }
  const prospective: ReviewEvent[] = [];
  for (let index = 0; index < events.length; index += 1) appendData(prospective, dataAt(events, index));
  appendData(prospective, event);
  try { foldLedger(prospective); } catch (error) { return translate(error, "invalid_transition"); }
  let committed: CommitResult;
  try { committed = validateCommit(await dependencies.replaceLedger.call(undefined, { paths, bytes: appendLedger(prior, event), expectedEventId: event.eventId })); }
  catch (error) { return translate(error, "ledger_write_failed"); }
  return { operation: "review", eventId: event.eventId, status: committed.status };
}

export async function reviewFeedback(rawRequest: ReviewRequest, rawDependencies: ReviewDependencies): Promise<SafeReviewResult> {
  const request = validateRequest(rawRequest);
  const dependencies = captureDependencies(rawDependencies);
  let paths: PrivatePaths;
  try { paths = capturePaths(await dependencies.ensurePrivateTree.call(undefined, dependencies.root), dependencies.root); }
  catch (error) { return translate(error, "private_tree_failed"); }
  let selected: Candidate | undefined;
  if (request.action !== "correct") {
    const candidatePath = resolve(paths.exportsDir, request.runId, "candidates.jsonl");
    const trustedPrefix = `${resolve(paths.exportsDir)}${sep}`;
    if (!stringStartsWith.call(candidatePath, trustedPrefix)) return boundary("unsafe_path");
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await dependencies.readCandidate.call(undefined, paths, request.runId)); }
    catch (error) { return translate(error, "candidate_read_failed"); }
    selected = parseCandidateFile(bytes, request.candidateVersion, request.targetSet);
  }
  try {
    return await (dependencies.withCorpusLock as LockOperation)<SafeReviewResult>(
      paths.lockFile,
      () => insideLock(request, selected, paths, dependencies),
    );
  }
  catch (error) { return translate(error, "lock_unavailable"); }
}
