import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Prisma, type PrismaClient } from "@prisma/client";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import type { Sha256 } from "../feedback-learning/types";
import { appendOutcomeEvent, DEFAULT_OUTCOME_ROOT, ensureOutcomeStore, OutcomeStoreError, readActiveOutcomeLabels, type OutcomeStorePaths } from "./outcome-store";
import { MAX_OUTCOME_MATERIALIZATION_DELAY_MS, MAX_OUTCOME_REVIEW_DELAY_MS, outcomeFreshnessSha256, parseOutcomeCase, parseOutcomeLabel, type OutcomeCase, type OutcomeConfidence, type OutcomeDisposition, type OutcomeExpected, type OutcomeLabel, type OutcomeSet } from "./outcome-types";
import type { BundleFilePayload, CommitResult, FileBackedPayload } from "./store";
import type { Subsystem } from "./types";

const HASH = /^sha256:[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_OUTCOME_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const MAX_OUTCOME_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RECORDED_RESPONSES = 256;
export const MAX_OUTCOME_CASE_BYTES = 1024 * 1024;
const REQUIRED_CASE_FILES = ["case.json", "recorded-responses.jsonl", "source.mp4", "transcript.json"] as const;

export interface RecordedOutcomeResponse {
  readonly promptFingerprint: Sha256;
  readonly modelFingerprint: Sha256;
  readonly requestFingerprint: Sha256;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface OutcomePromotionDecision {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly reviewedAt: string;
  readonly jobId: string;
  readonly jobUpdatedAt: string;
  readonly analyzeStepId: string;
  readonly analyzeStepSha256: Sha256;
  readonly analysisVersion: string;
  readonly engineFingerprint: Sha256;
  readonly configSha256: Sha256;
  readonly transcriptSha256: Sha256;
  readonly sourceSha256: Sha256;
  readonly recordedResponsesSha256: Sha256;
  readonly sourceReview: "complete";
  readonly destination: OutcomeSet;
  readonly disposition: Exclude<OutcomeDisposition, "exclude">;
  readonly confidence: OutcomeConfidence;
  readonly subsystem: Subsystem;
  readonly expected: OutcomeExpected;
  readonly recordedResponses: readonly RecordedOutcomeResponse[];
}

export interface OutcomeJobProjection {
  readonly id: string;
  readonly userId: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly clipsGenerated: number;
  readonly clipCount: number;
  readonly noClipsReason: string | null;
  readonly analysisVersion: string | null;
  readonly transcriptJson: unknown;
  readonly transcriptPartial: boolean;
  readonly sourceDurationSec: number | null;
  readonly sourceArtifactKey: string | null;
  readonly normalizedArtifactKey: string | null;
}

export interface OutcomeAnalyzeStepProjection {
  readonly id: string;
  readonly status: string;
  readonly error: string | null;
  readonly finishedAt: string | null;
  readonly outputJson: unknown;
}

export interface OutcomePromotionSnapshot {
  readonly job: OutcomeJobProjection;
  readonly analyzeStep: OutcomeAnalyzeStepProjection;
}

export interface OutcomePromotionIdentity {
  readonly jobId: string;
  readonly analyzeStepId: string;
}

export interface OutcomeCasePublication {
  readonly root: string;
  readonly caseVersion: Sha256;
  readonly files: Readonly<Record<(typeof REQUIRED_CASE_FILES)[number], BundleFilePayload>>;
  readonly label: OutcomeLabel;
  /** Test-only adversarial hook, after caller-owned payloads have been captured. */
  readonly afterPrepare?: () => void | Promise<void>;
}

export interface OutcomePromotionDependencies {
  readonly repository: { capture(identity: OutcomePromotionIdentity): Promise<OutcomePromotionSnapshot> };
  readonly getObjectSize: (key: string) => Promise<number | null>;
  readonly downloadFile: (key: string, request: { method: "GET" }) => Promise<Uint8Array | Buffer | ReadableStream<Uint8Array>>;
  readonly root?: string;
  readonly publish?: (input: OutcomeCasePublication) => Promise<CommitResult>;
  readonly now?: () => Date;
}

export type OutcomePromotionResult = Readonly<{ status: "promoted"; durability: CommitResult["status"]; caseVersion: Sha256; set: OutcomeSet }>;

export class OutcomePromotionError extends Error {
  constructor(readonly code:
    | "invalid_decision" | "not_zero_output" | "technical_outcome" | "partial_transcript" | "source_limited"
    | "inputs_missing" | "stale_input" | "source_missing" | "source_too_large" | "duplicate_source"
    | "duplicate_event" | "publication_failed" | "database_failed") {
    super(code);
    this.name = "OutcomePromotionError";
  }
}

function fail(code: OutcomePromotionError["code"]): never { throw new OutcomePromotionError(code); }
export function isOutcomeSourceSizeAllowed(size: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && size <= MAX_OUTCOME_SOURCE_BYTES;
}
function hash(value: unknown): value is Sha256 { return typeof value === "string" && HASH.test(value); }
function token(value: unknown): value is string { return typeof value === "string" && TOKEN.test(value); }
function utc(value: unknown): value is string {
  if (typeof value !== "string" || !UTC.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(descriptors);
  return own.length === keys.length && own.every((key) => typeof key === "string" && keys.includes(key) && descriptors[key].enumerable === true && Object.prototype.hasOwnProperty.call(descriptors[key], "value"));
}
function dense(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length === 0 || value.length > maximum) fail("invalid_decision");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) fail("invalid_decision");
  for (let index = 0; index < value.length; index += 1) {
    const item = descriptors[String(index)];
    if (!item || !item.enumerable || !Object.prototype.hasOwnProperty.call(item, "value")) fail("invalid_decision");
  }
  return value;
}

function parseDecision(value: unknown): OutcomePromotionDecision {
  if (!plain(value) || !exact(value, [
    "schemaVersion", "eventId", "reviewedAt", "jobId", "jobUpdatedAt", "analyzeStepId", "analyzeStepSha256",
    "analysisVersion", "engineFingerprint", "configSha256", "transcriptSha256", "sourceSha256",
    "recordedResponsesSha256", "sourceReview", "destination", "disposition", "confidence", "subsystem", "expected", "recordedResponses",
  ])) fail("invalid_decision");
  if (value.schemaVersion !== 1 || !token(value.eventId) || !utc(value.reviewedAt) || !token(value.jobId) || !utc(value.jobUpdatedAt) ||
      !token(value.analyzeStepId) || !hash(value.analyzeStepSha256) || !token(value.analysisVersion) || !hash(value.engineFingerprint) ||
      !hash(value.configSha256) || !hash(value.transcriptSha256) || !hash(value.sourceSha256) || !hash(value.recordedResponsesSha256) ||
      value.sourceReview !== "complete" || (value.destination !== "eval" && value.destination !== "holdout") ||
      (value.disposition !== "recoverable_false_negative" && value.disposition !== "valid_empty") ||
      (value.confidence !== "high" && value.confidence !== "medium") ||
      !["selection", "boundary", "framing", "subtitles", "render"].includes(value.subsystem as string)) fail("invalid_decision");
  let expected: OutcomeExpected;
  try {
    expected = parseOutcomeLabel({ schemaVersion: 1, action: "label", eventId: value.eventId, occurredAt: value.reviewedAt, caseVersion: `sha256:${"0".repeat(64)}`, set: value.destination, disposition: value.disposition, confidence: value.confidence, expected: value.expected }).expected;
  } catch { fail("invalid_decision"); }
  const responses = dense(value.recordedResponses, MAX_RECORDED_RESPONSES).map((entry) => {
    if (!plain(entry) || !exact(entry, ["promptFingerprint", "modelFingerprint", "requestFingerprint", "result"]) ||
        !hash(entry.promptFingerprint) || !hash(entry.modelFingerprint) || !hash(entry.requestFingerprint) || !plain(entry.result)) fail("invalid_decision");
    // Capture now so later getters/prototype changes cannot alter publication.
    try { return JSON.parse(canonicalJson(entry)) as RecordedOutcomeResponse; } catch { return fail("invalid_decision"); }
  });
  return Object.freeze({ ...(JSON.parse(canonicalJson(value)) as OutcomePromotionDecision), expected, recordedResponses: Object.freeze(responses) });
}

export function digestAnalyzeStep(step: OutcomeAnalyzeStepProjection): Sha256 {
  return sha256(canonicalJson({ id: step.id, status: step.status, error: step.error, finishedAt: step.finishedAt, outputJson: step.outputJson }));
}

function asIso(value: unknown): string | null {
  if (value === null) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (utc(value)) return value;
  fail("database_failed");
}
function nullableString(value: unknown): string | null { if (value === null || typeof value === "string") return value; return fail("database_failed"); }
function artifactKey(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) fail("database_failed");
  return value;
}

export function createPrismaOutcomePromotionRepository(client: PrismaClient): OutcomePromotionDependencies["repository"] {
  return Object.freeze({
    async capture(identity: OutcomePromotionIdentity): Promise<OutcomePromotionSnapshot> {
      try {
        return await client.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
          const rawJob = await transaction.job.findUnique({
            where: { id: identity.jobId },
            select: {
              id: true, userId: true, status: true, updatedAt: true, clipsGenerated: true, noClipsReason: true, analysisVersion: true,
              transcriptJson: true, transcriptPartial: true, sourceDurationSec: true, sourceArtifactKey: true, normalizedArtifactKey: true,
              _count: { select: { clips: true } },
            },
          });
          const rawStep = await transaction.jobStep.findUnique({ where: { id: identity.analyzeStepId }, select: { id: true, jobId: true, step: true, status: true, error: true, finishedAt: true, outputJson: true } });
          if (!rawJob || !rawStep || rawStep.jobId !== rawJob.id || rawStep.step !== "ANALYZE") fail("stale_input");
          return Object.freeze({
            job: Object.freeze({
              id: rawJob.id, userId: rawJob.userId, status: rawJob.status, updatedAt: asIso(rawJob.updatedAt)!, clipsGenerated: rawJob.clipsGenerated,
              clipCount: rawJob._count.clips, noClipsReason: nullableString(rawJob.noClipsReason), analysisVersion: nullableString(rawJob.analysisVersion),
              transcriptJson: rawJob.transcriptJson, transcriptPartial: rawJob.transcriptPartial, sourceDurationSec: rawJob.sourceDurationSec,
              sourceArtifactKey: artifactKey(rawJob.sourceArtifactKey), normalizedArtifactKey: artifactKey(rawJob.normalizedArtifactKey),
            }),
            analyzeStep: Object.freeze({ id: rawStep.id, status: rawStep.status, error: nullableString(rawStep.error), finishedAt: asIso(rawStep.finishedAt), outputJson: rawStep.outputJson }),
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 });
      } catch (error) {
        if (error instanceof OutcomePromotionError) throw error;
        fail("database_failed");
      }
    },
  });
}

function recordedResponseBytes(responses: readonly RecordedOutcomeResponse[]): Buffer {
  return Buffer.from(responses.map((entry) => canonicalJson(entry)).join("\n") + "\n");
}

async function spoolSource(body: Uint8Array | Buffer | ReadableStream<Uint8Array>, expectedSize: number, directory: string): Promise<FileBackedPayload> {
  const path = join(directory, "source.mp4");
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, FILE_MODE);
  const digest = createHash("sha256");
  let total = 0;
  const write = async (chunk: Uint8Array): Promise<void> => {
    total += chunk.byteLength;
    if (total > expectedSize || total > MAX_OUTCOME_SOURCE_BYTES) fail("source_too_large");
    digest.update(chunk);
    let offset = 0;
    while (offset < chunk.byteLength) {
      const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
      if (result.bytesWritten <= 0) fail("publication_failed");
      offset += result.bytesWritten;
    }
  };
  try {
    if (body instanceof Uint8Array) await write(body);
    else {
      const reader = body.getReader();
      try { for (;;) { const item = await reader.read(); if (item.done) break; await write(item.value); } }
      finally { reader.releaseLock(); }
    }
    await handle.sync();
  } finally { await handle.close().catch(() => undefined); }
  if (total !== expectedSize || total === 0) fail("source_missing");
  return { path, size: total, sha256: `sha256:${digest.digest("hex")}` };
}

function projectionChecks(value: OutcomePromotionDecision, snapshot: OutcomePromotionSnapshot): void {
  const { job, analyzeStep } = snapshot;
  if (job.status !== "DONE" || analyzeStep.status !== "DONE" || analyzeStep.error !== null || analyzeStep.finishedAt === null) fail("technical_outcome");
  if (job.clipCount !== 0 || job.clipsGenerated !== 0) fail("not_zero_output");
  if (job.transcriptPartial || job.noClipsReason === "PARTIAL_TRANSCRIPT") fail("partial_transcript");
  if (job.noClipsReason === "NO_USABLE_SPEECH") fail("source_limited");
  if (job.noClipsReason !== "NO_VIABLE_MOMENTS") fail("technical_outcome");
  if (!Number.isSafeInteger(job.sourceDurationSec) || (job.sourceDurationSec as number) <= 0 || !job.analysisVersion ||
      !(job.normalizedArtifactKey || job.sourceArtifactKey)) fail("inputs_missing");
  if (!plain(job.transcriptJson) || typeof job.transcriptJson.text !== "string" || !Array.isArray(job.transcriptJson.segments) || job.transcriptJson.segments.length === 0 ||
      job.transcriptJson.segments.some((segment) => !plain(segment) || typeof segment.text !== "string" || typeof segment.start !== "number" || typeof segment.end !== "number" ||
        !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end <= segment.start || segment.end > job.sourceDurationSec!)) fail("inputs_missing");
  if (job.id !== value.jobId || job.updatedAt !== value.jobUpdatedAt || analyzeStep.id !== value.analyzeStepId ||
      digestAnalyzeStep(analyzeStep) !== value.analyzeStepSha256 || job.analysisVersion !== value.analysisVersion) fail("stale_input");
  const reviewedMs = new Date(value.reviewedAt).getTime();
  const updatedMs = new Date(job.updatedAt).getTime();
  if (reviewedMs < updatedMs || reviewedMs - updatedMs > MAX_OUTCOME_REVIEW_DELAY_MS) fail("stale_input");
}

export async function promoteOutcomeCase(rawDecision: unknown, dependencies: OutcomePromotionDependencies): Promise<OutcomePromotionResult> {
  const value = parseDecision(rawDecision);
  const snapshot = await dependencies.repository.capture({ jobId: value.jobId, analyzeStepId: value.analyzeStepId });
  projectionChecks(value, snapshot);
  let transcriptBytes: Buffer;
  try { transcriptBytes = Buffer.from(canonicalJson(snapshot.job.transcriptJson)); } catch { return fail("inputs_missing"); }
  if (sha256(transcriptBytes) !== value.transcriptSha256) fail("stale_input");
  const recordedBytes = recordedResponseBytes(value.recordedResponses);
  if (sha256(recordedBytes) !== value.recordedResponsesSha256) fail("stale_input");
  const sourceKey = (snapshot.job.normalizedArtifactKey || snapshot.job.sourceArtifactKey)!;
  const sourceSize = await dependencies.getObjectSize(sourceKey);
  if (sourceSize === null || !Number.isSafeInteger(sourceSize) || sourceSize <= 0) fail("source_missing");
  if (sourceSize > MAX_OUTCOME_SOURCE_BYTES) fail("source_too_large");
  const spool = await mkdtemp(join(tmpdir(), "clipclap-outcome-source-"));
  await chmod(spool, DIRECTORY_MODE);
  try {
    const source = await spoolSource(await dependencies.downloadFile(sourceKey, { method: "GET" }), sourceSize, spool);
    if (source.sha256 !== value.sourceSha256) fail("stale_input");
    const jobIdentitySha256 = sha256(canonicalJson({ jobId: snapshot.job.id, userId: snapshot.job.userId }));
    const materializedAt = (dependencies.now?.() ?? new Date()).toISOString();
    const materializedMs = new Date(materializedAt).getTime();
    const reviewedMs = new Date(value.reviewedAt).getTime();
    if (!utc(materializedAt) || materializedMs < reviewedMs || materializedMs - reviewedMs > MAX_OUTCOME_MATERIALIZATION_DELAY_MS) fail("stale_input");
    const freshness = {
      jobIdentitySha256,
      jobUpdatedAt: value.jobUpdatedAt,
      reviewedAt: value.reviewedAt,
      materializedAt,
      analyzeStepSha256: value.analyzeStepSha256,
      analysisVersion: value.analysisVersion,
      engineFingerprint: value.engineFingerprint,
      configSha256: value.configSha256,
      transcriptSha256: value.transcriptSha256,
      sourceSha256: value.sourceSha256,
      recordedResponsesSha256: value.recordedResponsesSha256,
    };
    const caseBody = {
      schemaVersion: 1 as const,
      jobIdentitySha256,
      analyzeStepSha256: value.analyzeStepSha256,
      analysisVersion: value.analysisVersion,
      engineFingerprint: value.engineFingerprint,
      configSha256: value.configSha256,
      sourceDurationSec: snapshot.job.sourceDurationSec!,
      transcriptSha256: value.transcriptSha256,
      sourceSha256: value.sourceSha256,
      recordedResponsesSha256: value.recordedResponsesSha256,
      jobUpdatedAt: value.jobUpdatedAt,
      reviewedAt: value.reviewedAt,
      materializedAt,
      freshnessSha256: outcomeFreshnessSha256(freshness),
      set: value.destination,
      disposition: value.disposition,
      confidence: value.confidence,
      subsystem: value.subsystem,
      expected: value.expected,
    };
    const caseVersion = sha256(canonicalJson(caseBody));
    const materialized = parseOutcomeCase({ ...caseBody, caseVersion });
    const label = parseOutcomeLabel({ schemaVersion: 1, action: "label", eventId: value.eventId, occurredAt: materializedAt, caseVersion, set: value.destination, disposition: value.disposition, confidence: value.confidence, expected: value.expected });
    const publication: OutcomeCasePublication = {
      root: dependencies.root ?? DEFAULT_OUTCOME_ROOT,
      caseVersion,
      files: {
        "case.json": Buffer.from(`${canonicalJson(materialized)}\n`),
        "transcript.json": transcriptBytes,
        "source.mp4": source,
        "recorded-responses.jsonl": recordedBytes,
      },
      label,
    };
    let committed: CommitResult;
    try { committed = await (dependencies.publish ?? publishOutcomeCase)(publication); }
    catch (error) {
      if (error instanceof OutcomePromotionError) throw error;
      if (error instanceof OutcomeStoreError && error.code === "duplicate_event") fail("duplicate_event");
      throw error;
    }
    if (committed.status === "indeterminate") fail("publication_failed");
    return Object.freeze({ status: "promoted", durability: committed.status, caseVersion, set: value.destination });
  } finally { await rm(spool, { recursive: true, force: true }).catch(() => undefined); }
}

async function payloadBytes(payload: BundleFilePayload): Promise<Uint8Array> {
  if (payload instanceof Uint8Array) return payload;
  const handle = await open(payload.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || stats.size !== payload.size || (stats.mode & 0o7777) !== FILE_MODE) fail("publication_failed");
    const bytes = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < bytes.length) { const item = await handle.read(bytes, offset, bytes.length - offset, null); if (!item.bytesRead) break; offset += item.bytesRead; }
    if (offset !== bytes.length || sha256(bytes) !== payload.sha256) fail("publication_failed");
    return bytes;
  } finally { await handle.close(); }
}

type PreparedPublicationFiles = Readonly<{
  files: OutcomeCasePublication["files"];
  temporaryRoot?: string;
}>;

async function snapshotFilePayload(payload: FileBackedPayload, destination: string): Promise<FileBackedPayload> {
  const source = await open(payload.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const target = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, FILE_MODE);
  const digest = createHash("sha256");
  try {
    const initial = await source.stat();
    if (!initial.isFile() || initial.nlink !== 1 || initial.size !== payload.size || (initial.mode & 0o7777) !== FILE_MODE) fail("publication_failed");
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, initial.size)));
    let offset = 0;
    while (offset < initial.size) {
      const item = await source.read(chunk, 0, Math.min(chunk.length, initial.size - offset), offset);
      if (item.bytesRead <= 0) fail("publication_failed");
      digest.update(chunk.subarray(0, item.bytesRead));
      let written = 0;
      while (written < item.bytesRead) {
        const result = await target.write(chunk, written, item.bytesRead - written, null);
        if (result.bytesWritten <= 0) fail("publication_failed");
        written += result.bytesWritten;
      }
      offset += item.bytesRead;
    }
    const final = await source.stat();
    if (final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) fail("publication_failed");
    const capturedSha256 = `sha256:${digest.digest("hex")}` as Sha256;
    if (capturedSha256 !== payload.sha256) fail("publication_failed");
    await target.sync();
    return Object.freeze({ path: destination, size: initial.size, sha256: capturedSha256 });
  } finally {
    await Promise.all([source.close().catch(() => undefined), target.close().catch(() => undefined)]);
  }
}

async function preparePublicationFiles(files: OutcomeCasePublication["files"]): Promise<PreparedPublicationFiles> {
  let temporaryRoot: string | undefined;
  const prepared = {} as Record<(typeof REQUIRED_CASE_FILES)[number], BundleFilePayload>;
  try {
    for (const [index, name] of REQUIRED_CASE_FILES.entries()) {
      const payload = files[name];
      if (payload instanceof Uint8Array) prepared[name] = Buffer.from(payload);
      else {
        temporaryRoot ??= await mkdtemp(join(tmpdir(), "clipclap-outcome-publish-"));
        await chmod(temporaryRoot, DIRECTORY_MODE);
        prepared[name] = await snapshotFilePayload(payload, join(temporaryRoot, `${index}.payload`));
      }
    }
    return Object.freeze({ files: Object.freeze(prepared), temporaryRoot });
  } catch (error) {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function readRegularPrivate(path: string, maximumBytes = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1 || (initial.mode & 0o7777) !== FILE_MODE || initial.size > maximumBytes) fail("publication_failed");
    const bytes = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < bytes.length) { const item = await handle.read(bytes, offset, bytes.length - offset, null); if (!item.bytesRead) break; offset += item.bytesRead; }
    const final = await handle.stat();
    if (offset !== bytes.length || final.size !== initial.size || final.ino !== initial.ino) fail("publication_failed");
    return bytes;
  } finally { await handle.close(); }
}

function capturedPayloadSize(payload: BundleFilePayload): number {
  return payload instanceof Uint8Array ? payload.byteLength : payload.size;
}

function capturedPayloadSha256(payload: BundleFilePayload): Sha256 {
  return payload instanceof Uint8Array ? sha256(Buffer.from(payload)) : payload.sha256 as Sha256;
}

async function writeCapturedPayload(handle: Awaited<ReturnType<typeof open>>, payload: BundleFilePayload): Promise<void> {
  if (payload instanceof Uint8Array) {
    await handle.writeFile(payload);
    return;
  }
  const source = await open(payload.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const digest = createHash("sha256");
  try {
    const initial = await source.stat();
    if (!initial.isFile() || initial.nlink !== 1 || initial.size !== payload.size || (initial.mode & 0o7777) !== FILE_MODE) fail("publication_failed");
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, initial.size)));
    let offset = 0;
    while (offset < initial.size) {
      const item = await source.read(chunk, 0, Math.min(chunk.length, initial.size - offset), offset);
      if (item.bytesRead <= 0) fail("publication_failed");
      digest.update(chunk.subarray(0, item.bytesRead));
      let written = 0;
      while (written < item.bytesRead) {
        const result = await handle.write(chunk, written, item.bytesRead - written, null);
        if (result.bytesWritten <= 0) fail("publication_failed");
        written += result.bytesWritten;
      }
      offset += item.bytesRead;
    }
    const final = await source.stat();
    if (final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs ||
        `sha256:${digest.digest("hex")}` !== payload.sha256) fail("publication_failed");
  } finally { await source.close().catch(() => undefined); }
}

async function privateFileDigest(path: string): Promise<Readonly<{ size: number; sha256: Sha256 }>> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const digest = createHash("sha256");
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1 || (initial.mode & 0o7777) !== FILE_MODE) fail("publication_failed");
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, initial.size)));
    let offset = 0;
    while (offset < initial.size) {
      const item = await handle.read(chunk, 0, Math.min(chunk.length, initial.size - offset), offset);
      if (item.bytesRead <= 0) fail("publication_failed");
      digest.update(chunk.subarray(0, item.bytesRead));
      offset += item.bytesRead;
    }
    const final = await handle.stat();
    if (final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) fail("publication_failed");
    return Object.freeze({ size: initial.size, sha256: `sha256:${digest.digest("hex")}` as Sha256 });
  } finally { await handle.close(); }
}

async function readStoredCase(paths: OutcomeStorePaths, caseVersion: Sha256): Promise<OutcomeCase> {
  const bytes = await readRegularPrivate(join(paths.casesDir, caseVersion, "case.json"), MAX_OUTCOME_CASE_BYTES);
  try { return parseOutcomeCase(JSON.parse(Buffer.from(bytes).toString("utf8"))); } catch { return fail("publication_failed"); }
}

async function assertExactExisting(directory: string, files: OutcomeCasePublication["files"]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== REQUIRED_CASE_FILES.length || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !REQUIRED_CASE_FILES.includes(entry.name as never))) fail("publication_failed");
  for (const name of REQUIRED_CASE_FILES) {
    const actual = await privateFileDigest(join(directory, name));
    if (actual.size !== capturedPayloadSize(files[name]) || actual.sha256 !== capturedPayloadSha256(files[name])) fail("publication_failed");
  }
}

async function validatePublication(input: OutcomeCasePublication): Promise<void> {
  let materialized: OutcomeCase;
  try {
    if (capturedPayloadSize(input.files["case.json"]) > MAX_OUTCOME_CASE_BYTES) fail("publication_failed");
    materialized = parseOutcomeCase(JSON.parse(Buffer.from(await payloadBytes(input.files["case.json"])).toString("utf8")));
  } catch { return fail("publication_failed"); }
  const { caseVersion: _caseVersion, ...body } = materialized;
  if (materialized.caseVersion !== input.caseVersion || sha256(canonicalJson(body)) !== input.caseVersion ||
      input.label.caseVersion !== input.caseVersion || materialized.disposition !== input.label.disposition ||
      (materialized.disposition !== "exclude" && materialized.set !== input.label.set) || canonicalJson(materialized.expected) !== canonicalJson(input.label.expected)) fail("publication_failed");
  const expected = {
    "transcript.json": materialized.transcriptSha256,
    "source.mp4": materialized.sourceSha256,
    "recorded-responses.jsonl": materialized.recordedResponsesSha256,
  } as const;
  for (const [name, digest] of Object.entries(expected)) {
    if (capturedPayloadSha256(input.files[name as keyof typeof expected]) !== digest) fail("publication_failed");
  }
}

export async function publishOutcomeCase(input: OutcomeCasePublication): Promise<CommitResult> {
  if (!hash(input.caseVersion) || input.label.caseVersion !== input.caseVersion || Object.keys(input.files).sort().join(",") !== [...REQUIRED_CASE_FILES].sort().join(",")) fail("publication_failed");
  const sourcePayload = input.files["source.mp4"];
  const sourceSize = sourcePayload instanceof Uint8Array ? sourcePayload.byteLength : sourcePayload.size;
  if (Number.isSafeInteger(sourceSize) && sourceSize > MAX_OUTCOME_SOURCE_BYTES) fail("source_too_large");
  if (!isOutcomeSourceSizeAllowed(sourceSize)) fail("publication_failed");
  const prepared = await preparePublicationFiles(input.files);
  try {
    await input.afterPrepare?.();
    const capturedInput: OutcomeCasePublication = { ...input, files: prepared.files, afterPrepare: undefined };
    await validatePublication(capturedInput);
    const paths = await ensureOutcomeStore(input.root);
    const candidateSource = capturedInput.files["source.mp4"] instanceof Uint8Array ? sha256(Buffer.from(capturedInput.files["source.mp4"])) : capturedInput.files["source.mp4"].sha256;
    for (const label of await readActiveOutcomeLabels(input.root)) {
      if (label.eventId === input.label.eventId) fail("duplicate_event");
      if ((await readStoredCase(paths, label.caseVersion)).sourceSha256 === candidateSource) fail("duplicate_source");
    }
    const temporary = join(paths.casesDir, `.tmp-${randomBytes(12).toString("hex")}`);
    let tempCreated = false;
    let caseCommitted = false;
    try {
      try {
        const existing = await lstat(join(paths.casesDir, input.caseVersion));
        if (existing.isSymbolicLink() || !existing.isDirectory() || existing.nlink !== 2 || (existing.mode & 0o7777) !== DIRECTORY_MODE) fail("publication_failed");
        await assertExactExisting(join(paths.casesDir, input.caseVersion), capturedInput.files);
        caseCommitted = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(temporary, { mode: DIRECTORY_MODE });
        tempCreated = true;
        for (const name of REQUIRED_CASE_FILES) {
          const handle = await open(join(temporary, name), constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, FILE_MODE);
          try { await writeCapturedPayload(handle, capturedInput.files[name]); await handle.sync(); } finally { await handle.close(); }
        }
        const directory = await open(temporary, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
        await rename(temporary, join(paths.casesDir, input.caseVersion));
        tempCreated = false;
        const parent = await open(paths.casesDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await parent.sync(); } finally { await parent.close(); }
        caseCommitted = true;
      }
      if (!caseCommitted) fail("publication_failed");
      return await appendOutcomeEvent(input.root, input.label, {
        async validateBeforeCommit(active) {
          for (const label of active) {
            const existing = await readStoredCase(paths, label.caseVersion);
            if (existing.sourceSha256 === candidateSource) fail("duplicate_source");
          }
        },
      });
    } catch (error) {
      if (error instanceof OutcomePromotionError || error instanceof OutcomeStoreError) throw error;
      return fail("publication_failed");
    } finally {
      if (tempCreated) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    if (prepared.temporaryRoot) await rm(prepared.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export type OutcomeValidationReport = Readonly<{ status: "valid" | "invalid"; counts: Readonly<{ eval: number; holdout: number }>; reasons: Readonly<Record<string, number>> }>;

function addReason(reasons: Record<string, number>, code: string): void { reasons[code] = (reasons[code] ?? 0) + 1; }
async function auditPrivateTree(path: string, reasons: Record<string, number>, budget: { remaining: number }): Promise<void> {
  budget.remaining -= 1;
  if (budget.remaining < 0) { addReason(reasons, "store_too_large"); return; }
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()) || (stats.isFile() && stats.nlink !== 1)) { addReason(reasons, "unsafe_path"); return; }
  if ((stats.mode & 0o7777) !== (stats.isDirectory() ? DIRECTORY_MODE : FILE_MODE)) addReason(reasons, "unsafe_mode");
  if (!stats.isDirectory()) return;
  for (const entry of await readdir(path)) await auditPrivateTree(join(path, entry), reasons, budget);
}

async function requireStoreEntry(path: string, kind: "directory" | "file", reasons: Record<string, number>): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) || (kind === "file" && stats.nlink !== 1)) {
      addReason(reasons, "required_entry_type");
    }
  } catch { addReason(reasons, "required_entry_type"); }
}

export async function validateOutcomeStore(root: string, options: Readonly<{ now?: Date }> = {}): Promise<OutcomeValidationReport> {
  const reasons: Record<string, number> = {};
  const counts = { eval: 0, holdout: 0 };
  const validationNow = (options.now ?? new Date()).getTime();
  const paths = { root, ledgerDir: join(root, "ledger"), eventsFile: join(root, "ledger", "outcomes.jsonl"), lockFile: join(root, "ledger", "outcomes.lock"), casesDir: join(root, "cases"), observationsDir: join(root, "observations"), decisionsDir: join(root, "decisions") };
  try {
    await Promise.all([
      requireStoreEntry(root, "directory", reasons),
      requireStoreEntry(paths.ledgerDir, "directory", reasons),
      requireStoreEntry(paths.casesDir, "directory", reasons),
      requireStoreEntry(paths.observationsDir, "directory", reasons),
      requireStoreEntry(paths.decisionsDir, "directory", reasons),
      requireStoreEntry(paths.eventsFile, "file", reasons),
      requireStoreEntry(paths.lockFile, "file", reasons),
    ]);
    await auditPrivateTree(root, reasons, { remaining: 100_000 });
    const rootNames = (await readdir(root)).sort();
    if (rootNames.join(",") !== ["cases", "decisions", "ledger", "observations"].join(",")) addReason(reasons, "unexpected_entry");
    const ledgerNames = (await readdir(paths.ledgerDir)).sort();
    if (ledgerNames.join(",") !== ["outcomes.jsonl", "outcomes.lock"].join(",")) addReason(reasons, "unexpected_entry");
    if (Object.keys(reasons).length > 0) return Object.freeze({ status: "invalid", counts: Object.freeze(counts), reasons: Object.freeze(reasons) });
    const ledger = Buffer.from(await readRegularPrivate(paths.eventsFile)).toString("utf8");
    if (!ledger.endsWith("\n")) addReason(reasons, "invalid_ledger");
    const active = new Map<string, OutcomeLabel>();
    const retired = new Set<string>();
    const seenEventIds = new Set<string>();
    const events = ledger.length === 0 ? [] : ledger.slice(0, -1).split("\n");
    for (const line of events) {
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(line); if (canonicalJson(raw) !== line) throw new Error(); } catch { addReason(reasons, "invalid_ledger"); continue; }
      if (!token(raw.eventId) || seenEventIds.has(raw.eventId)) { addReason(reasons, "invalid_ledger"); continue; }
      seenEventIds.add(raw.eventId);
      if (raw.action === "label") {
        try { const label = parseOutcomeLabel(raw); active.set(label.eventId, label); } catch { addReason(reasons, "invalid_ledger"); }
      } else if (raw.action === "retire" && exact(raw, ["schemaVersion", "action", "eventId", "occurredAt", "targetEventId"]) && raw.schemaVersion === 1 && token(raw.targetEventId) && utc(raw.occurredAt) && active.has(raw.targetEventId) && !retired.has(raw.targetEventId)) retired.add(raw.targetEventId);
      else addReason(reasons, "invalid_ledger");
    }
    const allLabels = [...active.entries()];
    const activeEventIds = new Set(allLabels.filter(([eventId]) => !retired.has(eventId)).map(([eventId]) => eventId));
    const knownCaseVersions = new Set(allLabels.map(([, label]) => label.caseVersion));
    const activeSourceHashes = new Set<Sha256>();
    for (const [eventId, label] of allLabels) {
      try {
        const directory = join(paths.casesDir, label.caseVersion);
        const names = await readdir(directory, { withFileTypes: true });
        if (names.length !== REQUIRED_CASE_FILES.length || names.some((entry) => entry.isSymbolicLink() || !entry.isFile() || !REQUIRED_CASE_FILES.includes(entry.name as never))) { addReason(reasons, "unsafe_path"); continue; }
        const caseBytes = await readRegularPrivate(join(directory, "case.json"), MAX_OUTCOME_CASE_BYTES);
        const [transcriptFile, sourceFile, recordedFile] = await Promise.all([
          privateFileDigest(join(directory, "transcript.json")),
          privateFileDigest(join(directory, "source.mp4")),
          privateFileDigest(join(directory, "recorded-responses.jsonl")),
        ]);
        const parsed = parseOutcomeCase(JSON.parse(Buffer.from(caseBytes).toString("utf8")));
        const { caseVersion: _caseVersion, ...body } = parsed;
        if (parsed.caseVersion !== label.caseVersion || sha256(canonicalJson(body)) !== label.caseVersion ||
            transcriptFile.sha256 !== parsed.transcriptSha256 || sourceFile.sha256 !== parsed.sourceSha256 ||
            recordedFile.sha256 !== parsed.recordedResponsesSha256 || parsed.disposition !== label.disposition ||
            parsed.materializedAt !== label.occurredAt ||
            (!Number.isFinite(validationNow) || new Date(parsed.materializedAt).getTime() > validationNow + MAX_OUTCOME_FUTURE_SKEW_MS) ||
            (parsed.disposition !== "exclude" && parsed.set !== label.set) || canonicalJson(parsed.expected) !== canonicalJson(label.expected)) addReason(reasons, "stale_case");
        else {
          if (activeEventIds.has(eventId)) {
            if (activeSourceHashes.has(parsed.sourceSha256)) addReason(reasons, "duplicate_source");
            activeSourceHashes.add(parsed.sourceSha256);
            counts[label.set!] += 1;
          }
        }
      } catch { addReason(reasons, "missing_or_invalid_case"); }
    }
    const caseEntries = await readdir(paths.casesDir, { withFileTypes: true });
    if (caseEntries.some((entry) => entry.isSymbolicLink() || !entry.isDirectory())) addReason(reasons, "unsafe_path");
    for (const entry of caseEntries) if (entry.isDirectory() && !entry.isSymbolicLink() && !knownCaseVersions.has(entry.name as Sha256)) addReason(reasons, entry.name.startsWith(".tmp-") ? "stale_temp" : "orphan_case");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP" || (error as NodeJS.ErrnoException).code === "ENOTDIR") addReason(reasons, "unsafe_path");
    else addReason(reasons, "missing_store");
  }
  return Object.freeze({ status: Object.keys(reasons).length === 0 ? "valid" : "invalid", counts: Object.freeze(counts), reasons: Object.freeze(reasons) });
}
