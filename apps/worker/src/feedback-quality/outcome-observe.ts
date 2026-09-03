import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import type OpenAI from "openai";
import type { TranscriptionResult } from "@clipclap/shared";

import { analyzeHighlightsV2, type AnalyzeV2Options } from "../analyze-v2";
import type { AnalyzeConfig } from "../analyze-v2/config";
import type { V2Result } from "../analyze-v2/types";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import type { Sha256 } from "../feedback-learning/types";
import { loadOutcomeObservationAuthority, withOutcomeObservationAuthority, type OutcomeObservationAuthorityCase, type RecordedOutcomeResponse } from "./outcome-promote";
import { ensureOutcomeStore } from "./outcome-store";
import { parseOutcomeCase, type OutcomeCase, type OutcomeDisposition } from "./outcome-types";
import type { CommitResult } from "./store";

const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const RECOVERY_KEYS = ["addedUsage", "counters", "elapsedMs", "eligible", "excludedMissingRange", "judged", "mode", "outcome", "poolSize", "primaryDispositions", "ranges", "reason", "recoveryDispositions", "tailSize", "version"] as const;
const RECOVERY_MODES = new Set(["shadow", "on"]);
const RECOVERY_REASONS = new Set(["mode_off", "non_empty", "wrong_content_reason", "partial_transcript", "missing_range", "degenerate", "song_gate", "music_short", "no_unjudged_tail", "unjudged_tail", "empty_pool", "quality_error", "malformed_state"]);
const RECOVERY_OUTCOMES = new Set(["not_eligible", "no_candidate", "empty_pool", "rejected", "failed", "shadow_hit", "shadow_miss", "shipped"]);
const PRIMARY_DISPOSITIONS = new Set(["not_selected_for_critic", "critic_unjudged", "missing_range_rejected", "critic_rejected", "evidence_rejected", "snap_rejected", "selection_not_chosen", "arc_rejected", "post_boundary_rejected", "standalone_rejected", "finalizer_rejected", "shipped"]);
const RECOVERY_DISPOSITIONS = new Set(["critic_unjudged", "critic_rejected", "evidence_rejected", "snap_rejected", "selection_not_chosen", "arc_rejected", "post_boundary_rejected", "standalone_rejected", "finalizer_rejected", "shipped", "finalizer_unjudged"]);

export const OUTCOME_OBSERVATION_RUNNER_VERSION = "outcome-observe-v1" as const;

export type OutcomeObservationMode = "baseline" | "candidate";

export type OutcomeObservationResult = Readonly<{
  caseVersion: Sha256;
  disposition: Exclude<OutcomeDisposition, "exclude">;
  shippedWindows: readonly Readonly<{ start: number; end: number }>[];
  approvedHits: number;
  forbiddenHits: number;
  keepFalseShipped: number;
  explicitGateResurrections: number;
  candidateCap: number;
  criticBatches: number;
  noClipsReason: V2Result["noClipsReason"] | null;
}>;

export type OutcomeObservation = Readonly<{
  schemaVersion: 1;
  observationId: Sha256;
  mode: OutcomeObservationMode;
  commitSha: string;
  engineFingerprint: Sha256;
  corpusDigest: Sha256;
  runnerVersion: typeof OUTCOME_OBSERVATION_RUNNER_VERSION;
  recordedResponsesDigest: Sha256;
  results: readonly OutcomeObservationResult[];
  liveLane?: Readonly<{ name: string; attempts: 3; attemptDigests: readonly [Sha256, Sha256, Sha256] }>;
}>;

export type OutcomeObservationCase = Readonly<{
  case: OutcomeCase;
  transcript: TranscriptionResult | Readonly<Record<string, unknown>>;
  recordedResponses: readonly RecordedOutcomeResponse[];
}>;

export type MaterializedOutcomeLiveLane = Readonly<{
  schemaVersion: 1;
  name: string;
  attempts: readonly Readonly<{
    attemptId: string;
    recordedAt: string;
    engineFingerprint: Sha256;
    captureSha256: Sha256;
    cases: readonly Readonly<{ caseVersion: Sha256; recordedResponses: readonly Readonly<{ providerRequestId: string; recording: RecordedOutcomeResponse }>[] }>[];
  }>[];
}>;

export class OutcomeObservationError extends Error {
  readonly requiredLiveLane?: Readonly<{ attempts: 3; named: true }>;

  constructor(readonly code:
    | "invalid_input" | "invalid_case" | "missing_request" | "request_fingerprint_drift"
    | "unknown_telemetry" | "output_out_of_duration" | "recording_not_consumed"
    | "private_store_invalid" | "publication_failed" | "live_lane_required" | "invalid_live_lane" | "live_attempt_disagreement") {
    super(code);
    this.name = "OutcomeObservationError";
    if (code === "request_fingerprint_drift" || code === "live_lane_required") {
      this.requiredLiveLane = Object.freeze({ attempts: 3, named: true });
    }
  }
}

function fail(code: OutcomeObservationError["code"]): never { throw new OutcomeObservationError(code); }
function isHash(value: unknown): value is Sha256 { return typeof value === "string" && HASH.test(value); }
function isPlain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join(",") === [...keys].sort().join(",") && Reflect.ownKeys(value).length === keys.length; }
function exactDataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlain(value) || !exactKeys(value, keys)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every((descriptor) => descriptor.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value"));
}
function nonnegativeInt(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function canonicalUtc(value: unknown): value is string {
  if (typeof value !== "string" || !UTC.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function recordedResponseBytes(recordings: readonly RecordedOutcomeResponse[]): Buffer {
  try { return Buffer.from(recordings.map((recording) => canonicalJson(recording)).join("\n") + (recordings.length > 0 ? "\n" : "")); }
  catch { return fail("invalid_case"); }
}

function validateCaseBinding(item: OutcomeObservationCase): OutcomeObservationCase {
  let parsed: OutcomeCase;
  let transcriptBytes: Buffer;
  try {
    parsed = parseOutcomeCase(item.case);
    transcriptBytes = Buffer.from(canonicalJson(item.transcript));
  } catch { return fail("invalid_case"); }
  const { caseVersion: _caseVersion, ...body } = parsed;
  if (sha256(canonicalJson(body)) !== parsed.caseVersion || sha256(transcriptBytes) !== parsed.transcriptSha256 ||
      sha256(recordedResponseBytes(item.recordedResponses)) !== parsed.recordedResponsesSha256 || !isHash(parsed.sourceSha256)) fail("invalid_case");
  return Object.freeze({ case: parsed, transcript: item.transcript, recordedResponses: item.recordedResponses });
}

export function fingerprintOutcomeRequest(raw: unknown): Readonly<{ promptFingerprint: Sha256; modelFingerprint: Sha256; requestFingerprint: Sha256 }> {
  if (!isPlain(raw) || typeof raw.model !== "string" || !Array.isArray(raw.messages)) fail("invalid_input");
  const messages = raw.messages;
  const system = messages.find((entry) => isPlain(entry) && entry.role === "system") as Record<string, unknown> | undefined;
  const user = messages.find((entry) => isPlain(entry) && entry.role === "user") as Record<string, unknown> | undefined;
  if (typeof system?.content !== "string" || typeof user?.content !== "string") fail("invalid_input");
  try {
    return Object.freeze({
      promptFingerprint: sha256(canonicalJson({ system: system.content, user: user.content })),
      modelFingerprint: sha256(raw.model),
      requestFingerprint: sha256(canonicalJson(raw)),
    });
  } catch { return fail("invalid_input"); }
}

function completion(recording: RecordedOutcomeResponse): Readonly<Record<string, unknown>> {
  const result = recording.result;
  const outcome = result.__outcome;
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  if (outcome === "truncated") return { choices: [{ message: { content: null, refusal: null }, finish_reason: "length" }], usage };
  if (outcome === "refusal") return { choices: [{ message: { content: null, refusal: "recorded refusal" }, finish_reason: "stop" }], usage };
  return { choices: [{ message: { content: canonicalJson(result), refusal: null }, finish_reason: "stop" }], usage };
}

function strictReplayClient(recordings: readonly RecordedOutcomeResponse[]): OpenAI & { assertComplete(): void } {
  const queues = new Map<Sha256, RecordedOutcomeResponse[]>();
  const promptModels = new Set<string>();
  let remaining = 0;
  for (const recording of recordings) {
    if (!exactDataObject(recording, ["promptFingerprint", "modelFingerprint", "requestFingerprint", "result"]) || !isHash(recording.promptFingerprint) || !isHash(recording.modelFingerprint) || !isHash(recording.requestFingerprint) || !isPlain(recording.result)) fail("invalid_case");
    const queue = queues.get(recording.requestFingerprint) ?? [];
    queue.push(recording);
    queues.set(recording.requestFingerprint, queue);
    promptModels.add(`${recording.promptFingerprint}\0${recording.modelFingerprint}`);
    remaining += 1;
  }
  let replayFailure: OutcomeObservationError | undefined;
  const create = async (body: unknown) => {
    try {
      const fingerprint = fingerprintOutcomeRequest(body);
      const queue = queues.get(fingerprint.requestFingerprint);
      const exact = queue?.shift();
      if (!exact) {
        if (queues.has(fingerprint.requestFingerprint)) fail("missing_request");
        if (promptModels.has(`${fingerprint.promptFingerprint}\0${fingerprint.modelFingerprint}`)) fail("request_fingerprint_drift");
        fail(remaining === 0 ? "missing_request" : "live_lane_required");
      }
      if (exact.promptFingerprint !== fingerprint.promptFingerprint || exact.modelFingerprint !== fingerprint.modelFingerprint) fail("request_fingerprint_drift");
      remaining -= 1;
      return completion(exact);
    } catch (error) {
      if (error instanceof OutcomeObservationError) replayFailure ??= error;
      throw error;
    }
  };
  return { chat: { completions: { create } }, assertComplete() { if (replayFailure) throw replayFailure; if (remaining !== 0) fail("recording_not_consumed"); } } as unknown as OpenAI & { assertComplete(): void };
}

function countMap(value: unknown, allowed: ReadonlySet<string>): boolean {
  if (!isPlain(value) || !exactDataObject(value, Object.keys(value))) return false;
  return Object.entries(value).every(([key, count]) => allowed.has(key) && nonnegativeInt(count));
}

function sumCounts(value: Record<string, unknown>): number { return Object.values(value).reduce<number>((sum, count) => sum + (count as number), 0); }

function validateRecoveryTelemetry(value: unknown, cfg: AnalyzeConfig): Record<string, unknown> {
  const expectedMode = cfg.outcomeRecoveryMode as "shadow" | "on";
  if (!exactDataObject(value, RECOVERY_KEYS) || value.version !== "core-v4-recovery-v1" || value.mode !== expectedMode || !RECOVERY_MODES.has(value.mode as string) || typeof value.eligible !== "boolean" || !RECOVERY_REASONS.has(value.reason as string) || !RECOVERY_OUTCOMES.has(value.outcome as string)) fail("unknown_telemetry");
  for (const key of ["tailSize", "poolSize", "excludedMissingRange", "judged", "elapsedMs"] as const) if (!nonnegativeInt(value[key])) fail("unknown_telemetry");
  if (!exactDataObject(value.counters, ["selectedForFinalizer", "finalizerSurvivors"]) || !nonnegativeInt(value.counters.selectedForFinalizer) || !nonnegativeInt(value.counters.finalizerSurvivors)) fail("unknown_telemetry");
  if (!countMap(value.primaryDispositions, PRIMARY_DISPOSITIONS) || !countMap(value.recoveryDispositions, RECOVERY_DISPOSITIONS)) fail("unknown_telemetry");
  if (!exactDataObject(value.addedUsage, ["inputTokens", "outputTokens", "requests", "byModel"]) || !nonnegativeInt(value.addedUsage.inputTokens) || !nonnegativeInt(value.addedUsage.outputTokens) || !nonnegativeInt(value.addedUsage.requests) || !isPlain(value.addedUsage.byModel)) fail("unknown_telemetry");
  for (const bucket of Object.values(value.addedUsage.byModel)) if (!exactDataObject(bucket, ["inputTokens", "outputTokens", "requests"]) || !nonnegativeInt(bucket.inputTokens) || !nonnegativeInt(bucket.outputTokens) || !nonnegativeInt(bucket.requests)) fail("unknown_telemetry");
  if (!Array.isArray(value.ranges) || value.ranges.some((range) => !exactDataObject(range, ["startMs", "endMs"]) || !nonnegativeInt(range.startMs) || !nonnegativeInt(range.endMs) || range.endMs <= range.startMs)) fail("unknown_telemetry");
  const pool = value.poolSize as number;
  const tail = value.tailSize as number;
  const excluded = value.excludedMissingRange as number;
  const judged = value.judged as number;
  const counters = value.counters as Record<string, number>;
  const primary = value.primaryDispositions as Record<string, unknown>;
  const recovery = value.recoveryDispositions as Record<string, unknown>;
  const usage = value.addedUsage as { requests: number; inputTokens: number; outputTokens: number; byModel: Record<string, { requests: number; inputTokens: number; outputTokens: number }> };
  const ranges = value.ranges as Array<unknown>;
  const recoveryUnjudged = (recovery.critic_unjudged as number | undefined) ?? 0;
  const recoveryShipped = (recovery.shipped as number | undefined) ?? 0;
  if (!Number.isSafeInteger(cfg.outcomeRecoveryMaxCandidates) || cfg.outcomeRecoveryMaxCandidates < 1 || cfg.outcomeRecoveryMaxCandidates > 12 ||
      pool > cfg.outcomeRecoveryMaxCandidates || pool > tail || excluded > tail || pool + excluded > tail || ((value.eligible as boolean) && judged > pool) ||
      counters.finalizerSurvivors > counters.selectedForFinalizer || counters.selectedForFinalizer > judged || ranges.length > counters.finalizerSurvivors ||
      sumCounts(primary) < tail || ((primary.not_selected_for_critic as number | undefined) ?? 0) !== tail || sumCounts(recovery) !== ((value.eligible as boolean) ? pool : 0) ||
      Object.values(usage.byModel).reduce((n, bucket) => n + bucket.requests, 0) !== usage.requests ||
      Object.values(usage.byModel).reduce((n, bucket) => n + bucket.inputTokens, 0) !== usage.inputTokens ||
      Object.values(usage.byModel).reduce((n, bucket) => n + bucket.outputTokens, 0) !== usage.outputTokens) fail("unknown_telemetry");
  const eligible = value.eligible as boolean;
  const outcome = value.outcome as string;
  const reason = value.reason as string;
  if ((eligible !== (reason === "unjudged_tail" || reason === "empty_pool" || reason === "quality_error")) ||
      (!eligible && !["not_eligible", "no_candidate"].includes(outcome)) ||
      (eligible && pool === 0 && outcome !== "empty_pool") ||
      (eligible && pool > 0 && ["not_eligible", "no_candidate", "empty_pool"].includes(outcome)) ||
      (outcome === "shipped" && expectedMode !== "on") ||
      ((outcome === "shadow_hit" || outcome === "shadow_miss") && expectedMode !== "shadow") ||
      (eligible && judged !== pool - recoveryUnjudged) || (eligible && judged > 0 && usage.requests === 0) ||
      ranges.length !== recoveryShipped || ((outcome === "shipped" || outcome === "shadow_hit") !== (ranges.length > 0)) ||
      (reason === "empty_pool" && outcome !== "empty_pool") || (reason === "quality_error" && outcome !== "failed") ||
      (reason === "unjudged_tail" && expectedMode === "on" && !["shipped", "rejected", "failed"].includes(outcome)) ||
      (reason === "unjudged_tail" && expectedMode === "shadow" && !["shadow_hit", "shadow_miss", "failed"].includes(outcome)) ||
      (["rejected", "failed", "shadow_miss", "not_eligible", "no_candidate", "empty_pool"].includes(outcome) && ranges.length !== 0)) fail("unknown_telemetry");
  return value;
}

function overlap(window: { start: number; end: number }, expected: { start: number; end: number }): boolean {
  return Math.min(window.end, expected.end) > Math.max(window.start, expected.start);
}

function projectResult(item: OutcomeObservationCase, result: V2Result, cfg: AnalyzeConfig, mode: OutcomeObservationMode, suppliedAudit: Readonly<{ keepFalseShipped: number; explicitGateResurrections: number }> | undefined): OutcomeObservationResult {
  if (item.case.disposition === "exclude") fail("invalid_case");
  if (!Array.isArray(result.highlights) || !isPlain(result.telemetry)) fail("invalid_case");
  if (result.noClipsReason !== undefined && result.noClipsReason !== "NO_USABLE_SPEECH" && result.noClipsReason !== "NO_VIABLE_MOMENTS" && result.noClipsReason !== "PARTIAL_TRANSCRIPT") fail("unknown_telemetry");
  let shippedWindows = result.highlights.map((highlight) => {
    if (!highlight || typeof highlight !== "object" || !Number.isFinite(highlight.start) || !Number.isFinite(highlight.end) || highlight.start < 0 || highlight.end <= highlight.start || highlight.end > item.case.sourceDurationSec) fail("output_out_of_duration");
    return Object.freeze({ start: highlight.start, end: highlight.end });
  });
  let criticBatches = 0;
  let audit: Readonly<{ keepFalseShipped: number; explicitGateResurrections: number }> = Object.freeze({ keepFalseShipped: 0, explicitGateResurrections: 0 });
  if (mode === "baseline") {
    if (Object.prototype.hasOwnProperty.call(result.telemetry, "outcomeRecovery")) fail("unknown_telemetry");
  } else {
    const recovery = validateRecoveryTelemetry(result.telemetry.outcomeRecovery, cfg);
    if ((recovery.outcome === "shipped" || recovery.outcome === "shadow_hit") && suppliedAudit === undefined) fail("unknown_telemetry");
    if (recovery.outcome !== "shipped" && recovery.outcome !== "shadow_hit" && suppliedAudit !== undefined &&
        (suppliedAudit.keepFalseShipped !== 0 || suppliedAudit.explicitGateResurrections !== 0)) fail("unknown_telemetry");
    if (suppliedAudit !== undefined) audit = suppliedAudit;
    const recoveryRanges = (recovery.ranges as Array<{ startMs: number; endMs: number}>).map((range) => ({ start: range.startMs / 1000, end: range.endMs / 1000 }));
    if (cfg.outcomeRecoveryMode === "shadow" && result.highlights.length !== 0) fail("unknown_telemetry");
    if (cfg.outcomeRecoveryMode === "on" && recovery.outcome === "shipped" && canonicalJson(shippedWindows) !== canonicalJson(recoveryRanges)) fail("unknown_telemetry");
    if (cfg.outcomeRecoveryMode === "on" && recovery.outcome !== "shipped" && recovery.reason !== "non_empty" && result.highlights.length !== 0) fail("unknown_telemetry");
    criticBatches = (recovery.poolSize as number) === 0 ? 0 : Math.ceil((recovery.poolSize as number) / cfg.criticBatchSize);
    if (criticBatches > 1) fail("unknown_telemetry");
    // Shadow returns the primary empty set; its bounded geometry is the
    // candidate output under evaluation, never a customer-visible claim.
    if (cfg.outcomeRecoveryMode === "shadow" && recovery.outcome === "shadow_hit") {
      shippedWindows = recoveryRanges.map((range) => Object.freeze(range));
      if (shippedWindows.some((window) => window.end > item.case.sourceDurationSec)) fail("output_out_of_duration");
    }
  }
  return Object.freeze({
    caseVersion: item.case.caseVersion,
    disposition: item.case.disposition,
    shippedWindows: Object.freeze(shippedWindows),
    approvedHits: item.case.expected.approvedWindows.filter((expected) => shippedWindows.some((window) => overlap(window, expected))).length,
    forbiddenHits: item.case.expected.forbiddenWindows.filter((expected) => shippedWindows.some((window) => overlap(window, expected))).length,
    keepFalseShipped: audit.keepFalseShipped,
    explicitGateResurrections: audit.explicitGateResurrections,
    candidateCap: mode === "baseline" ? 0 : cfg.outcomeRecoveryMaxCandidates,
    criticBatches,
    noClipsReason: result.noClipsReason ?? null,
  });
}

function corpusDigest(cases: readonly OutcomeObservationCase[]): Sha256 {
  return sha256(canonicalJson(cases.map(({ case: value }) => ({ caseVersion: value.caseVersion, transcriptSha256: value.transcriptSha256, sourceSha256: value.sourceSha256, expected: value.expected, disposition: value.disposition }))));
}

function parseLiveLane(raw: MaterializedOutcomeLiveLane, cases: readonly OutcomeObservationCase[], engineFingerprint: Sha256, now: Date): Readonly<{
  name: string;
  attempts: readonly Readonly<{ attemptId: string; recordedAt: string; responses: readonly (readonly RecordedOutcomeResponse[])[]; digest: Sha256 }>[];
}> {
  if (!exactDataObject(raw, ["schemaVersion", "name", "attempts"]) || raw.schemaVersion !== 1 || !SAFE_NAME.test(raw.name) || !Array.isArray(raw.attempts) || raw.attempts.length !== 3) fail("invalid_live_lane");
  const expectedVersions = cases.map((item) => item.case.caseVersion);
  const attemptIds = new Set<string>();
  const providerRequestIds = new Set<string>();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) fail("invalid_live_lane");
  const attempts = raw.attempts.map((attempt) => {
    const providerCountBefore = providerRequestIds.size;
    if (!exactDataObject(attempt, ["attemptId", "recordedAt", "engineFingerprint", "captureSha256", "cases"])) fail("invalid_live_lane");
    const attemptId = attempt.attemptId;
    const recordedAt = attempt.recordedAt;
    const attemptCases = attempt.cases;
    const recordedMs = typeof recordedAt === "string" ? new Date(recordedAt).getTime() : Number.NaN;
    if (typeof attemptId !== "string" || !SAFE_NAME.test(attemptId) || attemptIds.has(attemptId) || !canonicalUtc(recordedAt) ||
        attempt.engineFingerprint !== engineFingerprint || !isHash(attempt.captureSha256) || recordedMs > nowMs || nowMs - recordedMs > 24 * 60 * 60 * 1000 ||
        !Array.isArray(attemptCases) || attemptCases.length !== cases.length) fail("invalid_live_lane");
    const { captureSha256, ...captureBody } = attempt;
    if (sha256(canonicalJson(captureBody)) !== captureSha256) fail("invalid_live_lane");
    attemptIds.add(attemptId);
    const ordered = [...attemptCases].sort((left, right) => String((left as Record<string, unknown>).caseVersion).localeCompare(String((right as Record<string, unknown>).caseVersion))) as Array<{ caseVersion: Sha256; recordedResponses: readonly Readonly<{ providerRequestId: string; recording: RecordedOutcomeResponse }>[] }>;
    if (ordered.some((entry, index) => !exactDataObject(entry, ["caseVersion", "recordedResponses"]) || entry.caseVersion !== expectedVersions[index] || !Array.isArray(entry.recordedResponses))) fail("invalid_live_lane");
    const recordings = ordered.map((entry) => entry.recordedResponses.map((captured) => {
      if (!exactDataObject(captured, ["providerRequestId", "recording"]) || typeof captured.providerRequestId !== "string" || !SAFE_NAME.test(captured.providerRequestId) || providerRequestIds.has(captured.providerRequestId)) fail("invalid_live_lane");
      providerRequestIds.add(captured.providerRequestId);
      return captured.recording;
    }));
    for (const entry of recordings) strictReplayClient(entry);
    if (providerRequestIds.size === providerCountBefore) fail("invalid_live_lane");
    return Object.freeze({
      attemptId,
      recordedAt,
      responses: Object.freeze(recordings.map((entry) => Object.freeze([...entry]))),
      digest: sha256(canonicalJson(attempt)),
    });
  });
  return Object.freeze({ name: raw.name, attempts: Object.freeze(attempts) });
}

async function runCases(
  cases: readonly OutcomeObservationCase[],
  recordings: readonly (readonly RecordedOutcomeResponse[])[],
  cfg: AnalyzeConfig,
  mode: OutcomeObservationMode,
  analyze: (transcript: TranscriptionResult, options: AnalyzeV2Options) => Promise<V2Result>,
): Promise<readonly OutcomeObservationResult[]> {
  const results: OutcomeObservationResult[] = [];
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    const client = strictReplayClient(recordings[index]);
    let result: V2Result;
    let audit: Readonly<{ keepFalseShipped: number; explicitGateResurrections: number }> | undefined;
    let auditCalls = 0;
    try { result = await analyze(item.transcript as TranscriptionResult, { client, cfg, sourceDurationSec: item.case.sourceDurationSec, retryDelayMs: 1,
      outcomeRecoveryAuditSink(value) {
        auditCalls += 1;
        if (auditCalls !== 1 || !exactDataObject(value, ["keepFalseShipped", "explicitGateResurrections"]) || !nonnegativeInt(value.keepFalseShipped) || !nonnegativeInt(value.explicitGateResurrections)) fail("unknown_telemetry");
        audit = Object.freeze({ keepFalseShipped: value.keepFalseShipped, explicitGateResurrections: value.explicitGateResurrections });
      },
    }); }
    catch (error) { client.assertComplete(); throw error; }
    client.assertComplete();
    results.push(projectResult(item, result, cfg, mode, audit));
  }
  return Object.freeze(results);
}

const validatedObservations = new WeakSet<object>();

export async function observeOutcomeCases(input: Readonly<{
  mode: OutcomeObservationMode;
  commitSha: string;
  config: AnalyzeConfig;
  cases: readonly OutcomeObservationCase[];
  liveLane?: MaterializedOutcomeLiveLane;
  now?: Date;
}>, dependencies: Readonly<{
  analyze?: (transcript: TranscriptionResult, options: AnalyzeV2Options) => Promise<V2Result>;
}> = {}): Promise<OutcomeObservation> {
  if ((input.mode !== "baseline" && input.mode !== "candidate") || !COMMIT.test(input.commitSha) || !Array.isArray(input.cases) || input.cases.length === 0 || !isPlain(input.config) ||
      !Number.isSafeInteger(input.config.outcomeRecoveryMaxCandidates) || input.config.outcomeRecoveryMaxCandidates < 1 || input.config.outcomeRecoveryMaxCandidates > 12 ||
      !Number.isSafeInteger(input.config.criticBatchSize) || input.config.outcomeRecoveryMaxCandidates > input.config.criticBatchSize) fail("invalid_input");
  const cfg = Object.freeze({ ...input.config, outcomeRecoveryMode: input.mode === "baseline" ? "off" : input.config.outcomeRecoveryMode }) as AnalyzeConfig;
  if (input.mode === "candidate" && cfg.outcomeRecoveryMode !== "shadow" && cfg.outcomeRecoveryMode !== "on") fail("invalid_input");
  const sorted = input.cases.map(validateCaseBinding).sort((left, right) => left.case.caseVersion.localeCompare(right.case.caseVersion));
  if (new Set(sorted.map((entry) => entry.case.caseVersion)).size !== sorted.length) fail("invalid_case");
  for (const item of sorted) {
    if (!isHash(item.case.caseVersion) || item.case.disposition === "exclude" || !Array.isArray(item.recordedResponses)) fail("invalid_case");
  }
  if (input.mode === "baseline" && input.liveLane !== undefined) fail("invalid_live_lane");
  const analyze = dependencies.analyze ?? analyzeHighlightsV2;
  let results: readonly OutcomeObservationResult[];
  let liveLaneBinding: OutcomeObservation["liveLane"];
  let recordedResponsesDigest: Sha256;
  if (input.liveLane) {
    const lane = parseLiveLane(input.liveLane, sorted, sha256(canonicalJson(cfg)), input.now ?? new Date());
    const attempts: Array<readonly OutcomeObservationResult[]> = [];
    for (const attempt of lane.attempts) attempts.push(await runCases(sorted, attempt.responses, cfg, input.mode, analyze));
    const expected = canonicalJson(attempts[0]);
    if (attempts.slice(1).some((attempt) => canonicalJson(attempt) !== expected)) fail("live_attempt_disagreement");
    results = attempts[0];
    const attemptDigests = lane.attempts.map((attempt) => attempt.digest) as [Sha256, Sha256, Sha256];
    liveLaneBinding = Object.freeze({ name: lane.name, attempts: 3, attemptDigests: Object.freeze(attemptDigests) });
    recordedResponsesDigest = sha256(canonicalJson(attemptDigests));
  } else {
    results = await runCases(sorted, sorted.map((item) => item.recordedResponses), cfg, input.mode, analyze);
    recordedResponsesDigest = sha256(canonicalJson(sorted.map(({ case: value }) => ({ caseVersion: value.caseVersion, recordedResponsesSha256: value.recordedResponsesSha256 }))));
  }
  const engineFingerprint = sha256(canonicalJson(cfg));
  const body = { schemaVersion: 1 as const, mode: input.mode, commitSha: input.commitSha, engineFingerprint, corpusDigest: corpusDigest(sorted), runnerVersion: OUTCOME_OBSERVATION_RUNNER_VERSION, recordedResponsesDigest, results, ...(liveLaneBinding ? { liveLane: liveLaneBinding } : {}) };
  const observation = Object.freeze({ ...body, observationId: sha256(canonicalJson(body)) });
  validatedObservations.add(observation);
  return observation;
}

async function readPrivate(path: string, maximum: number): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1 || (initial.mode & 0o7777) !== FILE_MODE || initial.size > maximum) fail("private_store_invalid");
    const bytes = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead; }
    const final = await handle.stat();
    if (offset !== bytes.length || final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) fail("private_store_invalid");
    return bytes;
  } catch (error) { if (error instanceof OutcomeObservationError) throw error; return fail("private_store_invalid"); }
  finally { await handle?.close().catch(() => undefined); }
}

function parseRecordings(bytes: Buffer): readonly RecordedOutcomeResponse[] {
  const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
  if (text.length === 0) return Object.freeze([]);
  if (!text.endsWith("\n")) fail("invalid_case");
  return Object.freeze(text.slice(0, -1).split("\n").map((line) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return fail("invalid_case"); }
    if (!isPlain(value) || !exactKeys(value, ["promptFingerprint", "modelFingerprint", "requestFingerprint", "result"]) || canonicalJson(value) !== line || !isHash(value.promptFingerprint) || !isHash(value.modelFingerprint) || !isHash(value.requestFingerprint) || !isPlain(value.result)) fail("invalid_case");
    return Object.freeze(value) as unknown as RecordedOutcomeResponse;
  }));
}

export async function loadOutcomeObservationCases(root: string): Promise<readonly OutcomeObservationCase[]> {
  let authority;
  try { authority = await loadOutcomeObservationAuthority(root); }
  catch { return fail("private_store_invalid"); }
  const result: OutcomeObservationCase[] = [];
  for (const item of authority) {
    try {
      result.push(Object.freeze({ case: item.case, transcript: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(item.transcriptBytes)), recordedResponses: parseRecordings(Buffer.from(item.recordedResponsesBytes)) }));
    } catch (error) { if (error instanceof OutcomeObservationError) throw error; return fail("invalid_case"); }
  }
  if (result.length === 0) fail("invalid_case");
  return Object.freeze(result);
}

async function publishOutcomeObservationAgainstAuthority(root: string, observation: OutcomeObservation, authoritativeCases: readonly OutcomeObservationCase[], loaded: readonly OutcomeObservationAuthorityCase[]): Promise<CommitResult> {
  if (!validatedObservations.has(observation as object)) fail("publication_failed");
  const observationKeys = ["schemaVersion", "observationId", "mode", "commitSha", "engineFingerprint", "corpusDigest", "runnerVersion", "recordedResponsesDigest", "results", ...(observation.liveLane ? ["liveLane"] : [])];
  if (!exactDataObject(observation, observationKeys) ||
      observation.schemaVersion !== 1 || (observation.mode !== "baseline" && observation.mode !== "candidate") ||
      !COMMIT.test(observation.commitSha) || !isHash(observation.engineFingerprint) || !isHash(observation.corpusDigest) ||
      observation.runnerVersion !== OUTCOME_OBSERVATION_RUNNER_VERSION || !isHash(observation.recordedResponsesDigest) ||
      !Array.isArray(observation.results) || observation.results.length === 0) fail("publication_failed");
  let authority: OutcomeObservationCase[];
  let expectedAuthority: OutcomeObservationCase[];
  try {
    expectedAuthority = authoritativeCases.map(validateCaseBinding).sort((left, right) => left.case.caseVersion.localeCompare(right.case.caseVersion));
    authority = loaded.map((item) => validateCaseBinding({
      case: item.case,
      transcript: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(item.transcriptBytes)),
      recordedResponses: parseRecordings(Buffer.from(item.recordedResponsesBytes)),
    })).sort((left, right) => left.case.caseVersion.localeCompare(right.case.caseVersion));
  }
  catch { return fail("publication_failed"); }
  const authorityVersions = authority.map((item) => item.case.caseVersion);
  const expectedVersions = expectedAuthority.map((item) => item.case.caseVersion);
  const resultVersions = observation.results.map((result) => result.caseVersion);
  if (canonicalJson(authority.map((item) => item.case)) !== canonicalJson(expectedAuthority.map((item) => item.case)) || expectedVersions.join("\n") !== authorityVersions.join("\n") ||
      new Set(authorityVersions).size !== authorityVersions.length || new Set(resultVersions).size !== resultVersions.length ||
      authorityVersions.join("\n") !== [...resultVersions].sort().join("\n") || corpusDigest(authority) !== observation.corpusDigest) fail("publication_failed");
  if (observation.liveLane && (!exactDataObject(observation.liveLane, ["name", "attempts", "attemptDigests"]) || !SAFE_NAME.test(observation.liveLane.name) || observation.liveLane.attempts !== 3 || !Array.isArray(observation.liveLane.attemptDigests) || observation.liveLane.attemptDigests.length !== 3 || observation.liveLane.attemptDigests.some((digest) => !isHash(digest)))) fail("publication_failed");
  for (const result of observation.results) {
    if (!exactDataObject(result, ["caseVersion", "disposition", "shippedWindows", "approvedHits", "forbiddenHits", "keepFalseShipped", "explicitGateResurrections", "candidateCap", "criticBatches", "noClipsReason"]) ||
        !isHash(result.caseVersion) || (result.disposition !== "recoverable_false_negative" && result.disposition !== "valid_empty") ||
        !Array.isArray(result.shippedWindows) || !nonnegativeInt(result.approvedHits) || !nonnegativeInt(result.forbiddenHits) ||
        !nonnegativeInt(result.keepFalseShipped) || !nonnegativeInt(result.explicitGateResurrections) || !nonnegativeInt(result.candidateCap) ||
        !nonnegativeInt(result.criticBatches) || (result.noClipsReason !== null && result.noClipsReason !== "NO_USABLE_SPEECH" && result.noClipsReason !== "NO_VIABLE_MOMENTS" && result.noClipsReason !== "PARTIAL_TRANSCRIPT")) fail("publication_failed");
    for (const window of result.shippedWindows) if (!exactDataObject(window, ["start", "end"]) || typeof window.start !== "number" || !Number.isFinite(window.start) || typeof window.end !== "number" || !Number.isFinite(window.end) || window.start < 0 || window.end <= window.start) fail("publication_failed");
  }
  const { observationId: claimedObservationId, ...body } = observation;
  if (!isHash(claimedObservationId) || sha256(canonicalJson(body)) !== claimedObservationId) fail("publication_failed");
  const bytes = Buffer.from(`${canonicalJson(observation)}\n`);
  if (bytes.byteLength > 16 * 1024 * 1024) fail("publication_failed");
  let paths: Awaited<ReturnType<typeof ensureOutcomeStore>>;
  try { paths = await ensureOutcomeStore(root); } catch { return fail("publication_failed"); }
  let observations: FileHandle | undefined;
  let temporaryName: string | undefined;
  try {
    observations = await open(paths.observationsDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stats = await observations.stat();
    if (!stats.isDirectory() || (stats.mode & 0o7777) !== DIRECTORY_MODE) fail("publication_failed");
    const finalPath = join(`/proc/self/fd/${observations.fd}`, observation.observationId);
    try {
      const existing = await open(finalPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const existingStats = await existing.stat();
        if (!existingStats.isDirectory() || (existingStats.mode & 0o7777) !== DIRECTORY_MODE) fail("publication_failed");
        const names = await readdir(`/proc/self/fd/${existing.fd}`);
        if (names.length !== 1 || names[0] !== "results.jsonl") fail("publication_failed");
        let stored: Buffer;
        try { stored = await readPrivate(join(`/proc/self/fd/${existing.fd}`, "results.jsonl"), bytes.length); }
        catch { return fail("publication_failed"); }
        if (!stored.equals(bytes)) fail("publication_failed");
        return { status: "noop" };
      } finally { await existing.close(); }
    } catch (error) {
      if (error instanceof OutcomeObservationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("publication_failed");
    }
    temporaryName = `.tmp-${randomBytes(12).toString("hex")}`;
    const temporaryPath = join(`/proc/self/fd/${observations.fd}`, temporaryName);
    await mkdir(temporaryPath, { mode: DIRECTORY_MODE });
    const temporary = await open(temporaryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const file = await open(join(`/proc/self/fd/${temporary.fd}`, "results.jsonl"), constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, FILE_MODE);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await temporary.sync();
    } finally { await temporary.close(); }
    await rename(temporaryPath, finalPath);
    temporaryName = undefined;
    await observations.sync();
    return { status: "committed" };
  } catch (error) {
    if (error instanceof OutcomeObservationError) throw error;
    return fail("publication_failed");
  } finally {
    if (temporaryName && observations) await rm(join(`/proc/self/fd/${observations.fd}`, temporaryName), { recursive: true, force: true }).catch(() => undefined);
    await observations?.close().catch(() => undefined);
  }
}

export async function publishOutcomeObservation(root: string, observation: OutcomeObservation, authoritativeCases: readonly OutcomeObservationCase[]): Promise<CommitResult> {
  try {
    return await withOutcomeObservationAuthority(root, async (authority) =>
      publishOutcomeObservationAgainstAuthority(root, observation, authoritativeCases, authority));
  } catch (error) {
    if (error instanceof OutcomeObservationError) throw error;
    return fail("publication_failed");
  }
}

export async function runOutcomeObservation(input: Readonly<{ root: string; mode: OutcomeObservationMode; commitSha: string; config: AnalyzeConfig; liveLane?: MaterializedOutcomeLiveLane }>): Promise<Readonly<{ observationId: Sha256; mode: OutcomeObservationMode; caseCount: number }>> {
  const cases = await loadOutcomeObservationCases(input.root);
  const observation = await observeOutcomeCases({ ...input, cases });
  const committed = await publishOutcomeObservation(input.root, observation, cases);
  if (committed.status !== "committed" && committed.status !== "noop") fail("publication_failed");
  return Object.freeze({ observationId: observation.observationId, mode: observation.mode, caseCount: observation.results.length });
}
