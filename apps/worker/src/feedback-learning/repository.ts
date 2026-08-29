import { types as utilTypes } from "node:util";
import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalJson } from "./canonical";
import type { FeedbackProjection, JobProjection } from "./types";

const TRANSACTION_TIMEOUT_MS = 15_000;
const FEEDBACK_KEYS = ["id", "clipId", "jobId", "userId", "verdict", "note", "snapshot", "evidenceKey", "updatedAt"] as const;
const JOB_KEYS = ["id", "transcriptJson", "transcriptPartial"] as const;
const EXPORT_REQUEST_KEYS = ["updatedFrom", "updatedTo", "activeApprovalFeedbackIds"] as const;
const REVIEW_REQUEST_KEYS = ["candidateFeedbackId", "activeApprovalFeedbackIds"] as const;
const FEEDBACK_SELECT = { id: true, clipId: true, jobId: true, userId: true, verdict: true, note: true, snapshot: true, evidenceKey: true, updatedAt: true } as const;
const JOB_SELECT = { id: true, transcriptJson: true, transcriptPartial: true } as const;
const getDescriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const isArray = Array.isArray;
const dateGetTime = Date.prototype.getTime;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const jsonParse = JSON.parse;
const INVALID_SEMANTIC_VALUE = Object.freeze(Object.create(null)) as unknown;

export type SnapshotRequest = Readonly<{ updatedFrom: Date; updatedTo: Date; activeApprovalFeedbackIds: readonly string[] }>;
export type ReviewSnapshotRequest = Readonly<{ candidateFeedbackId: string; activeApprovalFeedbackIds: readonly string[] }>;
export type DatabaseSnapshot = Readonly<{ feedback: readonly FeedbackProjection[]; jobs: readonly JobProjection[]; currentApprovals: readonly FeedbackProjection[] }>;
export type ReviewDatabaseSnapshot = Readonly<{ candidate: FeedbackProjection | null; currentApprovals: readonly FeedbackProjection[] }>;
export interface FeedbackLearningRepository {
  captureExportSnapshot(input: SnapshotRequest): Promise<DatabaseSnapshot>;
  captureReviewSnapshot(input: ReviewSnapshotRequest): Promise<ReviewDatabaseSnapshot>;
}

function invalidRequest(): never { throw new TypeError("snapshot_request_invalid"); }
function invalidProjection(): never { throw new TypeError("snapshot_projection_invalid"); }
function appendData<T>(array: T[], value: T): void {
  Object.defineProperty(array, String(array.length), { configurable: true, enumerable: true, value, writable: true });
}
function dataAt<T>(array: readonly T[], index: number, request = false): T {
  const descriptor = getDescriptor(array, String(index));
  if (descriptor === undefined || !("value" in descriptor)) return request ? invalidRequest() : invalidProjection();
  return descriptor.value as T;
}
function setData<T>(array: T[], index: number, value: T): void {
  Object.defineProperty(array, String(index), { configurable: true, enumerable: true, value, writable: true });
}
function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function insertionSort(array: string[]): void {
  for (let index = 1; index < array.length; index += 1) {
    const value = dataAt(array, index, true);
    let insertion = index;
    while (insertion > 0 && byteCompare(dataAt(array, insertion - 1, true), value) > 0) {
      setData(array, insertion, dataAt(array, insertion - 1, true));
      insertion -= 1;
    }
    setData(array, insertion, value);
  }
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
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isWellFormedUnicode(value);
}
function contains(expected: readonly string[], key: string): boolean {
  for (let index = 0; index < expected.length; index += 1) if (dataAt(expected, index) === key) return true;
  return false;
}
function captureOwnData(value: unknown, expected: readonly string[], request: boolean): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || isArray(value)) return request ? invalidRequest() : invalidProjection();
    const prototype = getPrototype(value);
    if (prototype !== Object.prototype && prototype !== null) return request ? invalidRequest() : invalidProjection();
    const keys = ownKeys(value);
    if (keys.length !== expected.length) return request ? invalidRequest() : invalidProjection();
    const captured: Record<string, unknown> = Object.create(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = dataAt(keys, index, request);
      if (typeof key !== "string" || !contains(expected, key)) return request ? invalidRequest() : invalidProjection();
      const descriptor = getDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return request ? invalidRequest() : invalidProjection();
      Object.defineProperty(captured, key, { configurable: true, enumerable: true, value: descriptor.value, writable: true });
    }
    return captured;
  } catch (error) {
    if (error instanceof TypeError && (error.message === "snapshot_request_invalid" || error.message === "snapshot_projection_invalid")) throw error;
    return request ? invalidRequest() : invalidProjection();
  }
}
function captureDenseArray(value: unknown, request: boolean): unknown[] {
  try {
    if (!isArray(value) || utilTypes.isProxy(value) || getPrototype(value) !== Array.prototype) return request ? invalidRequest() : invalidProjection();
    const lengthDescriptor = getDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return request ? invalidRequest() : invalidProjection();
    const length = lengthDescriptor.value as number;
    const keys = ownKeys(value);
    if (keys.length !== length + 1) return request ? invalidRequest() : invalidProjection();
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (dataAt(keys, index, request) !== String(index)) return request ? invalidRequest() : invalidProjection();
      const descriptor = getDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return request ? invalidRequest() : invalidProjection();
      appendData(result, descriptor.value);
    }
    if (dataAt(keys, length, request) !== "length") return request ? invalidRequest() : invalidProjection();
    return result;
  } catch (error) {
    if (error instanceof TypeError && (error.message === "snapshot_request_invalid" || error.message === "snapshot_projection_invalid")) throw error;
    return request ? invalidRequest() : invalidProjection();
  }
}
function capturedDate(value: unknown, request: boolean): Date {
  try {
    const milliseconds = dateGetTime.call(value);
    if (!Number.isFinite(milliseconds)) return request ? invalidRequest() : invalidProjection();
    return new Date(milliseconds);
  } catch { return request ? invalidRequest() : invalidProjection(); }
}
function sortedUniqueIds(raw: unknown, request: boolean): string[] {
  const values = captureDenseArray(raw, request);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const id = dataAt(values, index, request);
    if (!isNonEmptyString(id)) return request ? invalidRequest() : invalidProjection();
    if (setHas.call(seen, id)) {
      if (request) continue;
      return invalidProjection();
    }
    setAdd.call(seen, id);
    appendData(ids, id);
  }
  insertionSort(ids);
  return ids;
}
function copyJson(value: unknown): unknown {
  try { return jsonParse(canonicalJson(value)) as unknown; } catch { return invalidProjection(); }
}
function captureFeedback(value: unknown): FeedbackProjection {
  const row = captureOwnData(value, FEEDBACK_KEYS, false);
  if (!isNonEmptyString(row.id) || !isNonEmptyString(row.clipId) || !isNonEmptyString(row.jobId) || !isNonEmptyString(row.userId) ||
      typeof row.verdict !== "string" || !isWellFormedUnicode(row.verdict) ||
      (row.note !== null && (typeof row.note !== "string" || !isWellFormedUnicode(row.note))) ||
      (row.evidenceKey !== null && (typeof row.evidenceKey !== "string" || !isWellFormedUnicode(row.evidenceKey)))) return invalidProjection();
  return { id: row.id, clipId: row.clipId, jobId: row.jobId, userId: row.userId, verdict: row.verdict,
    note: row.note as string | null, snapshot: copyJson(row.snapshot), evidenceKey: row.evidenceKey as string | null,
    updatedAt: capturedDate(row.updatedAt, false) };
}
function safeCohortValue(value: unknown): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  return INVALID_SEMANTIC_VALUE;
}
function safeCohortDate(value: unknown): unknown {
  try { return capturedDate(value, false); } catch { return null; }
}
function safeCohortJson(value: unknown): unknown {
  try { return copyJson(value); } catch { return undefined; }
}
function captureCohortFeedback(value: unknown): FeedbackProjection {
  const row = captureOwnData(value, FEEDBACK_KEYS, false);
  return {
    id: safeCohortValue(row.id),
    clipId: safeCohortValue(row.clipId),
    jobId: safeCohortValue(row.jobId),
    userId: safeCohortValue(row.userId),
    verdict: safeCohortValue(row.verdict),
    note: safeCohortValue(row.note),
    snapshot: safeCohortJson(row.snapshot),
    evidenceKey: safeCohortValue(row.evidenceKey),
    updatedAt: safeCohortDate(row.updatedAt),
  } as unknown as FeedbackProjection;
}
function captureJob(value: unknown): JobProjection {
  const row = captureOwnData(value, JOB_KEYS, false);
  if (!isNonEmptyString(row.id) || typeof row.transcriptPartial !== "boolean") return invalidProjection();
  return { id: row.id, transcriptJson: copyJson(row.transcriptJson), transcriptPartial: row.transcriptPartial };
}
function captureRows<T>(raw: unknown, capture: (value: unknown) => T, idOf: (value: T) => unknown, requireId = true): T[] {
  const values = captureDenseArray(raw, false);
  const seen = new Set<string>();
  const result: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const item = capture(dataAt(values, index));
    const id = idOf(item);
    if (requireId && !isNonEmptyString(id)) return invalidProjection();
    if (isNonEmptyString(id)) {
      if (setHas.call(seen, id)) return invalidProjection();
      setAdd.call(seen, id);
    }
    appendData(result, item);
  }
  return result;
}
function transactionOptions() { return { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: TRANSACTION_TIMEOUT_MS } as const; }

export function createPrismaFeedbackLearningRepository(client: PrismaClient): FeedbackLearningRepository {
  return Object.freeze({
    async captureExportSnapshot(input: SnapshotRequest): Promise<DatabaseSnapshot> {
      const request = captureOwnData(input, EXPORT_REQUEST_KEYS, true);
      const updatedFrom = capturedDate(request.updatedFrom, true);
      const updatedTo = capturedDate(request.updatedTo, true);
      if (dateGetTime.call(updatedFrom) >= dateGetTime.call(updatedTo)) return invalidRequest();
      const approvalIds = sortedUniqueIds(request.activeApprovalFeedbackIds, true);
      return client.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        const feedback = captureRows(await transaction.clipFeedback.findMany({ where: { verdict: "AS_IS", updatedAt: { gte: updatedFrom, lt: updatedTo } }, select: FEEDBACK_SELECT, orderBy: [{ updatedAt: "asc" }, { id: "asc" }] }), captureCohortFeedback, (row) => row.id, false);
        const jobIds: string[] = [];
        for (let index = 0; index < feedback.length; index += 1) {
          const jobId = dataAt(feedback, index).jobId;
          if (isNonEmptyString(jobId)) appendData(jobIds, jobId);
        }
        const jobs = captureRows(await transaction.job.findMany({ where: { id: { in: sortedUniqueIds(jobIds, true) } }, select: JOB_SELECT, orderBy: { id: "asc" } }), captureJob, (row) => row.id);
        const currentApprovals = captureRows(await transaction.clipFeedback.findMany({ where: { id: { in: approvalIds } }, select: FEEDBACK_SELECT, orderBy: { id: "asc" } }), captureFeedback, (row) => row.id);
        return { feedback, jobs, currentApprovals };
      }, transactionOptions());
    },
    async captureReviewSnapshot(input: ReviewSnapshotRequest): Promise<ReviewDatabaseSnapshot> {
      const request = captureOwnData(input, REVIEW_REQUEST_KEYS, true);
      if (!isNonEmptyString(request.candidateFeedbackId)) return invalidRequest();
      const approvalIds = sortedUniqueIds(request.activeApprovalFeedbackIds, true);
      const candidateFeedbackId = request.candidateFeedbackId;
      return client.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        const rawCandidate = await transaction.clipFeedback.findUnique({ where: { id: candidateFeedbackId }, select: FEEDBACK_SELECT });
        const currentApprovals = captureRows(await transaction.clipFeedback.findMany({ where: { id: { in: approvalIds } }, select: FEEDBACK_SELECT, orderBy: { id: "asc" } }), captureFeedback, (row) => row.id);
        return { candidate: rawCandidate === null ? null : captureFeedback(rawCandidate), currentApprovals };
      }, transactionOptions());
    },
  });
}
