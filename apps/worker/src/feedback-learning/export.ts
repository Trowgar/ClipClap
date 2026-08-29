import { resolve } from "node:path";
import { types as utilTypes } from "node:util";
import { canonicalJson, parseUtcMillisecond, sha256 } from "./canonical";
import { buildCapacity, canonicalLedgerState, classifyApprovalFreshness, foldLedger, LedgerError, parseLedger, type EffectiveLedger } from "./ledger";
import { normalizeFeedback } from "./normalize";
import {
  ensurePrivateTree as defaultEnsurePrivateTree,
  PersistenceInputError,
  PersistenceIntegrityError,
  PersistencePathError,
  publishRunAtomically as defaultPublishRunAtomically,
  readLedgerSnapshot,
  type CommitResult,
  type PrivatePaths,
  type RunWrite,
} from "./persistence";
import { buildRunArtifacts, type ApprovalFreshnessProjection } from "./render";
import type { DatabaseSnapshot, FeedbackLearningRepository } from "./repository";
import type { ApprovalEvent, FeedbackProjection, JobProjection, RunCounts, Sha256, TargetSet } from "./types";

const DEFAULT_LIMIT = 50;
const DEFAULT_ROOT = resolve(__dirname, "../../.corpus/feedback-learning");
const REQUEST_KEYS = ["targetSet", "updatedFrom", "updatedTo", "limit"] as const;
const DEPENDENCY_KEYS = ["repository", "root", "ensurePrivateTree", "withCorpusLock", "readLedger", "publishRunAtomically"] as const;
const SNAPSHOT_KEYS = ["feedback", "jobs", "currentApprovals"] as const;
const PATH_KEYS = ["root", "exportsDir", "ledgerDir", "reviewsFile", "lockFile"] as const;
const FEEDBACK_KEYS = ["id", "clipId", "jobId", "userId", "verdict", "note", "snapshot", "evidenceKey", "updatedAt"] as const;
const JOB_KEYS = ["id", "transcriptJson", "transcriptPartial"] as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const getDescriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const isArray = Array.isArray;
const jsonParse = JSON.parse;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapHas = Map.prototype.has;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;

export type ExportRequest = Readonly<{ targetSet: TargetSet; updatedFrom: string; updatedTo: string; limit?: number }>;
export type SafeExportResult = Readonly<{ operation: "export"; runId: string; status: CommitResult["status"]; counts: RunCounts }>;
type LockOperation = <T>(lockPath: string, operation: () => Promise<T>) => Promise<T>;
const defaultWithCorpusLock: LockOperation = async (lockPath, operation) => {
  const lock = await import("./lock");
  try { return await lock.withCorpusLock(lockPath, operation); }
  catch (error) {
    if (isKnownError(error, lock.CorpusLockError)) {
      const code = safeOwnCode(error);
      return boundary(code === "lock_timeout" ? "lock_timeout" : "lock_unavailable");
    }
    throw error;
  }
};
export interface ExportDependencies {
  repository: FeedbackLearningRepository;
  root?: string;
  ensurePrivateTree?: (root: string) => Promise<PrivatePaths>;
  withCorpusLock?: LockOperation;
  readLedger?: (paths: PrivatePaths) => Promise<Uint8Array>;
  publishRunAtomically?: (input: RunWrite) => Promise<CommitResult>;
}
type ExportErrorCode = "export_request_invalid" | "private_tree_failed" | "ledger_read_failed" | "database_snapshot_failed" | "projection_failed" | "publish_failed" | "lock_unavailable" | "lock_timeout";
class ExportBoundaryError extends Error {
  readonly code: ExportErrorCode;
  constructor(code: ExportErrorCode) { super(code); this.name = "ExportBoundaryError"; this.code = code; }
}
type ValidatedRequest = Readonly<{ targetSet: TargetSet; updatedFrom: string; updatedTo: string; updatedFromDate: Date; updatedToDate: Date; limit: number }>;
type CapturedDependencies = Required<Omit<ExportDependencies, "root">> & { root: string };

function boundary(code: ExportErrorCode): never { throw new ExportBoundaryError(code); }
function isProxySafe(value: unknown): boolean {
  try { return value !== null && (typeof value === "object" || typeof value === "function") && utilTypes.isProxy(value); }
  catch { return true; }
}
function isKnownError<T extends Error>(error: unknown, constructor: new (...args: never[]) => T): error is T {
  try {
    if (error === null || (typeof error !== "object" && typeof error !== "function") || isProxySafe(error)) return false;
    return error instanceof constructor;
  } catch { return false; }
}
function isExportBoundary(error: unknown): error is ExportBoundaryError {
  return isKnownError(error, ExportBoundaryError);
}
function isLedgerError(error: unknown): error is LedgerError {
  return isKnownError(error, LedgerError);
}
function safeOwnCode(error: unknown): unknown {
  try {
    if (error === null || typeof error !== "object" || isProxySafe(error)) return undefined;
    const descriptor = getDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
function appendData<T>(array: T[], value: T): void {
  Object.defineProperty(array, String(array.length), { configurable: true, enumerable: true, value, writable: true });
}
function dataAt<T>(array: readonly T[], index: number): T {
  const descriptor = getDescriptor(array, String(index));
  if (descriptor === undefined || !("value" in descriptor)) return boundary("projection_failed");
  return descriptor.value as T;
}
function setData<T>(array: T[], index: number, value: T): void {
  Object.defineProperty(array, String(index), { configurable: true, enumerable: true, value, writable: true });
}
function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function contains(expected: readonly string[], key: string): boolean {
  for (let index = 0; index < expected.length; index += 1) if (dataAt(expected, index) === key) return true;
  return false;
}
function captureObject(value: unknown, allowed: readonly string[], exact: boolean, code: ExportErrorCode): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || isArray(value)) return boundary(code);
    const prototype = getPrototype(value);
    if (prototype !== Object.prototype && prototype !== null) return boundary(code);
    const keys = ownKeys(value);
    if (exact && keys.length !== allowed.length) return boundary(code);
    const captured: Record<string, unknown> = Object.create(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = dataAt(keys, index);
      if (typeof key !== "string" || !contains(allowed, key)) return boundary(code);
      const descriptor = getDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return boundary(code);
      Object.defineProperty(captured, key, { configurable: true, enumerable: true, value: descriptor.value, writable: true });
    }
    return captured;
  } catch (error) {
    if (isExportBoundary(error)) throw error;
    return boundary(code);
  }
}
function captureDenseArray(value: unknown): unknown[] {
  try {
    if (!isArray(value) || utilTypes.isProxy(value) || getPrototype(value) !== Array.prototype) return boundary("projection_failed");
    const lengthDescriptor = getDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return boundary("projection_failed");
    const length = lengthDescriptor.value as number;
    const keys = ownKeys(value);
    if (keys.length !== length + 1) return boundary("projection_failed");
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (dataAt(keys, index) !== String(index)) return boundary("projection_failed");
      const descriptor = getDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return boundary("projection_failed");
      appendData(result, descriptor.value);
    }
    if (dataAt(keys, length) !== "length") return boundary("projection_failed");
    return result;
  } catch (error) {
    if (isExportBoundary(error)) throw error;
    return boundary("projection_failed");
  }
}
function validateRequest(input: ExportRequest): ValidatedRequest {
  const value = captureObject(input, REQUEST_KEYS, false, "export_request_invalid");
  if (!("targetSet" in value) || !("updatedFrom" in value) || !("updatedTo" in value) ||
      (value.targetSet !== "eval" && value.targetSet !== "holdout") || typeof value.updatedFrom !== "string" || typeof value.updatedTo !== "string") return boundary("export_request_invalid");
  let updatedFromDate: Date;
  let updatedToDate: Date;
  try { updatedFromDate = parseUtcMillisecond(value.updatedFrom); updatedToDate = parseUtcMillisecond(value.updatedTo); }
  catch { return boundary("export_request_invalid"); }
  if (updatedFromDate.getTime() >= updatedToDate.getTime()) return boundary("export_request_invalid");
  const limit = value.limit === undefined ? DEFAULT_LIMIT : value.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) <= 0) return boundary("export_request_invalid");
  return { targetSet: value.targetSet, updatedFrom: value.updatedFrom, updatedTo: value.updatedTo, updatedFromDate, updatedToDate, limit: limit as number };
}
function captureFunction(value: unknown): (...args: never[]) => unknown {
  if (typeof value !== "function") return boundary("export_request_invalid");
  return value as (...args: never[]) => unknown;
}
function captureDependencies(raw: ExportDependencies): CapturedDependencies {
  const value = captureObject(raw, DEPENDENCY_KEYS, false, "export_request_invalid");
  if (!("repository" in value)) return boundary("export_request_invalid");
  const repository = captureObject(value.repository, ["captureExportSnapshot", "captureReviewSnapshot"], true, "export_request_invalid");
  const capturedRepository: FeedbackLearningRepository = {
    captureExportSnapshot: captureFunction(repository.captureExportSnapshot) as FeedbackLearningRepository["captureExportSnapshot"],
    captureReviewSnapshot: captureFunction(repository.captureReviewSnapshot) as FeedbackLearningRepository["captureReviewSnapshot"],
  };
  if (value.root !== undefined && typeof value.root !== "string") return boundary("export_request_invalid");
  return {
    repository: capturedRepository,
    root: (value.root as string | undefined) ?? DEFAULT_ROOT,
    ensurePrivateTree: (value.ensurePrivateTree === undefined ? defaultEnsurePrivateTree : captureFunction(value.ensurePrivateTree)) as CapturedDependencies["ensurePrivateTree"],
    withCorpusLock: (value.withCorpusLock === undefined ? defaultWithCorpusLock : captureFunction(value.withCorpusLock)) as LockOperation,
    readLedger: (value.readLedger === undefined ? readLedgerSnapshot : captureFunction(value.readLedger)) as CapturedDependencies["readLedger"],
    publishRunAtomically: (value.publishRunAtomically === undefined ? defaultPublishRunAtomically : captureFunction(value.publishRunAtomically)) as CapturedDependencies["publishRunAtomically"],
  };
}
function snapshotLedger(bytes: Uint8Array): EffectiveLedger {
  const folded = foldLedger(parseLedger(Buffer.from(bytes)));
  return jsonParse(canonicalLedgerState(folded)) as EffectiveLedger;
}
function insertionSortApprovals(array: ApprovalEvent[]): void {
  for (let index = 1; index < array.length; index += 1) {
    const value = dataAt(array, index);
    let insertion = index;
    while (insertion > 0 && byteCompare(dataAt(array, insertion - 1).feedbackId, value.feedbackId) > 0) {
      setData(array, insertion, dataAt(array, insertion - 1)); insertion -= 1;
    }
    setData(array, insertion, value);
  }
}
function approvalEvents(ledger: EffectiveLedger): ApprovalEvent[] {
  const approvals: ApprovalEvent[] = [];
  for (let index = 0; index < ledger.activeDecisions.length; index += 1) {
    const event = dataAt(ledger.activeDecisions, index);
    if (event.action === "approve") appendData(approvals, event);
  }
  insertionSortApprovals(approvals);
  return approvals;
}
function captureProjection(value: unknown, keys: readonly string[]): Record<string, unknown> {
  return captureObject(value, keys, true, "projection_failed");
}
function copyFeedbackBoundary(value: unknown): FeedbackProjection {
  return captureProjection(value, FEEDBACK_KEYS) as unknown as FeedbackProjection;
}
function copyJobBoundary(value: unknown): JobProjection {
  return captureProjection(value, JOB_KEYS) as unknown as JobProjection;
}
function captureRows<T>(raw: unknown, copy: (value: unknown) => T, idOf: (value: T) => unknown, requireId: boolean): T[] {
  const values = captureDenseArray(raw);
  const result: T[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const row = copy(dataAt(values, index));
    const id = idOf(row);
    if (requireId && (typeof id !== "string" || id.length === 0)) return boundary("projection_failed");
    if (typeof id === "string" && id.length > 0) {
      if (setHas.call(seen, id)) return boundary("projection_failed");
      setAdd.call(seen, id);
    }
    appendData(result, row);
  }
  return result;
}
function captureDatabaseSnapshot(raw: unknown): DatabaseSnapshot {
  const root = captureProjection(raw, SNAPSHOT_KEYS);
  return {
    feedback: captureRows(root.feedback, copyFeedbackBoundary, (row) => row.id, false),
    jobs: captureRows(root.jobs, copyJobBoundary, (row) => row.id, true),
    currentApprovals: captureRows(root.currentApprovals, copyFeedbackBoundary, (row) => row.id, true),
  };
}
function approvalFreshness(approvals: readonly ApprovalEvent[], current: ReadonlyMap<string, FeedbackProjection | null>): ApprovalFreshnessProjection[] {
  const result: ApprovalFreshnessProjection[] = [];
  for (let index = 0; index < approvals.length; index += 1) {
    const approval = dataAt(approvals, index);
    const row = (mapGet.call(current, approval.feedbackId) as FeedbackProjection | null | undefined) ?? null;
    if (row === null) {
      appendData(result, { feedbackId: approval.feedbackId, present: false, verdict: null, updatedAt: null, snapshotCanonical: null, snapshotSha256: null, staleReason: "missing" });
    } else {
      const snapshotCanonical = canonicalJson(row.snapshot);
      const snapshotSha256 = sha256(snapshotCanonical);
      const freshness = classifyApprovalFreshness(approval, row);
      appendData(result, { feedbackId: approval.feedbackId, present: true, verdict: row.verdict, updatedAt: Date.prototype.toISOString.call(row.updatedAt), snapshotCanonical, snapshotSha256, staleReason: freshness.fresh ? null : freshness.reason });
    }
  }
  return result;
}
function safeCounts(counts: RunCounts): RunCounts {
  return { queried: counts.queried, selected: counts.selected, excluded: counts.excluded, selectedReplayReady: counts.selectedReplayReady, selectedReferenceOnly: counts.selectedReferenceOnly, freshApprovals: counts.freshApprovals, staleReservations: counts.staleReservations };
}
function safePersistence(error: unknown): boolean {
  return isKnownError(error, PersistencePathError) ||
    isKnownError(error, PersistenceInputError) ||
    isKnownError(error, PersistenceIntegrityError);
}
export async function exportFeedbackLearning(input: ExportRequest, rawDependencies: ExportDependencies): Promise<SafeExportResult> {
  const request = validateRequest(input);
  const dependencies = captureDependencies(rawDependencies);
  let paths: PrivatePaths;
  try {
    paths = captureObject(
      await dependencies.ensurePrivateTree.call(undefined, dependencies.root),
      PATH_KEYS,
      true,
      "private_tree_failed",
    ) as unknown as PrivatePaths;
  }
  catch (error) { if (safePersistence(error)) throw error; return boundary("private_tree_failed"); }
  let ledger: EffectiveLedger;
  try {
    ledger = await dependencies.withCorpusLock.call(undefined, paths.lockFile, async () => {
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await dependencies.readLedger.call(undefined, paths)); }
      catch { return boundary("ledger_read_failed"); }
      return snapshotLedger(bytes);
    }) as EffectiveLedger;
  } catch (error) {
    if (isLedgerError(error) || isExportBoundary(error) || safePersistence(error)) throw error;
    return boundary("lock_unavailable");
  }
  const approvals = approvalEvents(ledger);
  const activeApprovalFeedbackIds: string[] = [];
  for (let index = 0; index < approvals.length; index += 1) appendData(activeApprovalFeedbackIds, dataAt(approvals, index).feedbackId);
  let databaseRaw: DatabaseSnapshot;
  try {
    databaseRaw = await dependencies.repository.captureExportSnapshot.call(undefined, {
      updatedFrom: request.updatedFromDate, updatedTo: request.updatedToDate, activeApprovalFeedbackIds,
    });
  } catch { return boundary("database_snapshot_failed"); }
  let artifacts: ReturnType<typeof buildRunArtifacts>;
  try {
    const database = captureDatabaseSnapshot(databaseRaw);
    const jobs = new Map<string, JobProjection>();
    for (let index = 0; index < database.jobs.length; index += 1) {
      const job = dataAt(database.jobs, index);
      mapSet.call(jobs, job.id, job);
    }
    const results: ReturnType<typeof normalizeFeedback>[] = [];
    for (let index = 0; index < database.feedback.length; index += 1) {
      const row = dataAt(database.feedback, index);
      const job = typeof row.jobId === "string" ? (mapGet.call(jobs, row.jobId) as JobProjection | undefined) ?? null : null;
      appendData(results, normalizeFeedback(row, job));
    }
    const foundCurrent = new Map<string, FeedbackProjection>();
    for (let index = 0; index < database.currentApprovals.length; index += 1) {
      const row = dataAt(database.currentApprovals, index);
      mapSet.call(foundCurrent, row.id, row);
    }
    const currentApprovals = new Map<string, FeedbackProjection | null>();
    for (let index = 0; index < approvals.length; index += 1) {
      const id = dataAt(approvals, index).feedbackId;
      mapSet.call(currentApprovals, id, mapHas.call(foundCurrent, id) ? mapGet.call(foundCurrent, id) as FeedbackProjection : null);
    }
    const capacity = buildCapacity(ledger, currentApprovals);
    artifacts = buildRunArtifacts({ results, targetSet: request.targetSet, limit: request.limit, ledger, capacity, updatedFrom: request.updatedFrom, updatedTo: request.updatedTo, approvalFreshness: approvalFreshness(approvals, currentApprovals) });
  } catch (error) {
    if (isExportBoundary(error)) throw error;
    return boundary("projection_failed");
  }
  let manifest: { runId?: unknown; runDigest?: unknown };
  try { manifest = jsonParse(artifacts.files["run.json"].toString("utf8")) as typeof manifest; }
  catch { return boundary("projection_failed"); }
  if (manifest.runId !== artifacts.status.runId || typeof manifest.runDigest !== "string" || !SHA256_PATTERN.test(manifest.runDigest)) return boundary("projection_failed");
  let commit: CommitResult;
  try {
    const rawCommit = await dependencies.publishRunAtomically.call(undefined, { paths, runId: artifacts.status.runId, runDigest: manifest.runDigest as Sha256, files: artifacts.files });
    const capturedCommit = captureObject(rawCommit, ["status"], true, "publish_failed");
    if (capturedCommit.status !== "committed" && capturedCommit.status !== "noop" && capturedCommit.status !== "committed_durability_uncertain" && capturedCommit.status !== "indeterminate") return boundary("publish_failed");
    commit = { status: capturedCommit.status };
  }
  catch (error) { if (safePersistence(error)) throw error; return boundary("publish_failed"); }
  return { operation: "export", runId: artifacts.status.runId, status: commit.status, counts: safeCounts(artifacts.status.counts) };
}
