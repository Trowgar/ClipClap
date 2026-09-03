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
import { validateOutcomeStore, MAX_OUTCOME_RECORDED_RESPONSES_BYTES, MAX_OUTCOME_TRANSCRIPT_BYTES, type RecordedOutcomeResponse } from "./outcome-promote";
import { ensureOutcomeStore, readActiveOutcomeLabels } from "./outcome-store";
import { parseOutcomeCase, type OutcomeCase, type OutcomeDisposition } from "./outcome-types";
import type { CommitResult } from "./store";

const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
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
}>;

export type OutcomeObservationCase = Readonly<{
  case: OutcomeCase;
  transcript: TranscriptionResult | Readonly<Record<string, unknown>>;
  recordedResponses: readonly RecordedOutcomeResponse[];
}>;

export class OutcomeObservationError extends Error {
  readonly requiredLiveLane?: Readonly<{ attempts: 3; named: true }>;

  constructor(readonly code:
    | "invalid_input" | "invalid_case" | "missing_request" | "request_fingerprint_drift"
    | "unknown_telemetry" | "output_out_of_duration"
    | "private_store_invalid" | "publication_failed" | "live_lane_required") {
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

function strictReplayClient(recordings: readonly RecordedOutcomeResponse[]): OpenAI {
  const byRequest = new Map<string, RecordedOutcomeResponse>();
  for (const recording of recordings) {
    if (!isHash(recording.promptFingerprint) || !isHash(recording.modelFingerprint) || !isHash(recording.requestFingerprint) || !isPlain(recording.result) || byRequest.has(recording.requestFingerprint)) fail("invalid_case");
    byRequest.set(recording.requestFingerprint, recording);
  }
  const create = async (body: unknown) => {
    const fingerprint = fingerprintOutcomeRequest(body);
    const exact = byRequest.get(fingerprint.requestFingerprint);
    if (!exact) {
      const samePromptAndModel = recordings.some((entry) => entry.promptFingerprint === fingerprint.promptFingerprint && entry.modelFingerprint === fingerprint.modelFingerprint);
      if (samePromptAndModel) fail("request_fingerprint_drift");
      if (recordings.length > 0) fail("live_lane_required");
      fail("missing_request");
    }
    if (exact.promptFingerprint !== fingerprint.promptFingerprint || exact.modelFingerprint !== fingerprint.modelFingerprint) fail("request_fingerprint_drift");
    return completion(exact);
  };
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

function countMap(value: unknown, allowed: ReadonlySet<string>): boolean {
  if (!isPlain(value) || !exactDataObject(value, Object.keys(value))) return false;
  return Object.entries(value).every(([key, count]) => allowed.has(key) && nonnegativeInt(count));
}

function validateRecoveryTelemetry(value: unknown, expectedMode: "shadow" | "on"): Record<string, unknown> {
  if (!exactDataObject(value, RECOVERY_KEYS) || value.version !== "core-v4-recovery-v1" || value.mode !== expectedMode || !RECOVERY_MODES.has(value.mode as string) || typeof value.eligible !== "boolean" || !RECOVERY_REASONS.has(value.reason as string) || !RECOVERY_OUTCOMES.has(value.outcome as string)) fail("unknown_telemetry");
  for (const key of ["tailSize", "poolSize", "excludedMissingRange", "judged", "elapsedMs"] as const) if (!nonnegativeInt(value[key])) fail("unknown_telemetry");
  if (!exactDataObject(value.counters, ["selectedForFinalizer", "finalizerSurvivors"]) || !nonnegativeInt(value.counters.selectedForFinalizer) || !nonnegativeInt(value.counters.finalizerSurvivors)) fail("unknown_telemetry");
  if (!countMap(value.primaryDispositions, PRIMARY_DISPOSITIONS) || !countMap(value.recoveryDispositions, RECOVERY_DISPOSITIONS)) fail("unknown_telemetry");
  if (!exactDataObject(value.addedUsage, ["inputTokens", "outputTokens", "requests", "byModel"]) || !nonnegativeInt(value.addedUsage.inputTokens) || !nonnegativeInt(value.addedUsage.outputTokens) || !nonnegativeInt(value.addedUsage.requests) || !isPlain(value.addedUsage.byModel)) fail("unknown_telemetry");
  for (const bucket of Object.values(value.addedUsage.byModel)) if (!exactDataObject(bucket, ["inputTokens", "outputTokens", "requests"]) || !nonnegativeInt(bucket.inputTokens) || !nonnegativeInt(bucket.outputTokens) || !nonnegativeInt(bucket.requests)) fail("unknown_telemetry");
  if (!Array.isArray(value.ranges) || value.ranges.some((range) => !exactDataObject(range, ["startMs", "endMs"]) || !nonnegativeInt(range.startMs) || !nonnegativeInt(range.endMs) || range.endMs <= range.startMs)) fail("unknown_telemetry");
  return value;
}

function overlap(window: { start: number; end: number }, expected: { start: number; end: number }): boolean {
  return Math.min(window.end, expected.end) > Math.max(window.start, expected.start);
}

function projectResult(item: OutcomeObservationCase, result: V2Result, cfg: AnalyzeConfig, mode: OutcomeObservationMode): OutcomeObservationResult {
  if (item.case.disposition === "exclude") fail("invalid_case");
  if (!Array.isArray(result.highlights) || !isPlain(result.telemetry)) fail("invalid_case");
  if (result.noClipsReason !== undefined && result.noClipsReason !== "NO_USABLE_SPEECH" && result.noClipsReason !== "NO_VIABLE_MOMENTS" && result.noClipsReason !== "PARTIAL_TRANSCRIPT") fail("unknown_telemetry");
  let shippedWindows = result.highlights.map((highlight) => {
    if (!highlight || typeof highlight !== "object" || !Number.isFinite(highlight.start) || !Number.isFinite(highlight.end) || highlight.start < 0 || highlight.end <= highlight.start || highlight.end > item.case.sourceDurationSec) fail("output_out_of_duration");
    return Object.freeze({ start: highlight.start, end: highlight.end });
  });
  let criticBatches = 0;
  if (mode === "baseline") {
    if (Object.prototype.hasOwnProperty.call(result.telemetry, "outcomeRecovery")) fail("unknown_telemetry");
  } else {
    const recovery = validateRecoveryTelemetry(result.telemetry.outcomeRecovery, cfg.outcomeRecoveryMode as "shadow" | "on");
    criticBatches = (recovery.poolSize as number) === 0 ? 0 : Math.ceil((recovery.poolSize as number) / cfg.criticBatchSize);
    if (criticBatches > 1) fail("unknown_telemetry");
    // Shadow returns the primary empty set; its bounded geometry is the
    // candidate output under evaluation, never a customer-visible claim.
    if (cfg.outcomeRecoveryMode === "shadow" && recovery.outcome === "shadow_hit") {
      shippedWindows = (recovery.ranges as Array<{ startMs: number; endMs: number }>).map((range) => Object.freeze({ start: range.startMs / 1000, end: range.endMs / 1000 }));
      if (shippedWindows.some((window) => window.end > item.case.sourceDurationSec)) fail("output_out_of_duration");
    }
  }
  return Object.freeze({
    caseVersion: item.case.caseVersion,
    disposition: item.case.disposition,
    shippedWindows: Object.freeze(shippedWindows),
    approvedHits: item.case.expected.approvedWindows.filter((expected) => shippedWindows.some((window) => overlap(window, expected))).length,
    forbiddenHits: item.case.expected.forbiddenWindows.filter((expected) => shippedWindows.some((window) => overlap(window, expected))).length,
    keepFalseShipped: 0,
    explicitGateResurrections: 0,
    candidateCap: mode === "baseline" ? 0 : cfg.outcomeRecoveryMaxCandidates,
    criticBatches,
    noClipsReason: result.noClipsReason ?? null,
  });
}

export async function observeOutcomeCases(input: Readonly<{
  mode: OutcomeObservationMode;
  commitSha: string;
  config: AnalyzeConfig;
  cases: readonly OutcomeObservationCase[];
}>, dependencies: Readonly<{
  analyze?: (transcript: TranscriptionResult, options: AnalyzeV2Options) => Promise<V2Result>;
}> = {}): Promise<OutcomeObservation> {
  if ((input.mode !== "baseline" && input.mode !== "candidate") || !COMMIT.test(input.commitSha) || !Array.isArray(input.cases) || input.cases.length === 0 || !isPlain(input.config)) fail("invalid_input");
  const cfg = Object.freeze({ ...input.config, outcomeRecoveryMode: input.mode === "baseline" ? "off" : input.config.outcomeRecoveryMode }) as AnalyzeConfig;
  if (input.mode === "candidate" && cfg.outcomeRecoveryMode !== "shadow" && cfg.outcomeRecoveryMode !== "on") fail("invalid_input");
  const sorted = [...input.cases].sort((left, right) => left.case.caseVersion.localeCompare(right.case.caseVersion));
  if (new Set(sorted.map((entry) => entry.case.caseVersion)).size !== sorted.length) fail("invalid_case");
  const results: OutcomeObservationResult[] = [];
  for (const item of sorted) {
    if (!isHash(item.case.caseVersion) || item.case.disposition === "exclude" || !Array.isArray(item.recordedResponses)) fail("invalid_case");
    const client = strictReplayClient(item.recordedResponses);
    const result = await (dependencies.analyze ?? analyzeHighlightsV2)(item.transcript as TranscriptionResult, { client, cfg, sourceDurationSec: item.case.sourceDurationSec, retryDelayMs: 1 });
    results.push(projectResult(item, result, cfg, input.mode));
  }
  const engineFingerprint = sha256(canonicalJson(cfg));
  const corpusDigest = sha256(canonicalJson(sorted.map(({ case: value }) => ({ caseVersion: value.caseVersion, transcriptSha256: value.transcriptSha256, sourceSha256: value.sourceSha256, expected: value.expected, disposition: value.disposition }))));
  const recordedResponsesDigest = sha256(canonicalJson(sorted.map(({ case: value }) => ({ caseVersion: value.caseVersion, recordedResponsesSha256: value.recordedResponsesSha256 }))));
  const body = { schemaVersion: 1 as const, mode: input.mode, commitSha: input.commitSha, engineFingerprint, corpusDigest, runnerVersion: OUTCOME_OBSERVATION_RUNNER_VERSION, recordedResponsesDigest, results: Object.freeze(results) };
  return Object.freeze({ ...body, observationId: sha256(canonicalJson(body)) });
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
  if (text.length === 0 || !text.endsWith("\n")) fail("invalid_case");
  return Object.freeze(text.slice(0, -1).split("\n").map((line) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return fail("invalid_case"); }
    if (!isPlain(value) || !exactKeys(value, ["promptFingerprint", "modelFingerprint", "requestFingerprint", "result"]) || canonicalJson(value) !== line || !isHash(value.promptFingerprint) || !isHash(value.modelFingerprint) || !isHash(value.requestFingerprint) || !isPlain(value.result)) fail("invalid_case");
    return Object.freeze(value) as unknown as RecordedOutcomeResponse;
  }));
}

export async function loadOutcomeObservationCases(root: string): Promise<readonly OutcomeObservationCase[]> {
  const validation = await validateOutcomeStore(root);
  if (validation.status !== "valid") fail("private_store_invalid");
  const labels = (await readActiveOutcomeLabels(root)).filter((label) => label.disposition !== "exclude").sort((a, b) => a.caseVersion.localeCompare(b.caseVersion));
  const result: OutcomeObservationCase[] = [];
  for (const label of labels) {
    const directory = join(root, "cases", label.caseVersion);
    const [caseBytes, transcriptBytes, responseBytes] = await Promise.all([
      readPrivate(join(directory, "case.json"), 1024 * 1024),
      readPrivate(join(directory, "transcript.json"), MAX_OUTCOME_TRANSCRIPT_BYTES),
      readPrivate(join(directory, "recorded-responses.jsonl"), MAX_OUTCOME_RECORDED_RESPONSES_BYTES),
    ]);
    try {
      const parsed = parseOutcomeCase(JSON.parse(caseBytes.toString("utf8")));
      if (`${canonicalJson(parsed)}\n` !== caseBytes.toString("utf8") || parsed.caseVersion !== label.caseVersion || sha256(transcriptBytes) !== parsed.transcriptSha256 || sha256(responseBytes) !== parsed.recordedResponsesSha256) fail("invalid_case");
      result.push(Object.freeze({ case: parsed, transcript: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(transcriptBytes)), recordedResponses: parseRecordings(responseBytes) }));
    } catch (error) { if (error instanceof OutcomeObservationError) throw error; return fail("invalid_case"); }
  }
  if (result.length === 0) fail("invalid_case");
  return Object.freeze(result);
}

export async function publishOutcomeObservation(root: string, observation: OutcomeObservation): Promise<CommitResult> {
  if (!exactDataObject(observation, ["schemaVersion", "observationId", "mode", "commitSha", "engineFingerprint", "corpusDigest", "runnerVersion", "recordedResponsesDigest", "results"]) ||
      observation.schemaVersion !== 1 || (observation.mode !== "baseline" && observation.mode !== "candidate") ||
      !COMMIT.test(observation.commitSha) || !isHash(observation.engineFingerprint) || !isHash(observation.corpusDigest) ||
      observation.runnerVersion !== OUTCOME_OBSERVATION_RUNNER_VERSION || !isHash(observation.recordedResponsesDigest) ||
      !Array.isArray(observation.results) || observation.results.length === 0) fail("publication_failed");
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

export async function runOutcomeObservation(input: Readonly<{ root: string; mode: OutcomeObservationMode; commitSha: string; config: AnalyzeConfig }>): Promise<Readonly<{ observationId: Sha256; mode: OutcomeObservationMode; caseCount: number }>> {
  const cases = await loadOutcomeObservationCases(input.root);
  const observation = await observeOutcomeCases({ ...input, cases });
  const committed = await publishOutcomeObservation(input.root, observation);
  if (committed.status !== "committed" && committed.status !== "noop") fail("publication_failed");
  return Object.freeze({ observationId: observation.observationId, mode: observation.mode, caseCount: observation.results.length });
}
