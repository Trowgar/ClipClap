import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, mkdtemp, open, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import OpenAI from "openai";
import type { TranscriptionResult } from "@clipclap/shared";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import type { Sha256 } from "../feedback-learning/types";
import { analyzeHighlightsV2, type AnalyzeV2Options } from "../analyze-v2";
import { loadAnalyzeConfig, type AnalyzeConfig } from "../analyze-v2/config";
import { fingerprintOutcomeRequest } from "./outcome-observe";
import { digestAnalyzeStep, MAX_OUTCOME_RECORDED_RESPONSES_BYTES, MAX_OUTCOME_SOURCE_BYTES, MAX_OUTCOME_TRANSCRIPT_BYTES, MAX_RECORDED_RESPONSES, type OutcomePromotionSnapshot, type RecordedOutcomeResponse } from "./outcome-promote";
import { parseOutcomeLabel, type OutcomeExpected } from "./outcome-types";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const SAFE_LANE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type OutcomeCaptureSnapshot = OutcomePromotionSnapshot;
export type OutcomeCapturePhase = "primary" | "recovery";

export type OutcomeCaptureRecord = RecordedOutcomeResponse & Readonly<{ recordingVersion: 2; phase: OutcomeCapturePhase }>;

export type OutcomeCaptureResult = Readonly<{
  captureId: Sha256;
  path: string;
  responseCount: number;
}>;

export type OutcomeCaptureArtifact = Readonly<{
  schemaVersion: 1;
  capturedAt: string;
  jobId: string;
  analyzeStepId: string;
  jobUpdatedAt: string;
  analyzeStepSha256: Sha256;
  analysisVersion: string;
  sourceDurationSec: number;
  sourceArtifactKey: string | null;
  normalizedArtifactKey: string | null;
  sourceSha256: Sha256;
  transcriptSha256: Sha256;
  transcript: unknown;
  configSha256: Sha256;
  engineFingerprint: Sha256;
  recordedResponsesSha256: Sha256;
  providerRequestIds: readonly string[];
  baselineResult: unknown;
  candidateResult: unknown;
  recordedResponses: readonly OutcomeCaptureRecord[];
  decisionDraft: Record<string, unknown>;
  attempts?: 3;
  liveLaneDraft?: unknown;
}>;

const MAX_OUTCOME_CAPTURE_BYTES = MAX_OUTCOME_TRANSCRIPT_BYTES + (2 * MAX_OUTCOME_RECORDED_RESPONSES_BYTES) + 256 * 1024;

export class OutcomeCaptureError extends Error {
  constructor(readonly code:
  | "invalid_snapshot" | "invalid_config" | "provider_error" | "capture_limit"
    | "invalid_completion" | "invalid_phase" | "recording_not_consumed" | "publication_failed") {
    super(code);
    this.name = "OutcomeCaptureError";
  }
}

type Completion = Readonly<{
  choices?: readonly Readonly<{
    message?: Readonly<{ content?: string | null; refusal?: string | null }>;
    finish_reason?: string | null;
  }>[];
  usage?: Readonly<{ prompt_tokens?: number; completion_tokens?: number }>;
}>;

function fail(code: OutcomeCaptureError["code"]): never { throw new OutcomeCaptureError(code); }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactDataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!plain(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length && keys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor !== undefined && descriptor.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value");
  }) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function finitePositive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function canonicalUtc(value: unknown): value is string {
  if (typeof value !== "string" || !UTC.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function validTranscript(value: unknown): value is TranscriptionResult {
  if (!plain(value) || !Array.isArray(value.segments) || value.segments.length === 0 || typeof value.text !== "string") return false;
  return value.segments.every((segment) => plain(segment) && typeof segment.start === "number" && Number.isFinite(segment.start) && typeof segment.end === "number" && Number.isFinite(segment.end) && segment.start >= 0 && segment.end > segment.start && typeof segment.text === "string");
}

function assertSnapshot(snapshot: OutcomeCaptureSnapshot): void {
  const job = snapshot?.job;
  const step = snapshot?.analyzeStep;
  if (!job || !step || job.status !== "DONE" || !canonicalUtc(job.updatedAt) || job.clipsGenerated !== 0 || job.clipCount !== 0 || job.noClipsReason !== "NO_VIABLE_MOMENTS" || job.transcriptPartial || job.analysisVersion === null || typeof job.analysisVersion !== "string" || !validTranscript(job.transcriptJson) || !finitePositive(job.sourceDurationSec) || (!job.sourceArtifactKey && !job.normalizedArtifactKey) || step.status !== "DONE" || step.error !== null || !canonicalUtc(step.finishedAt)) fail("invalid_snapshot");
  if (job.transcriptJson.segments.some((segment) => segment.end > job.sourceDurationSec!)) fail("invalid_snapshot");
  const transcriptBytes = Buffer.from(canonicalJson(job.transcriptJson));
  if (transcriptBytes.byteLength === 0 || transcriptBytes.byteLength > MAX_OUTCOME_TRANSCRIPT_BYTES) fail("invalid_snapshot");
}

function assertConfig(config: AnalyzeConfig): void {
  if (!plain(config) || config.outcomeRecoveryMode !== "shadow" || !Number.isSafeInteger(config.outcomeRecoveryMaxCandidates) || config.outcomeRecoveryMaxCandidates < 1 || config.outcomeRecoveryMaxCandidates > 12 || !Number.isSafeInteger(config.criticBatchSize) || config.criticBatchSize < config.outcomeRecoveryMaxCandidates) fail("invalid_config");
}

export type OutcomeCaptureReview = Readonly<{ eventId: string; reviewedAt: string; sourceReview: "complete"; sourceSha256: Sha256; configSha256: Sha256; transcriptSha256: Sha256; destination: "eval" | "holdout"; disposition: "recoverable_false_negative" | "valid_empty"; confidence: "high" | "medium"; subsystem: "selection" | "boundary" | "framing" | "subtitles" | "render"; expected: OutcomeExpected }>;

export function parseOutcomeCaptureReview(value: unknown): OutcomeCaptureReview {
  if (!plain(value) || Object.keys(value).sort().join(",") !== ["confidence", "configSha256", "destination", "disposition", "eventId", "expected", "reviewedAt", "sourceReview", "sourceSha256", "subsystem", "transcriptSha256"].join(",") || value.sourceReview !== "complete") fail("invalid_config");
  return value as unknown as OutcomeCaptureReview;
}

function validateReview(review: OutcomeCaptureReview, snapshot: OutcomeCaptureSnapshot, actual: Readonly<{ sourceSha256: Sha256; configSha256: Sha256; transcriptSha256: Sha256 }>): OutcomeCaptureReview {
  if (!plain(review) || Object.keys(review).sort().join(",") !== ["confidence", "configSha256", "destination", "disposition", "eventId", "expected", "reviewedAt", "sourceReview", "sourceSha256", "subsystem", "transcriptSha256"].join(",") || review.sourceReview !== "complete" || !SAFE_TOKEN.test(review.eventId) || !UTC.test(review.reviewedAt) || !["eval", "holdout"].includes(review.destination) || !["recoverable_false_negative", "valid_empty"].includes(review.disposition) || !["high", "medium"].includes(review.confidence) || !["selection", "boundary", "framing", "subtitles", "render"].includes(review.subsystem)) fail("invalid_config");
  try {
    const expected = parseOutcomeLabel({ schemaVersion: 1, action: "label", eventId: review.eventId, occurredAt: review.reviewedAt, caseVersion: `sha256:${"0".repeat(64)}`, set: review.destination, disposition: review.disposition, confidence: review.confidence, expected: review.expected }).expected;
    if (new Date(review.reviewedAt).getTime() < new Date(snapshot.job.updatedAt).getTime() || !/^sha256:[0-9a-f]{64}$/.test(review.sourceSha256) || !/^sha256:[0-9a-f]{64}$/.test(review.configSha256) || !/^sha256:[0-9a-f]{64}$/.test(review.transcriptSha256) || review.sourceSha256 !== actual.sourceSha256 || review.configSha256 !== actual.configSha256 || review.transcriptSha256 !== actual.transcriptSha256) fail("invalid_config");
    return Object.freeze({ ...review, expected });
  } catch (error) { if (error instanceof OutcomeCaptureError) throw error; return fail("invalid_config"); }
}

function responseFromRecording(recording: Readonly<{ result: Readonly<Record<string, unknown>> }>): Completion {
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  if (recording.result.__outcome === "refusal") return { choices: [{ message: { content: null, refusal: "recorded refusal" }, finish_reason: "stop" }], usage };
  if (recording.result.__outcome === "truncated") return { choices: [{ message: { content: null, refusal: null }, finish_reason: "length" }], usage };
  return { choices: [{ message: { content: canonicalJson(recording.result), refusal: null }, finish_reason: "stop" }], usage };
}

function captureCompletion(raw: unknown): Readonly<Record<string, unknown>> {
  if (!plain(raw)) fail("invalid_completion");
  const completion = raw as Completion;
  const choice = completion.choices?.[0];
  if (!choice || !plain(choice) || !plain(choice.message)) fail("invalid_completion");
  if (choice.message.refusal) return Object.freeze({ __outcome: "refusal" });
  if (choice.finish_reason === "length") return Object.freeze({ __outcome: "truncated" });
  if (choice.message.content === null || choice.message.content === undefined || choice.message.content === "") fail("invalid_completion");
  if (typeof choice.message.content !== "string") fail("invalid_completion");
  let parsed: unknown;
  try { parsed = JSON.parse(choice.message.content); } catch { return fail("invalid_completion"); }
  if (!plain(parsed)) fail("invalid_completion");
  if (Object.prototype.hasOwnProperty.call(parsed, "__outcome")) {
    if (Object.keys(parsed).length !== 1 || (parsed.__outcome !== "refusal" && parsed.__outcome !== "truncated")) fail("invalid_completion");
  }
  return Object.freeze(JSON.parse(canonicalJson(parsed)) as Record<string, unknown>);
}

function responseBytes(responses: readonly OutcomeCaptureRecord[]): number {
  let total = 0;
  for (const response of responses) {
    total += Buffer.byteLength(`${canonicalJson(response)}\n`);
    if (responses.length > MAX_RECORDED_RESPONSES || total > MAX_OUTCOME_RECORDED_RESPONSES_BYTES) fail("capture_limit");
  }
  return total;
}

function responseDigest(responses: readonly OutcomeCaptureRecord[]): Sha256 {
  const bytes = Buffer.from(responses.map((response) => `${canonicalJson(response)}\n`).join(""));
  return sha256(bytes);
}

async function hashSource(reader: Readonly<{ getObjectSize(key: string): Promise<number | null>; downloadFile(key: string): Promise<Uint8Array | Buffer | ReadableStream<Uint8Array>> }>, key: string): Promise<Sha256> {
  const size = await reader.getObjectSize(key);
  if (!Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > MAX_OUTCOME_SOURCE_BYTES) fail("invalid_snapshot");
  const digest = createHash("sha256");
  let total = 0;
  const consume = (chunk: Uint8Array): void => { total += chunk.byteLength; if (total > (size as number)) fail("invalid_snapshot"); digest.update(chunk); };
  const body = await reader.downloadFile(key);
  if (body instanceof Uint8Array) consume(body);
  else {
    const stream = body.getReader();
    try { for (;;) { const item = await stream.read(); if (item.done) break; consume(item.value); } }
    finally { await stream.cancel().catch(() => undefined); stream.releaseLock(); }
  }
  if (total !== size) fail("invalid_snapshot");
  return `sha256:${digest.digest("hex")}`;
}

function recordingProxy(
  realClient: OpenAI,
  phase: () => OutcomeCapturePhase,
  recordings: OutcomeCaptureRecord[],
  providerIds: string[],
  onProviderError: () => void,
): OpenAI {
  return { chat: { completions: { create: async (body: unknown, ...rest: unknown[]) => {
    let raw: unknown;
    try { raw = await (realClient.chat.completions.create as unknown as (...args: unknown[]) => Promise<unknown>)(body, ...rest); }
    catch (error) { onProviderError(); throw error; }
    const fingerprint = fingerprintOutcomeRequest(body);
    const result = captureCompletion(raw);
    recordings.push(Object.freeze({ recordingVersion: 2 as const, phase: phase(), ...fingerprint, result }));
    providerIds.push(typeof (raw as Record<string, unknown>).id === "string" ? (raw as Record<string, unknown>).id as string : "");
    responseBytes(recordings);
    return raw;
  } } } } as unknown as OpenAI;
}

function hybridShadowProxy(
  realClient: OpenAI,
  primary: readonly OutcomeCaptureRecord[],
  recordings: OutcomeCaptureRecord[],
  onProviderError: () => void,
  phase: () => OutcomeCapturePhase,
  providerIds: string[],
): OpenAI & { assertPrimaryConsumed(): void } {
  const queues = new Map<Sha256, OutcomeCaptureRecord[]>();
  for (const recording of primary) {
    const queue = queues.get(recording.requestFingerprint) ?? [];
    queue.push(recording);
    queues.set(recording.requestFingerprint, queue);
  }
  return {
    chat: { completions: { create: async (body: unknown, ...rest: unknown[]) => {
      const fingerprint = fingerprintOutcomeRequest(body);
      const queued = queues.get(fingerprint.requestFingerprint);
      const exact = queued?.[0];
      if (phase() === "primary") {
        if (!exact || exact.phase === "recovery") fail("invalid_phase");
        queued!.shift();
        return responseFromRecording(exact);
      }
      // Recovery never consumes a primary recording, even for an identical
      // request fingerprint. It must make a live provider call and receive
      // its own phase-bound recording.
      let raw: unknown;
      try { raw = await (realClient.chat.completions.create as unknown as (...args: unknown[]) => Promise<unknown>)(body, ...rest); }
      catch (error) { onProviderError(); throw error; }
      const result = captureCompletion(raw);
      recordings.push(Object.freeze({ recordingVersion: 2 as const, phase: phase(), ...fingerprint, result }));
      providerIds.push(typeof (raw as Record<string, unknown>).id === "string" ? (raw as Record<string, unknown>).id as string : "");
      responseBytes(recordings);
      return raw;
    } } },
    assertPrimaryConsumed() { if ([...queues.values()].some((queue) => queue.length > 0)) fail("recording_not_consumed"); },
  } as unknown as OpenAI & { assertPrimaryConsumed(): void };
}

function strictPrimaryReplayClient(primary: readonly OutcomeCaptureRecord[]): OpenAI & { assertConsumed(): void } {
  const queues = new Map<Sha256, OutcomeCaptureRecord[]>();
  const promptModels = new Set<string>();
  let remaining = 0;
  for (const recording of primary) {
    const queue = queues.get(recording.requestFingerprint) ?? [];
    queue.push(recording);
    queues.set(recording.requestFingerprint, queue);
    promptModels.add(`${recording.promptFingerprint}\0${recording.modelFingerprint}`);
    remaining += 1;
  }
  return { chat: { completions: { create: async (body: unknown) => {
    const fingerprint = fingerprintOutcomeRequest(body);
    const queue = queues.get(fingerprint.requestFingerprint);
    const exact = queue?.shift();
    if (!exact) {
      if (promptModels.has(`${fingerprint.promptFingerprint}\0${fingerprint.modelFingerprint}`)) fail("recording_not_consumed");
      fail(remaining === 0 ? "recording_not_consumed" : "invalid_phase");
    }
    if (exact.promptFingerprint !== fingerprint.promptFingerprint || exact.modelFingerprint !== fingerprint.modelFingerprint) fail("invalid_phase");
    remaining -= 1;
    return responseFromRecording(exact);
  } } }, assertConsumed() { if (remaining !== 0) fail("recording_not_consumed"); } } as unknown as OpenAI & { assertConsumed(): void };
}

async function atomicWrite(dir: string, captureId: string, bytes: Buffer): Promise<string> {
  let temporary: string | undefined;
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(dir, { recursive: true, mode: DIRECTORY_MODE });
    directoryHandle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const directoryStats = await directoryHandle.stat();
    if (!directoryStats.isDirectory() || (directoryStats.mode & 0o7777) !== DIRECTORY_MODE) return fail("publication_failed");
    const anchored = `/proc/self/fd/${directoryHandle.fd}`;
    const target = join(anchored, `${captureId}.json`);
    temporary = join(anchored, `.tmp-${randomBytes(12).toString("hex")}`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, FILE_MODE);
    let temporaryStats: Awaited<ReturnType<typeof handle.stat>>;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      temporaryStats = await handle.stat();
      if (!temporaryStats.isFile() || temporaryStats.nlink !== 1 || temporaryStats.size !== bytes.byteLength || (temporaryStats.mode & 0o7777) !== FILE_MODE) throw new Error("unsafe_temporary");
    } finally { await handle.close(); }
    let linked = false;
    try { await link(temporary, target); linked = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await unlink(temporary);
    temporary = undefined;
    const final = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const initialFinal = await final.stat();
      if (!initialFinal.isFile() || initialFinal.nlink !== 1 || initialFinal.size !== bytes.byteLength || (initialFinal.mode & 0o7777) !== FILE_MODE ||
          (linked && (initialFinal.dev !== temporaryStats.dev || initialFinal.ino !== temporaryStats.ino))) throw new Error("unsafe_target");
      const existingBytes = await final.readFile();
      if (!existingBytes.equals(bytes)) throw new Error("content_collision");
      const finalStats = await final.stat();
      if (!finalStats.isFile() || finalStats.nlink !== 1 || finalStats.size !== initialFinal.size || (finalStats.mode & 0o7777) !== FILE_MODE ||
          finalStats.dev !== initialFinal.dev || finalStats.ino !== initialFinal.ino || finalStats.mtimeMs !== initialFinal.mtimeMs || finalStats.ctimeMs !== initialFinal.ctimeMs) throw new Error("changed_target");
    } finally { await final.close(); }
    const finalDirectoryStats = await directoryHandle.stat();
    if (finalDirectoryStats.dev !== directoryStats.dev || finalDirectoryStats.ino !== directoryStats.ino || (finalDirectoryStats.mode & 0o7777) !== DIRECTORY_MODE) return fail("publication_failed");
    await directoryHandle.sync();
    return join(dir, `${captureId}.json`);
  } catch { return fail("publication_failed"); }
  finally { if (temporary) await unlink(temporary).catch(() => undefined); await directoryHandle?.close().catch(() => undefined); }
}

function exactCaptureObject(value: unknown): value is Record<string, unknown> {
  if (!plain(value)) return false;
  const base = ["analysisVersion", "analyzeStepId", "analyzeStepSha256", "baselineResult", "capturedAt", "candidateResult", "configSha256", "decisionDraft", "engineFingerprint", "jobId", "jobUpdatedAt", "normalizedArtifactKey", "providerRequestIds", "recordedResponses", "recordedResponsesSha256", "schemaVersion", "sourceArtifactKey", "sourceDurationSec", "sourceSha256", "transcript", "transcriptSha256"];
  const keys = Object.prototype.hasOwnProperty.call(value, "attempts") && Object.prototype.hasOwnProperty.call(value, "liveLaneDraft") ? [...base, "attempts", "liveLaneDraft"] : base;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length && keys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor !== undefined && descriptor.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value");
  }) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function parseCaptureArtifact(value: Record<string, unknown>): OutcomeCaptureArtifact {
  if (value.schemaVersion !== 1 || typeof value.capturedAt !== "string" || !UTC.test(value.capturedAt) || typeof value.jobId !== "string" || typeof value.analyzeStepId !== "string" ||
      typeof value.jobUpdatedAt !== "string" || !UTC.test(value.jobUpdatedAt) || !SAFE_TOKEN.test(value.jobId) || !SAFE_TOKEN.test(value.analyzeStepId) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(value.analyzeStepSha256)) || typeof value.analysisVersion !== "string" || !SAFE_TOKEN.test(value.analysisVersion) ||
      typeof value.sourceDurationSec !== "number" || !Number.isFinite(value.sourceDurationSec) || value.sourceDurationSec <= 0 ||
      (value.sourceArtifactKey !== null && typeof value.sourceArtifactKey !== "string") || (value.normalizedArtifactKey !== null && typeof value.normalizedArtifactKey !== "string") ||
      !/^sha256:[0-9a-f]{64}$/.test(String(value.sourceSha256)) || !/^sha256:[0-9a-f]{64}$/.test(String(value.transcriptSha256)) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(value.configSha256)) || !/^sha256:[0-9a-f]{64}$/.test(String(value.engineFingerprint)) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(value.recordedResponsesSha256)) || !Array.isArray(value.providerRequestIds) ||
      value.providerRequestIds.some((id) => typeof id !== "string" || !SAFE_TOKEN.test(id)) || !Array.isArray(value.recordedResponses) || !plain(value.decisionDraft)) fail("publication_failed");
  const recordedResponses = value.recordedResponses;
  if (recordedResponses.length > MAX_RECORDED_RESPONSES || recordedResponses.length !== value.providerRequestIds.length || recordedResponses.some((entry) => !plain(entry) || !exactDataObject(entry, ["recordingVersion", "phase", "promptFingerprint", "modelFingerprint", "requestFingerprint", "result"]))) fail("publication_failed");
  if (responseDigest(recordedResponses as OutcomeCaptureRecord[]) !== value.recordedResponsesSha256) fail("publication_failed");
  if (Object.prototype.hasOwnProperty.call(value, "attempts") && (value.attempts !== 3 || !Object.prototype.hasOwnProperty.call(value, "liveLaneDraft"))) fail("publication_failed");
  return Object.freeze({ ...value, providerRequestIds: Object.freeze([...value.providerRequestIds]), recordedResponses: Object.freeze(recordedResponses.map((entry) => Object.freeze({ ...entry }) as OutcomeCaptureRecord)) }) as unknown as OutcomeCaptureArtifact;
}

/** Authenticate a private capture artifact before it can be used for review
 * or promotion. All path operations are anchored to an opened directory FD. */
export async function readOutcomeCaptureFile(path: string, expectedCaptureId: Sha256): Promise<OutcomeCaptureArtifact> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!/^sha256:[0-9a-f]{64}$/.test(expectedCaptureId)) throw new Error();
    const name = basename(path);
    if (name !== `${expectedCaptureId}.json`) throw new Error();
    directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const directoryInitial = await directory.stat();
    if (!directoryInitial.isDirectory() || (directoryInitial.mode & 0o7777) !== DIRECTORY_MODE) throw new Error();
    file = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = await file.stat();
    if (!initial.isFile() || initial.nlink !== 1 || (initial.mode & 0o7777) !== FILE_MODE || initial.size <= 0 || initial.size > MAX_OUTCOME_CAPTURE_BYTES) throw new Error();
    const bytes = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < bytes.length) { const item = await file.read(bytes, offset, bytes.length - offset, null); if (!item.bytesRead) break; offset += item.bytesRead; }
    const final = await file.stat();
    const directoryFinal = await directory.stat();
    if (offset !== bytes.length || final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs || final.nlink !== 1 || (final.mode & 0o7777) !== FILE_MODE || directoryFinal.dev !== directoryInitial.dev || directoryFinal.ino !== directoryInitial.ino || (directoryFinal.mode & 0o7777) !== DIRECTORY_MODE) throw new Error();
    const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text) as unknown;
    if (!exactCaptureObject(value) || !text.endsWith("\n") || text !== `${canonicalJson(value)}\n` || sha256(canonicalJson(value)) !== expectedCaptureId) throw new Error();
    return parseCaptureArtifact(value);
  } catch { return fail("publication_failed"); }
  finally { await file?.close().catch(() => undefined); await directory?.close().catch(() => undefined); }
}

/** Secure writer for the exact human-review decision artifact. The caller
 * supplies a content-addressed filename; this function never overwrites. */
export async function writeOutcomePrivateFile(dir: string, filename: string, body: unknown): Promise<string> {
  if (!filename.endsWith(".json") || !SAFE_TOKEN.test(filename.slice(0, -5)) || filename.includes("/") || filename.includes("\\")) fail("publication_failed");
  const bytes = Buffer.from(`${canonicalJson(body)}\n`);
  return atomicWrite(dir, filename.slice(0, -5), bytes);
}

export async function captureOutcomeDecisionAssist(input: Readonly<{
  snapshot: OutcomeCaptureSnapshot;
  config: AnalyzeConfig;
  outputDir: string;
  realClient: OpenAI;
  sourceReader?: Readonly<{ getObjectSize(key: string): Promise<number | null>; downloadFile(key: string): Promise<Uint8Array | Buffer | ReadableStream<Uint8Array>> }>;
  attempts?: 1 | 3;
  liveLaneName?: string;
  /** Internal mode used only for attempts=3: candidate recordings are live,
   * then the baseline is derived by strict primary replay. */
  liveLaneCandidate?: boolean;
  review?: OutcomeCaptureReview;
  analyze?: (transcript: TranscriptionResult, options: AnalyzeV2Options) => Promise<unknown>;
  now?: Date;
}>): Promise<OutcomeCaptureResult> {
  try { assertSnapshot(input.snapshot); assertConfig(input.config); }
  catch (error) { if (error instanceof OutcomeCaptureError) throw error; return fail("invalid_snapshot"); }
  if (!input.realClient || typeof input.outputDir !== "string" || input.outputDir.length === 0 || input.outputDir.includes("\0")) fail("invalid_config");
  const attempts = input.attempts ?? 1;
  if (attempts !== 1 && attempts !== 3 || (attempts === 3 && (!input.liveLaneName || !SAFE_LANE.test(input.liveLaneName))) || (attempts === 1 && input.liveLaneName !== undefined)) fail("invalid_config");
  if (attempts === 3) {
    const spool = await mkdtemp(join("/tmp", "clipclap-outcome-attempts-"));
    try {
      const bodies: OutcomeCaptureArtifact[] = [];
      for (let index = 0; index < 3; index += 1) {
        const child = await captureOutcomeDecisionAssist({ ...input, attempts: 1, liveLaneName: undefined, liveLaneCandidate: true, outputDir: join(spool, String(index)) });
        bodies.push(await readOutcomeCaptureFile(child.path, child.captureId));
      }
      const fingerprints = bodies.map((body) => body.recordedResponses.map((entry) => entry.requestFingerprint));
      if (fingerprints.some((value) => canonicalJson(value) !== canonicalJson(fingerprints[0]))) fail("invalid_config");
      const allProviderIds = bodies.flatMap((body) => body.providerRequestIds);
      if (allProviderIds.some((id) => typeof id !== "string" || id.length === 0) || new Set(allProviderIds).size !== allProviderIds.length) fail("invalid_config");
      const laneCaseVersion = sha256(canonicalJson({ jobId: input.snapshot.job.id, analyzeStepId: input.snapshot.analyzeStep.id, transcriptSha256: bodies[0].transcriptSha256, sourceSha256: bodies[0].sourceSha256, configSha256: bodies[0].configSha256 }));
      const laneAttempts = bodies.map((body, index) => {
        const ids = body.providerRequestIds;
        const recordings = body.recordedResponses;
        if (!Array.isArray(ids) || ids.length !== recordings.length || ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) fail("invalid_config");
        const attemptBody = { attemptId: `${input.liveLaneName}-${index + 1}`, recordedAt: body.capturedAt, engineFingerprint: body.engineFingerprint, cases: [{ caseVersion: null, recordedResponses: recordings.map((recording, recordingIndex) => ({ providerRequestId: ids[recordingIndex], recording })) }] };
        return { ...attemptBody, captureSha256: sha256(canonicalJson(attemptBody)) };
      });
      const firstBody = bodies[0];
      const body = { ...firstBody, attempts: 3 as const, liveLaneDraft: { schemaVersion: 1 as const, name: input.liveLaneName!, caseVersion: laneCaseVersion, attempts: laneAttempts, materializeAfterPromotion: true as const } };
      const bytes = Buffer.from(`${canonicalJson(body)}\n`);
      const captureId = sha256(canonicalJson(body));
      return Object.freeze({ captureId, path: await atomicWrite(input.outputDir, captureId, bytes), responseCount: bodies.reduce((total, item) => total + item.recordedResponses.length, 0) });
    } finally { await rm(spool, { recursive: true, force: true }).catch(() => undefined); }
  }
  const primary: OutcomeCaptureRecord[] = [];
  const all: OutcomeCaptureRecord[] = [];
  const providerIds: string[] = [];
  let providerError = false;
  const analyze = input.analyze ?? analyzeHighlightsV2;
  const baselineConfig = Object.freeze({ ...input.config, outcomeRecoveryMode: "off" as const }) as AnalyzeConfig;
  const sourceKey = input.snapshot.job.normalizedArtifactKey ?? input.snapshot.job.sourceArtifactKey;
  if (!sourceKey || !input.sourceReader) fail("invalid_config");
  const sourceSha256 = await hashSource(input.sourceReader, sourceKey);
  const transcriptSha256 = sha256(Buffer.from(canonicalJson(input.snapshot.job.transcriptJson)));
  const configSha256 = sha256(canonicalJson(input.config));
  const review = input.review ? validateReview(input.review, input.snapshot, { sourceSha256, configSha256, transcriptSha256 }) : undefined;
  let baselineResult: unknown;
  let candidateResult: unknown;
  try {
    if (input.liveLaneCandidate) {
      let candidatePhase: OutcomeCapturePhase = "primary";
      const candidateRecords: OutcomeCaptureRecord[] = [];
      candidateResult = await analyze(input.snapshot.job.transcriptJson as TranscriptionResult, { cfg: input.config, client: recordingProxy(input.realClient, () => candidatePhase, candidateRecords, providerIds, () => { providerError = true; }), transcriptPartial: false, sourceDurationSec: input.snapshot.job.sourceDurationSec ?? undefined, outcomeRecoveryPhase: (phase) => { candidatePhase = phase; } });
      all.push(...candidateRecords);
      primary.push(...candidateRecords.filter((recording) => recording.phase === "primary"));
      const baselineClient = strictPrimaryReplayClient(primary);
      baselineResult = await analyze(input.snapshot.job.transcriptJson as TranscriptionResult, { cfg: baselineConfig, client: baselineClient, transcriptPartial: false, sourceDurationSec: input.snapshot.job.sourceDurationSec ?? undefined });
      baselineClient.assertConsumed();
    } else {
      baselineResult = await analyze(input.snapshot.job.transcriptJson as TranscriptionResult, { cfg: baselineConfig, client: recordingProxy(input.realClient, () => "primary", primary, providerIds, () => { providerError = true; }), transcriptPartial: false, sourceDurationSec: input.snapshot.job.sourceDurationSec ?? undefined });
      all.push(...primary);
      let candidatePhase: OutcomeCapturePhase = "primary";
      const candidateClient = hybridShadowProxy(input.realClient, primary, all, () => { providerError = true; }, () => candidatePhase, providerIds);
      candidateResult = await analyze(input.snapshot.job.transcriptJson as TranscriptionResult, { cfg: input.config, client: candidateClient, transcriptPartial: false, sourceDurationSec: input.snapshot.job.sourceDurationSec ?? undefined, outcomeRecoveryPhase: (phase) => { candidatePhase = phase; } });
      candidateClient.assertPrimaryConsumed();
    }
    if (providerError) fail("provider_error");
    const capturedAt = (input.now ?? new Date()).toISOString();
    const body = {
      schemaVersion: 1 as const,
      capturedAt,
      jobId: input.snapshot.job.id,
      analyzeStepId: input.snapshot.analyzeStep.id,
      jobUpdatedAt: input.snapshot.job.updatedAt,
      analyzeStepSha256: digestAnalyzeStep(input.snapshot.analyzeStep),
      analysisVersion: input.snapshot.job.analysisVersion,
      sourceDurationSec: input.snapshot.job.sourceDurationSec,
      sourceArtifactKey: input.snapshot.job.sourceArtifactKey,
      normalizedArtifactKey: input.snapshot.job.normalizedArtifactKey,
      sourceSha256,
      transcriptSha256,
      transcript: input.snapshot.job.transcriptJson,
      configSha256,
      engineFingerprint: sha256(canonicalJson(input.config)),
      recordedResponsesSha256: responseDigest(all),
      providerRequestIds: providerIds,
      baselineResult,
      candidateResult,
      recordedResponses: all,
      decisionDraft: {
        schemaVersion: 1 as const,
        eventId: review?.eventId ?? null,
        reviewedAt: review?.reviewedAt ?? null,
        jobId: input.snapshot.job.id,
        jobUpdatedAt: input.snapshot.job.updatedAt,
        analyzeStepId: input.snapshot.analyzeStep.id,
        analyzeStepSha256: digestAnalyzeStep(input.snapshot.analyzeStep),
        analysisVersion: input.snapshot.job.analysisVersion,
        engineFingerprint: sha256(canonicalJson(input.config)),
        configSha256,
        transcriptSha256,
        sourceSha256,
        recordedResponsesSha256: responseDigest(all),
        sourceReview: review?.sourceReview ?? null,
        destination: review?.destination ?? null,
        disposition: review?.disposition ?? null,
        confidence: review?.confidence ?? null,
        subsystem: review?.subsystem ?? null,
        expected: review?.expected ?? null,
        recordedResponses: all,
        humanReviewRequired: review ? [] : ["eventId", "reviewedAt", "sourceReview", "destination", "disposition", "confidence", "subsystem", "expected.approvedWindows", "expected.forbiddenWindows"],
      },
    };
    const canonical = Buffer.from(`${canonicalJson(body)}\n`);
    if (canonical.byteLength > (2 * MAX_OUTCOME_RECORDED_RESPONSES_BYTES) + MAX_OUTCOME_TRANSCRIPT_BYTES) fail("capture_limit");
    const captureId = sha256(canonicalJson(body));
    const path = await atomicWrite(input.outputDir, captureId, canonical);
    return Object.freeze({ captureId, path, responseCount: all.length });
  } catch (error) {
    if (error instanceof OutcomeCaptureError) throw error;
    if (providerError) fail("provider_error");
    throw error;
  }
}

export function defaultOutcomeCaptureConfig(): AnalyzeConfig {
  return loadAnalyzeConfig({});
}
