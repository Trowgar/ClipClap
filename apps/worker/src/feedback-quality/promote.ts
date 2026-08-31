import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { appendLabelEvent, DEFAULT_QUALITY_ROOT, publishCaseAndLabel, qualityDestination, qualityRetirementTarget, type BundleFilePayload, type CommitResult, type FileBackedPayload } from "./store";
import type { FeedbackProjection } from "../feedback-learning/types";
import type { TargetSet, Subsystem } from "./types";

export type ContentHash = `sha256:${string}`;
export type PromotionCause = "reproducible" | "subjective" | "source" | "missing_evidence";
export type EvidenceStatus = "permanent" | "missing";

// Immutable ingestion ceilings: enough for normal review artifacts, bounded
// before any body is copied into memory.
export const MAX_EVIDENCE_BYTES = 256 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const SPOOL_FILE_MODE = 0o600;

export interface V1ApprovalIdentity {
  eventId: string;
  feedbackId: string;
  clipId: string;
  jobId: string;
  userId: string;
  feedbackUpdatedAt: string;
  snapshotSha256: ContentHash;
  candidateVersion: ContentHash;
  destination: TargetSet;
}

export interface PromotionExpected {
  approvedMoment: boolean;
  completeBoundary: boolean;
  sourceWindow?: { start: number; end: number; forbidden?: readonly { start: number; end: number }[] };
  referenceOnly?: boolean;
  focalCoverage?: boolean;
  subtitleCoverage?: boolean;
}

export interface PromotionDecision {
  schemaVersion: 1;
  eventId: string;
  feedbackId: string;
  feedbackUpdatedAt: string;
  snapshotSha256: ContentHash;
  candidateVersion: ContentHash;
  clipId: string;
  jobId: string;
  userId: string;
  verdict: "AS_IS" | "EDIT" | "NO";
  disposition: "positive" | "confirmed_negative" | "exclude";
  set: TargetSet;
  subsystem: Subsystem;
  confidence: "high" | "medium";
  engineCause: PromotionCause;
  evidence: EvidenceStatus;
  expected: PromotionExpected;
}

export interface QualityClipProjection {
  id: string; jobId: string; storageKey: string; duration: number; startTime: number; endTime: number;
  title: string; subtitleTrack: unknown; cropPlan: unknown; language: string | null; clipKind: string | null;
  hookStart: number | null; hookEnd: number | null; payoffAt: number | null;
}

export interface QualityJobProjection {
  id: string; userId: string; transcriptJson: unknown; transcriptPartial: boolean;
  sourceKey: string | null; sourceArtifactKey: string | null; normalizedArtifactKey: string | null; sourceDurationSec: number | null;
}

export interface PromotionSnapshot {
  feedback: FeedbackProjection;
  clip: QualityClipProjection;
  job: QualityJobProjection;
}

export interface PromotionIdentity {
  feedbackId: string;
  clipId: string;
  jobId: string;
  userId: string;
  feedbackUpdatedAt: string;
  snapshotSha256: ContentHash;
  candidateVersion: ContentHash;
  destination: TargetSet;
}

export interface MaterializedCase {
  schemaVersion: 1;
  caseVersion: string;
  feedbackId: string;
  clipId: string;
  jobId: string;
  userId: string;
  feedbackUpdatedAt: string;
  snapshotSha256: ContentHash;
  candidateVersion: ContentHash;
  set: TargetSet;
  disposition: PromotionDecision["disposition"];
  verdict: PromotionDecision["verdict"];
  subsystem: Subsystem;
  confidence: PromotionDecision["confidence"];
  expected: PromotionExpected;
  inputs: {
    transcriptSha256: ContentHash | null;
    evidenceSha256: ContentHash;
    sourceSha256: ContentHash | null;
    sourceDurationSec: number | null;
  };
}

export interface PromotionPublishInput {
  files: Readonly<Record<string, BundleFilePayload>>;
  label: { eventId: string; [key: string]: unknown };
}

export interface PromotionDependencies {
  repository: { capture(input: PromotionIdentity): Promise<PromotionSnapshot> };
  root?: string;
  publishCaseAndLabel?: (input: PromotionPublishInput, root: string, beforeLabel?: () => Promise<void>) => Promise<CommitResult>;
  appendLabelEvent?: typeof appendLabelEvent;
  downloadFile: (key: string, request: { method: "GET" }) => Promise<Uint8Array | Buffer | ReadableStream<Uint8Array>>;
  /** Read-only HEAD metadata; production rejects unknown/oversized objects before GET. */
  getObjectSize?: (key: string) => Promise<number | null>;
  /** V1 reviews.lock wrapper. Positive authority must remain held through V2 publication. */
  withV1AuthorityLock?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Read-only projection of the existing V1 approval ledger. */
  resolveV1Approval?: (identity: PromotionIdentity) => Promise<V1ApprovalIdentity | null>;
  /** Runs while the quality-store lock is held, before label append. */
  qualityDestinationGuard?: (feedbackId: string, destination: TargetSet) => Promise<void>;
  /** Optional early rejection only; the locked guard remains mandatory. */
  qualityDestinationPreflight?: (feedbackId: string, destination: TargetSet) => Promise<void>;
  eventId?: () => string;
  now?: () => Date;
}

export type PromotionResult = Readonly<{ status: CommitResult["status"] | "excluded"; eventId: string; caseVersion?: string }>;

export class QualityPromotionError extends Error {
  constructor(readonly code: "invalid_decision" | "identity_mismatch" | "approval_missing" | "inputs_missing" | "evidence_missing" | "artifact_too_large" | "unsupported_label" | "publication_failed") {
    super(code);
    this.name = "QualityPromotionError";
  }
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const UUIDISH = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUBSYSTEMS: readonly Subsystem[] = ["selection", "boundary", "framing", "subtitles", "render"];
const TOP_KEYS = ["schemaVersion", "eventId", "feedbackId", "clipId", "jobId", "userId", "feedbackUpdatedAt", "snapshotSha256", "candidateVersion", "verdict", "disposition", "set", "subsystem", "confidence", "engineCause", "evidence", "expected"];
const EXPECTED_KEYS = ["approvedMoment", "completeBoundary", "sourceWindow", "referenceOnly", "focalCoverage", "subtitleCoverage"];

function ownKeys(value: object, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key));
}
function hash(value: unknown): value is ContentHash { return typeof value === "string" && HASH.test(value); }
function nonempty(value: unknown): value is string { return typeof value === "string" && UUIDISH.test(value); }
function validDate(value: unknown): value is string { if (typeof value !== "string") return false; const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value; }
function object(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new QualityPromotionError("invalid_decision"); return value as Record<string, unknown>; }
function expected(value: unknown): PromotionExpected {
  const raw = object(value);
  if (!ownKeys(raw, EXPECTED_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(raw, key) || key === "approvedMoment" || key === "completeBoundary")) ||
      typeof raw.approvedMoment !== "boolean" || typeof raw.completeBoundary !== "boolean") throw new QualityPromotionError("invalid_decision");
  if (raw.sourceWindow !== undefined) {
    const window = object(raw.sourceWindow);
    if (Object.keys(window).some((key) => !["start", "end", "forbidden"].includes(key)) || typeof window.start !== "number" || typeof window.end !== "number" || !Number.isFinite(window.start) || !Number.isFinite(window.end) || window.start < 0 || window.end <= window.start) throw new QualityPromotionError("invalid_decision");
    if (window.forbidden !== undefined) {
      if (!Array.isArray(window.forbidden) || window.forbidden.some((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return true;
        const item = entry as Record<string, unknown>;
        return Object.keys(item).some((key) => key !== "start" && key !== "end") || typeof item.start !== "number" || typeof item.end !== "number" || !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start;
      })) throw new QualityPromotionError("invalid_decision");
    }
  }
  return raw as unknown as PromotionExpected;
}
function validateDecision(raw: PromotionDecision): PromotionDecision {
  const value = object(raw);
  if (!ownKeys(value, TOP_KEYS) || value.schemaVersion !== 1 || !nonempty(value.eventId) || !nonempty(value.feedbackId) || !nonempty(value.clipId) || !nonempty(value.jobId) || !nonempty(value.userId) || !validDate(value.feedbackUpdatedAt) ||
      !hash(value.snapshotSha256) || !hash(value.candidateVersion) || !["AS_IS", "EDIT", "NO"].includes(value.verdict as string) ||
      !["positive", "confirmed_negative", "exclude"].includes(value.disposition as string) || !["eval", "holdout"].includes(value.set as string) ||
      !SUBSYSTEMS.includes(value.subsystem as Subsystem) || !["high", "medium"].includes(value.confidence as string) ||
      !["reproducible", "subjective", "source", "missing_evidence"].includes(value.engineCause as string) || !["permanent", "missing"].includes(value.evidence as string)) throw new QualityPromotionError("invalid_decision");
  expected(value.expected);
  return value as unknown as PromotionDecision;
}
function validateApproval(raw: unknown): V1ApprovalIdentity {
  const value = object(raw);
  if (!ownKeys(value, ["eventId", "feedbackId", "clipId", "jobId", "userId", "feedbackUpdatedAt", "snapshotSha256", "candidateVersion", "destination"]) || !nonempty(value.eventId) || !nonempty(value.feedbackId) || !nonempty(value.clipId) || !nonempty(value.jobId) || !nonempty(value.userId) || !validDate(value.feedbackUpdatedAt) || !hash(value.snapshotSha256) || !hash(value.candidateVersion) || !["eval", "holdout"].includes(value.destination as string)) throw new QualityPromotionError("invalid_decision");
  return value as unknown as V1ApprovalIdentity;
}
function assertClassification(value: PromotionDecision, snapshot: PromotionSnapshot): void {
  if (value.disposition === "positive") {
    if (value.verdict !== "AS_IS" || value.engineCause !== "reproducible" || value.evidence !== "permanent") throw new QualityPromotionError("unsupported_label");
  } else if (value.disposition === "confirmed_negative") {
    if ((value.verdict !== "EDIT" && value.verdict !== "NO") || value.engineCause !== "reproducible" || value.evidence !== "permanent") throw new QualityPromotionError("unsupported_label");
  } else if (value.engineCause === "reproducible") {
    throw new QualityPromotionError("unsupported_label");
  }
  if (snapshot.feedback.verdict !== value.verdict) throw new QualityPromotionError("identity_mismatch");
}
function assertSnapshotIdentity(value: PromotionDecision, snapshot: PromotionSnapshot): void {
  let currentUpdatedAt: string;
  try { currentUpdatedAt = snapshot.feedback.updatedAt.toISOString(); } catch { throw new QualityPromotionError("identity_mismatch"); }
  if (snapshot.feedback.id !== value.feedbackId || snapshot.feedback.clipId !== value.clipId || snapshot.feedback.jobId !== value.jobId || snapshot.feedback.userId !== value.userId ||
      snapshot.clip.id !== value.clipId || snapshot.clip.jobId !== value.jobId || snapshot.job.id !== value.jobId || snapshot.job.userId !== value.userId || currentUpdatedAt !== value.feedbackUpdatedAt ||
      sha256(canonicalJson(snapshot.feedback.snapshot)) !== value.snapshotSha256 ||
      sha256(`${value.feedbackId}\n${value.feedbackUpdatedAt}\n${value.snapshotSha256}`) !== value.candidateVersion) {
    throw new QualityPromotionError("identity_mismatch");
  }
}
function assertInputs(value: PromotionDecision, snapshot: PromotionSnapshot): void {
  if (value.subsystem === "selection" || value.subsystem === "boundary") {
    const transcript = snapshot.job.transcriptJson;
    if (transcript === null || transcript === undefined || typeof transcript !== "object" || Array.isArray(transcript) ||
        !Array.isArray((transcript as { segments?: unknown }).segments) || snapshot.job.transcriptPartial || snapshot.job.sourceDurationSec === null || !value.expected.sourceWindow) throw new QualityPromotionError("inputs_missing");
  } else if (!value.expected.referenceOnly && !snapshot.job.sourceArtifactKey && !snapshot.job.normalizedArtifactKey) {
    throw new QualityPromotionError("inputs_missing");
  }
  if (!snapshot.feedback.evidenceKey || value.evidence !== "permanent") throw new QualityPromotionError("evidence_missing");
}
type SpoolArtifact = FileBackedPayload;

async function writeAt(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array, position: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (result.bytesWritten <= 0) throw new QualityPromotionError("publication_failed");
    offset += result.bytesWritten;
  }
}

async function spoolArtifact(value: Uint8Array | Buffer | ReadableStream<Uint8Array>, cap: number, spoolDir: string): Promise<SpoolArtifact> {
  const path = join(spoolDir, `${randomBytes(16).toString("hex")}.part`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let complete = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, SPOOL_FILE_MODE);
    await handle.chmod(SPOOL_FILE_MODE);
    const digest = createHash("sha256");
    let size = 0;
    const append = async (chunk: Uint8Array): Promise<void> => {
      size += chunk.byteLength;
      if (!Number.isSafeInteger(size) || size > cap) throw new QualityPromotionError("artifact_too_large");
      digest.update(Buffer.from(chunk));
      await writeAt(handle!, chunk, size - chunk.byteLength);
    };
    if (value instanceof Buffer || value instanceof Uint8Array) {
      if (value.byteLength > cap) throw new QualityPromotionError("artifact_too_large");
      await append(value);
    } else {
      reader = value.getReader();
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        if (!(item.value instanceof Uint8Array)) throw new QualityPromotionError("inputs_missing");
        try { await append(item.value); }
        catch (error) {
          if (!cancelled) { cancelled = true; await reader.cancel().catch(() => undefined); }
          throw error;
        }
      }
    }
    await handle.sync();
    const stats = await handle.stat();
    const hash = `sha256:${digest.digest("hex")}` as `sha256:${string}`;
    if (!stats.isFile() || stats.nlink !== 1 || (stats.mode & 0o7777) !== SPOOL_FILE_MODE || stats.size !== size) throw new QualityPromotionError("publication_failed");
    complete = true;
    return { path, size, sha256: hash };
  } finally {
    reader?.releaseLock();
    try { await handle?.close(); } catch { /* cleanup below */ }
    if (!complete) await rm(path, { force: true }).catch(() => undefined);
  }
}

async function downloadBounded(dependencies: PromotionDependencies, key: string, cap: number, spoolDir: string): Promise<SpoolArtifact> {
  if (dependencies.getObjectSize) {
    const size = await dependencies.getObjectSize(key);
    if (size === null || !Number.isSafeInteger(size) || size < 0 || size > cap) throw new QualityPromotionError("artifact_too_large");
  }
  return spoolArtifact(await dependencies.downloadFile(key, { method: "GET" }), cap, spoolDir);
}
function nowIso(dependencies: PromotionDependencies): string { const date = dependencies.now?.() ?? new Date(); const value = date.toISOString(); if (!validDate(value)) throw new QualityPromotionError("publication_failed"); return value; }

export async function promoteFeedbackCase(rawDecision: PromotionDecision, dependencies: PromotionDependencies): Promise<PromotionResult> {
  const value = validateDecision(rawDecision);
  const root = dependencies.root ?? DEFAULT_QUALITY_ROOT;
  const destinationGuard = dependencies.qualityDestinationGuard ?? (async () => {
    const current = await qualityDestination(root, value.feedbackId);
    if (current !== null && current !== value.set) throw new QualityPromotionError("identity_mismatch");
  });
  const identity: PromotionIdentity = { feedbackId: value.feedbackId, clipId: value.clipId, jobId: value.jobId, userId: value.userId, feedbackUpdatedAt: value.feedbackUpdatedAt, snapshotSha256: value.snapshotSha256, candidateVersion: value.candidateVersion, destination: value.set };
  const snapshot = await dependencies.repository.capture(identity);
  assertSnapshotIdentity(value, snapshot);
  const publishUnderAuthority = async (): Promise<PromotionResult> => {
    // Lock order is always V1 reviews.lock -> V2 labels.lock. The authority
    // read and the guarded V2 append stay in this same critical section.
    if (value.disposition === "positive") {
      const approval = await dependencies.resolveV1Approval?.(identity);
      if (!approval) throw new QualityPromotionError("approval_missing");
      validateApproval(approval);
      if (approval.feedbackId !== identity.feedbackId || approval.clipId !== identity.clipId || approval.jobId !== identity.jobId || approval.userId !== identity.userId || approval.feedbackUpdatedAt !== identity.feedbackUpdatedAt || approval.snapshotSha256 !== identity.snapshotSha256 || approval.candidateVersion !== identity.candidateVersion || approval.destination !== identity.destination) throw new QualityPromotionError("identity_mismatch");
    }
    await dependencies.qualityDestinationPreflight?.(value.feedbackId, value.set);
    if (value.disposition === "exclude") {
      if (snapshot.feedback.verdict !== value.verdict) throw new QualityPromotionError("identity_mismatch");
      const append = dependencies.appendLabelEvent ?? appendLabelEvent;
      const result = await append({ schemaVersion: 1, eventId: value.eventId, action: "label", occurredAt: nowIso(dependencies), feedbackId: value.feedbackId, feedbackUpdatedAt: value.feedbackUpdatedAt, snapshotSha256: value.snapshotSha256, candidateVersion: value.candidateVersion, set: value.set, disposition: "exclude", verdict: value.verdict, subsystem: value.subsystem, confidence: value.confidence, reason: value.engineCause }, root, { beforeCommit: () => destinationGuard(value.feedbackId, value.set) });
      return { status: result.status === "indeterminate" ? "indeterminate" : "excluded", eventId: value.eventId };
    }
    assertClassification(value, snapshot);
    assertInputs(value, snapshot);
    const spoolDir = await mkdtemp(join(tmpdir(), "clipclap-quality-spool-"));
    try {
      await chmod(spoolDir, 0o700);
      const evidence = await downloadBounded(dependencies, snapshot.feedback.evidenceKey!, MAX_EVIDENCE_BYTES, spoolDir);
      if (evidence.size === 0) throw new QualityPromotionError("evidence_missing");
      const needsTranscript = value.subsystem === "selection" || value.subsystem === "boundary";
      const transcript = needsTranscript ? Buffer.from(canonicalJson(snapshot.job.transcriptJson)) : null;
      const sourceKey = !needsTranscript && !value.expected.referenceOnly ? (snapshot.job.normalizedArtifactKey ?? snapshot.job.sourceArtifactKey) : null;
      const source = sourceKey ? await downloadBounded(dependencies, sourceKey, MAX_SOURCE_BYTES, spoolDir) : null;
      if (sourceKey && (!source || source.size === 0)) throw new QualityPromotionError("inputs_missing");
      const inputs = { transcriptSha256: transcript ? sha256(transcript) : null, evidenceSha256: evidence.sha256, sourceSha256: source ? source.sha256 : null, sourceDurationSec: snapshot.job.sourceDurationSec };
      const caseBody = { schemaVersion: 1 as const, feedbackId: value.feedbackId, clipId: value.clipId, jobId: value.jobId, userId: value.userId, feedbackUpdatedAt: value.feedbackUpdatedAt, snapshotSha256: value.snapshotSha256, candidateVersion: value.candidateVersion, set: value.set, disposition: value.disposition, verdict: value.verdict, subsystem: value.subsystem, confidence: value.confidence, expected: value.expected, inputs };
      const caseVersion = `case:${sha256(canonicalJson(caseBody))}`;
      const materialized: MaterializedCase = { ...caseBody, caseVersion };
      const label = { schemaVersion: 1, eventId: value.eventId, action: "label", occurredAt: nowIso(dependencies), feedbackId: value.feedbackId, feedbackUpdatedAt: value.feedbackUpdatedAt, snapshotSha256: value.snapshotSha256, candidateVersion: value.candidateVersion, caseVersion, set: value.set, disposition: value.disposition, verdict: value.verdict, subsystem: value.subsystem, confidence: value.confidence, expected: value.expected };
      const publish = dependencies.publishCaseAndLabel ?? ((input, root, beforeLabel) => publishCaseAndLabel({ kind: "case", id: caseVersion, files: input.files }, input.label, root, beforeLabel));
      const files: Record<string, BundleFilePayload> = { "case.json": Buffer.from(`${canonicalJson(materialized)}\n`), "source-or-evidence.mp4": source ?? evidence };
      if (transcript) files["transcript.json"] = new Uint8Array(transcript);
      const result = await publish({ files, label }, root, () => destinationGuard(value.feedbackId, value.set));
      if (result.status === "indeterminate") throw new QualityPromotionError("publication_failed");
      return { status: result.status, eventId: value.eventId, caseVersion };
    } finally {
      await rm(spoolDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  if (value.disposition === "positive") {
    if (!dependencies.withV1AuthorityLock) throw new QualityPromotionError("approval_missing");
    return dependencies.withV1AuthorityLock(publishUnderAuthority);
  }
  return publishUnderAuthority();
}

export interface RetirementRequest { action: "retire"; targetEventId: string; reason: string; }
export async function retireFeedbackCase(request: RetirementRequest, dependencies: Pick<PromotionDependencies, "root" | "eventId" | "now"> & { appendLabelEvent?: typeof appendLabelEvent }): Promise<PromotionResult> {
  if (!nonempty(request.targetEventId) || typeof request.reason !== "string" || request.reason.length === 0) throw new QualityPromotionError("invalid_decision");
  const eventId = dependencies.eventId?.() ?? randomUUID();
  const event = { schemaVersion: 1, eventId, action: "retire", operation: "retire", occurredAt: (dependencies.now?.() ?? new Date()).toISOString(), targetEventId: request.targetEventId, reason: request.reason } as { eventId: string; [key: string]: unknown };
  const root = dependencies.root ?? DEFAULT_QUALITY_ROOT;
  const result = await (dependencies.appendLabelEvent ?? appendLabelEvent)(event, root, { beforeCommit: () => qualityRetirementTarget(root, request.targetEventId) });
  return { status: result.status, eventId };
}
