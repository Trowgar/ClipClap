import { randomUUID } from "node:crypto";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { appendLabelEvent, DEFAULT_QUALITY_ROOT, publishCaseAndLabel, type CommitResult, type PublishBundleInput } from "./store";
import type { FeedbackProjection } from "../feedback-learning/types";
import type { TargetSet, Subsystem } from "./types";

export type ContentHash = `sha256:${string}`;
export type PromotionCause = "reproducible" | "subjective" | "source" | "missing_evidence";
export type EvidenceStatus = "permanent" | "missing";

export interface V1ApprovalIdentity {
  eventId: string;
  feedbackId: string;
  feedbackUpdatedAt: string;
  snapshotSha256: ContentHash;
  candidateVersion: ContentHash;
  set: TargetSet;
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
  verdict: "AS_IS" | "EDIT" | "NO";
  disposition: "positive" | "confirmed_negative" | "exclude";
  set: TargetSet;
  subsystem: Subsystem;
  confidence: "high" | "medium";
  engineCause: PromotionCause;
  evidence: EvidenceStatus;
  expected: PromotionExpected;
  v1Approval?: V1ApprovalIdentity | null;
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
  v1Approval: V1ApprovalIdentity | null | undefined;
}

export interface PromotionIdentity {
  feedbackId: string;
  feedbackUpdatedAt: string;
  snapshotSha256: ContentHash;
  candidateVersion: ContentHash;
  v1Approval: V1ApprovalIdentity | null;
}

export interface MaterializedCase {
  schemaVersion: 1;
  caseVersion: string;
  feedbackId: string;
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
    transcriptSha256: ContentHash;
    evidenceSha256: ContentHash;
    sourceSha256: ContentHash | null;
    sourceDurationSec: number | null;
  };
}

export interface PromotionPublishInput {
  files: Readonly<Record<string, Uint8Array>>;
  label: { eventId: string; [key: string]: unknown };
}

export interface PromotionDependencies {
  repository: { capture(input: PromotionIdentity): Promise<PromotionSnapshot> };
  root?: string;
  publishCaseAndLabel?: (input: PromotionPublishInput, root: string) => Promise<CommitResult>;
  appendLabelEvent?: typeof appendLabelEvent;
  downloadFile: (key: string, request: { method: "GET" }) => Promise<Uint8Array | Buffer | ReadableStream<Uint8Array>>;
  /** Read-only projection of the existing V1 destination lock. */
  existingDestination?: (feedbackId: string) => Promise<TargetSet | null>;
  eventId?: () => string;
  now?: () => Date;
}

export type PromotionResult = Readonly<{ status: CommitResult["status"] | "excluded"; eventId: string; caseVersion?: string }>;

export class QualityPromotionError extends Error {
  constructor(readonly code: "invalid_decision" | "identity_mismatch" | "inputs_missing" | "evidence_missing" | "unsupported_label" | "publication_failed") {
    super(code);
    this.name = "QualityPromotionError";
  }
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const UUIDISH = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUBSYSTEMS: readonly Subsystem[] = ["selection", "boundary", "framing", "subtitles", "render"];
const TOP_KEYS = ["schemaVersion", "eventId", "feedbackId", "feedbackUpdatedAt", "snapshotSha256", "candidateVersion", "verdict", "disposition", "set", "subsystem", "confidence", "engineCause", "evidence", "expected", "v1Approval"];
const EXPECTED_KEYS = ["approvedMoment", "completeBoundary", "sourceWindow", "referenceOnly", "focalCoverage", "subtitleCoverage"];

function ownKeys(value: object, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key));
}
function ownRequiredAndOptional(value: object, required: readonly string[], optional: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))) return false;
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
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
  if (!ownRequiredAndOptional(value, TOP_KEYS.filter((key) => key !== "v1Approval"), ["v1Approval"]) || value.schemaVersion !== 1 || !nonempty(value.eventId) || !nonempty(value.feedbackId) || !validDate(value.feedbackUpdatedAt) ||
      !hash(value.snapshotSha256) || !hash(value.candidateVersion) || !["AS_IS", "EDIT", "NO"].includes(value.verdict as string) ||
      !["positive", "confirmed_negative", "exclude"].includes(value.disposition as string) || !["eval", "holdout"].includes(value.set as string) ||
      !SUBSYSTEMS.includes(value.subsystem as Subsystem) || !["high", "medium"].includes(value.confidence as string) ||
      !["reproducible", "subjective", "source", "missing_evidence"].includes(value.engineCause as string) || !["permanent", "missing"].includes(value.evidence as string)) throw new QualityPromotionError("invalid_decision");
  expected(value.expected);
  if (value.v1Approval !== null && value.v1Approval !== undefined) validateApproval(value.v1Approval);
  return value as unknown as PromotionDecision;
}
function validateApproval(raw: unknown): V1ApprovalIdentity {
  const value = object(raw);
  if (!ownKeys(value, ["eventId", "feedbackId", "feedbackUpdatedAt", "snapshotSha256", "candidateVersion", "set"]) || !nonempty(value.eventId) || !nonempty(value.feedbackId) || !validDate(value.feedbackUpdatedAt) || !hash(value.snapshotSha256) || !hash(value.candidateVersion) || !["eval", "holdout"].includes(value.set as string)) throw new QualityPromotionError("invalid_decision");
  return value as unknown as V1ApprovalIdentity;
}
function assertClassification(value: PromotionDecision, snapshot: PromotionSnapshot): void {
  const approval = snapshot.v1Approval ?? value.v1Approval;
  if (value.disposition === "positive") {
    if (value.verdict !== "AS_IS" || value.engineCause !== "reproducible" || value.evidence !== "permanent" || approval === null || approval === undefined) throw new QualityPromotionError("unsupported_label");
    if (approval.feedbackId !== value.feedbackId || approval.feedbackUpdatedAt !== value.feedbackUpdatedAt || approval.snapshotSha256 !== value.snapshotSha256 || approval.candidateVersion !== value.candidateVersion || approval.set !== value.set) throw new QualityPromotionError("identity_mismatch");
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
  if (snapshot.feedback.id !== value.feedbackId || currentUpdatedAt !== value.feedbackUpdatedAt ||
      sha256(canonicalJson(snapshot.feedback.snapshot)) !== value.snapshotSha256 ||
      sha256(`${value.feedbackId}\n${value.feedbackUpdatedAt}\n${value.snapshotSha256}`) !== value.candidateVersion) {
    throw new QualityPromotionError("identity_mismatch");
  }
}
function assertInputs(value: PromotionDecision, snapshot: PromotionSnapshot): void {
  const transcript = snapshot.job.transcriptJson;
  if (transcript === null || transcript === undefined || typeof transcript !== "object" || Array.isArray(transcript) ||
      !Array.isArray((transcript as { segments?: unknown }).segments) || snapshot.job.transcriptPartial || snapshot.job.sourceDurationSec === null) throw new QualityPromotionError("inputs_missing");
  if (value.subsystem === "selection" || value.subsystem === "boundary") {
    if (!value.expected.sourceWindow) throw new QualityPromotionError("inputs_missing");
  } else if (!value.expected.referenceOnly && !snapshot.job.sourceArtifactKey && !snapshot.job.normalizedArtifactKey) {
    throw new QualityPromotionError("inputs_missing");
  }
  if (!snapshot.feedback.evidenceKey || value.evidence !== "permanent") throw new QualityPromotionError("evidence_missing");
}
async function bytesFrom(value: Uint8Array | Buffer | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  const buffer = await new Response(value as ReadableStream<Uint8Array>).arrayBuffer();
  return new Uint8Array(buffer);
}
function nowIso(dependencies: PromotionDependencies): string { const date = dependencies.now?.() ?? new Date(); const value = date.toISOString(); if (!validDate(value)) throw new QualityPromotionError("publication_failed"); return value; }

export async function promoteFeedbackCase(rawDecision: PromotionDecision, dependencies: PromotionDependencies): Promise<PromotionResult> {
  const value = validateDecision(rawDecision);
  const identity: PromotionIdentity = { feedbackId: value.feedbackId, feedbackUpdatedAt: value.feedbackUpdatedAt, snapshotSha256: value.snapshotSha256, candidateVersion: value.candidateVersion, v1Approval: value.v1Approval ?? null };
  const snapshot = await dependencies.repository.capture(identity);
  assertSnapshotIdentity(value, snapshot);
  const lockedDestination = await dependencies.existingDestination?.(value.feedbackId);
  if (lockedDestination !== undefined && lockedDestination !== null && lockedDestination !== value.set) throw new QualityPromotionError("identity_mismatch");
  if (value.disposition === "exclude") {
    if (snapshot.feedback.verdict !== value.verdict) throw new QualityPromotionError("identity_mismatch");
    const append = dependencies.appendLabelEvent ?? appendLabelEvent;
    const result = await append({ schemaVersion: 1, eventId: value.eventId, action: "label", occurredAt: nowIso(dependencies), feedbackId: value.feedbackId, feedbackUpdatedAt: value.feedbackUpdatedAt, snapshotSha256: value.snapshotSha256, candidateVersion: value.candidateVersion, set: value.set, disposition: "exclude", verdict: value.verdict, subsystem: value.subsystem, confidence: value.confidence, reason: value.engineCause }, dependencies.root ?? DEFAULT_QUALITY_ROOT);
    return { status: result.status === "indeterminate" ? "indeterminate" : "excluded", eventId: value.eventId };
  }
  assertClassification(value, snapshot);
  assertInputs(value, snapshot);
  const evidence = await bytesFrom(await dependencies.downloadFile(snapshot.feedback.evidenceKey!, { method: "GET" }));
  if (evidence.byteLength === 0) throw new QualityPromotionError("evidence_missing");
  const transcript = Buffer.from(canonicalJson(snapshot.job.transcriptJson));
  const sourceKey = snapshot.job.normalizedArtifactKey ?? snapshot.job.sourceArtifactKey;
  const source = sourceKey ? await bytesFrom(await dependencies.downloadFile(sourceKey, { method: "GET" })) : null;
  if (sourceKey && (!source || source.byteLength === 0)) throw new QualityPromotionError("inputs_missing");
  const inputs = { transcriptSha256: sha256(transcript), evidenceSha256: sha256(Buffer.from(evidence)), sourceSha256: source ? sha256(Buffer.from(source)) : null, sourceDurationSec: snapshot.job.sourceDurationSec };
  const caseBody = { schemaVersion: 1 as const, feedbackId: value.feedbackId, feedbackUpdatedAt: value.feedbackUpdatedAt, snapshotSha256: value.snapshotSha256, candidateVersion: value.candidateVersion, set: value.set, disposition: value.disposition, verdict: value.verdict, subsystem: value.subsystem, confidence: value.confidence, expected: value.expected, inputs };
  const caseVersion = `case:${sha256(canonicalJson(caseBody))}`;
  const materialized: MaterializedCase = { ...caseBody, caseVersion };
  const label = { schemaVersion: 1, eventId: value.eventId, action: "label", occurredAt: nowIso(dependencies), feedbackId: value.feedbackId, feedbackUpdatedAt: value.feedbackUpdatedAt, snapshotSha256: value.snapshotSha256, candidateVersion: value.candidateVersion, caseVersion, set: value.set, disposition: value.disposition, verdict: value.verdict, subsystem: value.subsystem, confidence: value.confidence, expected: value.expected };
  const publish = dependencies.publishCaseAndLabel ?? ((input, root) => publishCaseAndLabel({ kind: "case", id: caseVersion, files: input.files }, input.label, root));
  const result = await publish({ files: { "case.json": Buffer.from(`${canonicalJson(materialized)}\n`), "transcript.json": new Uint8Array(transcript), "source-or-evidence.mp4": source ?? evidence }, label }, dependencies.root ?? DEFAULT_QUALITY_ROOT);
  if (result.status === "indeterminate") throw new QualityPromotionError("publication_failed");
  return { status: result.status, eventId: value.eventId, caseVersion };
}

export interface RetirementRequest { action: "retire"; targetEventId: string; reason: string; }
export async function retireFeedbackCase(request: RetirementRequest, dependencies: Pick<PromotionDependencies, "root" | "eventId" | "now"> & { appendLabelEvent?: typeof appendLabelEvent }): Promise<PromotionResult> {
  if (!nonempty(request.targetEventId) || typeof request.reason !== "string" || request.reason.length === 0) throw new QualityPromotionError("invalid_decision");
  const eventId = dependencies.eventId?.() ?? randomUUID();
  const event = { schemaVersion: 1, eventId, action: "retire", operation: "retire", occurredAt: (dependencies.now?.() ?? new Date()).toISOString(), targetEventId: request.targetEventId, reason: request.reason } as { eventId: string; [key: string]: unknown };
  const result = await (dependencies.appendLabelEvent ?? appendLabelEvent)(event, dependencies.root ?? DEFAULT_QUALITY_ROOT);
  return { status: result.status, eventId };
}
