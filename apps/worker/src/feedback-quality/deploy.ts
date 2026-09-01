import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { Queue } from "bullmq";
import { getRedis } from "@clipclap/shared/lib/redis";
import { deriveQualityCorpusDigest } from "./observe";
import { effectiveConfigDigest, QUALITY_RUNNER_VERSION, readSecureConfig, validateSecureConfig } from "./config";
import { GATE_REASON_ORDER, readGateDecision } from "./gate";
import type { GateAggregate } from "./types";
import {
  appendLabelEvent,
  contentId,
  DEFAULT_QUALITY_ROOT,
  type CommitResult,
} from "./store";

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { shell: false, timeout: 30_000, maxBuffer: 1024 * 1024 } as const;
const COMMIT = /^[0-9a-f]{40}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const DECISION_ID = /^decision:sha256:[0-9a-f]{64}$/;
const SERVICE_ORDER = ["worker-download", "worker-transcribe", "worker-analyze", "worker-render", "worker-finalize"] as const;
export const QUEUE_NAMES = { download: "video-download", transcribe: "video-transcribe", analyze: "video-analyze", render: "video-render", finalize: "video-finalize" } as const;
type StageName = keyof typeof QUEUE_NAMES;
const SERVICE_STAGE: Readonly<Record<WorkerService, StageName>> = {
  "worker-download": "download",
  "worker-transcribe": "transcribe",
  "worker-analyze": "analyze",
  "worker-render": "render",
  "worker-finalize": "finalize",
};
const REASONS = [
  "invalid_request", "invalid_decision", "decision_expired", "decision_not_pass", "binding_mismatch", "dirty_tree", "rollback_unavailable",
  "invalid_service", "queue_nonempty", "queue_read_failed", "process_failed", "health_failed", "canary_failed",
  "invalid_override", "event_failed",
] as const;

export type DeployReason = (typeof REASONS)[number];
export type WorkerService = (typeof SERVICE_ORDER)[number];

export type GateDeployDecision = Readonly<{
  schemaVersion: 1;
  decisionId: string;
  claim: "improvement" | "non_regression_only";
  policyVersion: string;
  candidateCommitSha: string;
  configSha256: string;
  corpusSha256: string;
  runnerVersion: number;
  baselineEvalObservationId: string;
  candidateEvalObservationId: string;
  baselineHoldoutObservationId: string;
  candidateHoldoutObservationId: string;
  createdAt: string;
  expiresAt: string;
  eval: GateDecisionSummary;
  holdout: GateDecisionSummary;
  verdict: "pass" | "fail";
  reasons: readonly string[];
}>;

/** Public alias matching the gate module's terminology for callers that
 * consume a decision without importing the decision-generation module. */
export type GateDecision = GateDeployDecision;

export type GateDecisionSummary = Readonly<{
  positiveCount: number;
  negativeCount: number;
  attemptCount: number;
  varianceCaseCount: number;
  baseline: GateAggregate;
  candidate: GateAggregate;
}>;

export type DeployRequest = Readonly<{
  decisionId: string;
  services: readonly string[];
  overrideReasonFile?: string;
}>;

export type QueueCounts = Readonly<{
  active: number;
  waiting: number;
  delayed?: number;
  paused?: number;
  prioritized?: number;
  waitingChildren?: number;
}>;
export type QueueLease = Readonly<{
  pause: () => Promise<void>;
  counts: () => Promise<QueueCounts>;
  /** True for the production adapter, which drains active jobs while fenced. */
  drainActive?: boolean;
  /** BullMQ moves jobs added after the fence into paused; they are held until resume. */
  allowPostFencePaused?: boolean;
  assertOwnership?: () => Promise<void>;
  runCanary?: (service: WorkerService, expected: Readonly<{ decisionId: string; commitSha: string; configSha256: string; runnerVersion: number; rolloutInstanceId: string }>) => Promise<void>;
  resume: () => Promise<void>;
}>;
export type GitState = Readonly<{ head: string; dirtyTracked: boolean }>;
export type ProcessResult = Readonly<{ exitCode: number }>;
export type SpawnOptions = Readonly<{ env: Readonly<Record<string, string | undefined>> }>;

export type DeployDependencies = Readonly<{
  root?: string;
  now?: () => Date;
  operator?: string;
  readDecision?: (decisionId: string, root: string) => Promise<GateDeployDecision>;
  gitState?: () => Promise<GitState>;
  configSha256?: () => Promise<string>;
  effectiveConfig?: () => Promise<unknown>;
  environment?: Readonly<Record<string, string | null | undefined>>;
  configFile?: string;
  /** Container path for the read-only mounted config in an immutable compose deployment. */
  configFileContainer?: string;
  corpusSha256?: () => Promise<string>;
  runnerVersion?: () => Promise<number>; // Test seam; production uses QUALITY_RUNNER_VERSION.
  queueCounts?: (queueName: string) => Promise<QueueCounts>;
  acquireQueueLease?: (queueName: string) => Promise<QueueLease>;
  spawn?: (argv: readonly string[]) => Promise<ProcessResult>;
  /** Production-only adapter: receives the immutable compose environment. */
  spawnProduction?: (argv: readonly string[], environment: Readonly<Record<string, string | undefined>>) => Promise<ProcessResult>;
  waitForHealthy?: (service: WorkerService) => Promise<void>;
  runCanary?: (service: WorkerService, expected: Readonly<{ decisionId: string; commitSha: string; configSha256: string; runnerVersion: number; rolloutInstanceId: string }>) => Promise<void>;
  prepareRollback?: (services: readonly WorkerService[], decision: GateDeployDecision) => Promise<RollbackArtifact>;
  canaryTimeoutMs?: number;
  appendEvent?: (event: Readonly<Record<string, unknown>>, root: string) => Promise<CommitResult>;
}>;

export type RollbackArtifact = Readonly<{
  schemaVersion: 1;
  artifactId: string;
  createdAt: string;
  command: readonly string[];
  previousCommitSha: string;
  previousImageRef: string;
  previousImageDigest: string;
  composeFiles: readonly string[];
  composeFilesSha256: string;
  services: readonly WorkerService[];
  previousImages?: readonly Readonly<{ service: WorkerService; image: string; digest: string; revision: string }>[];
  projectName?: string;
  network?: string;
  candidateImage?: string;
}>;

export type DeployResult = Readonly<{
  status: "deployed" | "failed";
  verdict: "pass" | "fail";
  decisionId: string;
  overridden: boolean;
  services: readonly WorkerService[];
  recreatedServices: readonly WorkerService[];
  reasons: readonly DeployReason[];
  rollbackArgv?: readonly string[];
  rollbackArtifactId?: string;
}>;

export class DeployError extends Error {
  constructor(readonly code: DeployReason) {
    super(code);
    this.name = "DeployError";
  }
}

function ownKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) => {
    if (typeof key !== "string" || !expected.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value");
  });
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function utc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function safeHash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }

function validSummary(value: unknown): value is GateDecisionSummary {
  if (!plain(value)) return false;
  const keys = ["positiveCount", "negativeCount", "attemptCount", "varianceCaseCount", "baseline", "candidate"];
  if (!ownKeys(value, keys) || ![value.positiveCount, value.negativeCount, value.attemptCount, value.varianceCaseCount].every((item) => Number.isSafeInteger(item) && (item as number) >= 0)) return false;
  for (const aggregate of [value.baseline, value.candidate]) {
    if (!plain(aggregate)) return false;
    const aggregateKeys = ["positiveRetention", "negativeDefects", "zeroClipFalseNegatives", "boundaryErrors", "focalFailures", "subtitleFailures"];
    if (!ownKeys(aggregate, aggregateKeys)) return false;
    for (const key of aggregateKeys) if (!finite(aggregate[key])) return false;
  }
  return true;
}

function validateDecision(value: unknown, requestedId: string): GateDeployDecision {
  if (!plain(value)) throw new DeployError("invalid_decision");
  const keys = ["schemaVersion", "decisionId", "claim", "policyVersion", "candidateCommitSha", "configSha256", "corpusSha256", "runnerVersion", "baselineEvalObservationId", "candidateEvalObservationId", "baselineHoldoutObservationId", "candidateHoldoutObservationId", "createdAt", "expiresAt", "eval", "holdout", "verdict", "reasons"];
  if (!ownKeys(value, keys) || value.schemaVersion !== 1 || value.decisionId !== requestedId || !DECISION_ID.test(requestedId) ||
      (value.claim !== "improvement" && value.claim !== "non_regression_only") || typeof value.policyVersion !== "string" || value.policyVersion.length === 0 ||
      typeof value.candidateCommitSha !== "string" || !COMMIT.test(value.candidateCommitSha) || !safeHash(value.configSha256) || !safeHash(value.corpusSha256) ||
      !Number.isSafeInteger(value.runnerVersion) || (value.runnerVersion as number) < 0 ||
      ![value.baselineEvalObservationId, value.candidateEvalObservationId, value.baselineHoldoutObservationId, value.candidateHoldoutObservationId].every((item) => typeof item === "string" && /^observation:sha256:[0-9a-f]{64}$/.test(item)) ||
      !utc(value.createdAt) || !utc(value.expiresAt) || (value.verdict !== "pass" && value.verdict !== "fail") || !Array.isArray(value.reasons) || value.reasons.some((item) => typeof item !== "string") || !validSummary(value.eval) || !validSummary(value.holdout)) throw new DeployError("invalid_decision");
  const { decisionId, ...body } = value;
  try { if (contentId("decision", body) !== decisionId) throw new DeployError("invalid_decision"); } catch { throw new DeployError("invalid_decision"); }
  const reasons = value.reasons as readonly string[];
  const reasonIndexes = reasons.map((reason) => GATE_REASON_ORDER.indexOf(reason as never));
  const created = new Date(value.createdAt as string).getTime();
  const expires = new Date(value.expiresAt as string).getTime();
  if (reasonIndexes.some((index) => index < 0) || new Set(reasons).size !== reasons.length || reasonIndexes.some((index, position) => position > 0 && index <= reasonIndexes[position - 1]) || (value.verdict === "pass" && reasons.length !== 0) || (value.verdict === "fail" && reasons.length === 0) || expires <= created || expires > created + 24 * 60 * 60 * 1000) throw new DeployError("invalid_decision");
  return value as unknown as GateDeployDecision;
}

function validServices(requested: readonly string[]): requested is readonly WorkerService[] {
  if (!Array.isArray(requested) || requested.length === 0 || requested.some((service) => typeof service !== "string")) return false;
  const indexes = requested.map((service) => SERVICE_ORDER.indexOf(service as WorkerService));
  return indexes.every((index) => index >= 0) && new Set(indexes).size === indexes.length && indexes.every((index, position) => position === 0 || index > indexes[position - 1]);
}

function result(request: DeployRequest, services: readonly WorkerService[], reasons: readonly DeployReason[], recreated: readonly WorkerService[] = [], overridden = false, rollback?: RollbackArtifact): DeployResult {
  return Object.freeze({ status: "failed" as const, verdict: "fail" as const, decisionId: request.decisionId, overridden, services, recreatedServices: recreated, reasons: [...new Set(reasons)], ...(rollback ? { rollbackArgv: [...rollback.command], rollbackArtifactId: rollback.artifactId } : {}) });
}

function validRollback(value: unknown, services: readonly WorkerService[]): value is RollbackArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const standardKeys = ["schemaVersion", "artifactId", "createdAt", "command", "previousCommitSha", "previousImageRef", "previousImageDigest", "composeFiles", "composeFilesSha256", "services"];
  const keys = Reflect.ownKeys(item);
  const hasPreviousImages = Object.prototype.hasOwnProperty.call(item, "previousImages");
  const releaseKeys = ["previousImages", "projectName", "network", "candidateImage"];
  const exactKeys = keys.length === standardKeys.length + releaseKeys.filter((key) => Object.prototype.hasOwnProperty.call(item, key)).length && keys.every((key) => typeof key === "string" && [...standardKeys, ...releaseKeys].includes(key));
  const oldImagesValid = !hasPreviousImages || (Array.isArray(item.previousImages) && item.previousImages.length === (item.services as unknown[]).length && item.previousImages.every((value) => plain(value) && ownKeys(value, ["service", "image", "digest", "revision"]) && typeof value.service === "string" && SERVICE_ORDER.includes(value.service as WorkerService) && typeof value.image === "string" && value.image.endsWith(`@${value.digest}`) && typeof value.digest === "string" && HASH.test(value.digest) && typeof value.revision === "string" && COMMIT.test(value.revision)));
  const releaseValid = !hasPreviousImages || (typeof item.projectName === "string" && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(item.projectName) && typeof item.network === "string" && /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(item.network) && typeof item.candidateImage === "string" && item.candidateImage.includes("@sha256:"));
  const initialValid = exactKeys && oldImagesValid && releaseValid && item.schemaVersion === 1 && typeof item.artifactId === "string" && /^rollback:sha256:[0-9a-f]{64}$/.test(item.artifactId) && utc(item.createdAt) && typeof item.previousCommitSha === "string" && COMMIT.test(item.previousCommitSha) && typeof item.previousImageDigest === "string" && HASH.test(item.previousImageDigest) && typeof item.previousImageRef === "string" && item.previousImageRef.endsWith(`@${item.previousImageDigest}`) && Array.isArray(item.composeFiles) && item.composeFiles.length > 0 && !item.composeFiles.some((file) => typeof file !== "string" || file.length === 0 || file.startsWith("/") || file.includes("\\") || file.includes("\0") || file.split("/").some((segment) => segment === ".." || segment === "") || /[\r\n]/.test(file)) && typeof item.composeFilesSha256 === "string" && HASH.test(item.composeFilesSha256) && Array.isArray(item.services) && !item.services.some((service) => !SERVICE_ORDER.includes(service as WorkerService)) && Array.isArray(item.command) && item.command.length >= 6 && !item.command.some((part) => typeof part !== "string" || part.length === 0 || /[\0\n\r]/.test(part));
  if (!initialValid) return false;
  const checked = item as unknown as RollbackArtifact;
  const composeArgs: string[] = [];
  for (const file of checked.composeFiles) composeArgs.push("-f", file);
  const commandPrefix = checked.previousImages === undefined
    ? ["docker", "compose", ...composeArgs, "up", "-d", "--force-recreate", "--no-build"]
    : ["docker", "compose", "--project-name", checked.projectName!, "-f", "rollback.compose.yml", "up", "-d", "--force-recreate", "--no-build"];
  if (checked.command.length <= commandPrefix.length || JSON.stringify(checked.command.slice(0, commandPrefix.length)) !== JSON.stringify(commandPrefix)) return false;
  const targetServices = checked.command.slice(commandPrefix.length);
  const indexes = targetServices.map((service) => SERVICE_ORDER.indexOf(service as WorkerService));
  const body = { createdAt: checked.createdAt, command: checked.command, previousCommitSha: checked.previousCommitSha, previousImageRef: checked.previousImageRef, previousImageDigest: checked.previousImageDigest, composeFiles: checked.composeFiles, composeFilesSha256: checked.composeFilesSha256, services: checked.services, ...(checked.previousImages === undefined ? {} : { previousImages: checked.previousImages, projectName: checked.projectName, network: checked.network, candidateImage: checked.candidateImage }) };
  const valid = targetServices.length > 0 && indexes.every((index) => index >= 0) && indexes.every((index, position) => position === 0 || index > indexes[position - 1]) && new Set(targetServices).size === targetServices.length && JSON.stringify(checked.services) === JSON.stringify(services) && sha256(canonicalJson(body)) === checked.artifactId.slice("rollback:".length) && JSON.stringify(targetServices) === JSON.stringify(services);
  return valid;
}

async function secureReason(path: string): Promise<{ text: string; digest: string }> {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) throw new DeployError("invalid_override");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size === 0 || info.size > 16 * 1024) throw new DeployError("invalid_override");
    const bytes = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const final = await handle.stat();
    if (offset !== info.size || final.size !== info.size || final.nlink !== 1) throw new DeployError("invalid_override");
    const text = bytes.toString("utf8");
    if (!text.trim()) throw new DeployError("invalid_override");
    return { text, digest: sha256(bytes) };
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw new DeployError("invalid_override");
  } finally { await handle?.close().catch(() => undefined); }
}

async function defaultReadDecision(id: string, root: string): Promise<GateDeployDecision> {
  try { return await readGateDecision(id, root); }
  catch { throw new DeployError("invalid_decision"); }
}

async function defaultGitState(): Promise<GitState> {
  try {
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], EXEC_OPTIONS)).stdout.trim();
    const dirtyTracked = Boolean((await execFileAsync("git", ["status", "--porcelain", "--untracked-files=no"], EXEC_OPTIONS)).stdout.trim());
    if (!COMMIT.test(head)) throw new Error();
    return { head, dirtyTracked };
  } catch { throw new DeployError("binding_mismatch"); }
}

async function effectiveConfigFromFile(path: string | undefined): Promise<unknown> {
  if (!path) throw new DeployError("binding_mismatch");
  try { return validateSecureConfig(await readSecureConfig(path), true); }
  catch { throw new DeployError("binding_mismatch"); }
}

async function defaultQueueCounts(queueName: string): Promise<QueueCounts> {
  try {
    const queue = Object.values(QUEUE_NAMES).includes(queueName as (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES])
      ? new Queue(queueName, { connection: getRedis() })
      : undefined;
    if (!queue) throw new Error();
    try {
      const counts = await queue.getJobCounts("active", "waiting", "delayed", "paused", "prioritized", "waiting-children");
      const result = {
        active: counts.active ?? 0,
        waiting: counts.waiting ?? 0,
        delayed: counts.delayed ?? 0,
        paused: counts.paused ?? 0,
        prioritized: counts.prioritized ?? 0,
        waitingChildren: counts["waiting-children"] ?? 0,
      };
      if (!Object.values(result).every((item) => Number.isSafeInteger(item) && item >= 0)) throw new Error();
      return result;
    } finally { await queue.close().catch(() => undefined); }
  } catch { throw new DeployError("queue_read_failed"); }
}

async function defaultCanary(service: WorkerService, expected: Readonly<{ decisionId: string; commitSha: string; configSha256: string; runnerVersion: number; rolloutInstanceId: string }>, timeoutMs = 30_000, suppliedQueue?: Queue): Promise<void> {
  const stage = SERVICE_STAGE[service];
  const queue = suppliedQueue ?? new Queue(QUEUE_NAMES[stage], { connection: getRedis() });
  const nonce = randomUUID();
  let job: Awaited<ReturnType<typeof queue.add>> | undefined;
  try {
    job = await queue.add("feedback-quality-canary", { kind: "feedback-quality-canary", nonce, decisionId: expected.decisionId, rolloutInstanceId: expected.rolloutInstanceId }, { attempts: 1, priority: 0, removeOnComplete: true, removeOnFail: true });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await queue.getJob(job.id!);
      const state = await current?.getState();
      if (state === "completed") {
        const value = current?.returnvalue as Record<string, unknown> | undefined;
        if (!value || value.kind !== "feedback-quality-canary" || value.nonce !== nonce || value.decisionId !== expected.decisionId || value.rolloutInstanceId !== expected.rolloutInstanceId || value.role !== stage || value.configSha256 !== expected.configSha256 || value.runnerVersion !== expected.runnerVersion || value.commitSha !== expected.commitSha) throw new DeployError("canary_failed");
        return;
      }
      if (state === "failed") throw new DeployError("canary_failed");
      if (Date.now() >= deadline) throw new DeployError("canary_failed");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw new DeployError("canary_failed");
  } finally {
    // Control jobs contain rollout bindings. They are not audit records and
    // must not linger on either a success or a failed attestation.
    try { const current = await queue.getJob(job?.id ?? ""); await current?.remove(); } catch { /* best-effort cleanup */ }
    if (!suppliedQueue) await queue.close().catch(() => undefined);
  }
}

async function defaultQueueLease(queueName: string, timeoutMs = 30_000): Promise<QueueLease> {
  if (!Object.values(QUEUE_NAMES).includes(queueName as (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES])) throw new DeployError("queue_read_failed");
  const queue = new Queue(queueName, { connection: getRedis() });
  const canaryQueue = new Queue(`${queueName}:quality-canary`, { connection: getRedis() });
  const redis = getRedis();
  const fenceKey = `clipclap:feedback-quality:fence:${queueName}`;
  const fenceToken = randomUUID();
  let fenceHeld = false;
  let fenceLost = false;
  let paused = false;
  let wasPaused = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const assertFence = async () => {
    if (fenceLost || !fenceHeld || await redis.get(fenceKey) !== fenceToken) {
      fenceLost = true;
      throw new DeployError("queue_read_failed");
    }
  };
  const renewFence = async () => {
    if (!fenceHeld || fenceLost) return;
    const renewed = await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end", 1, fenceKey, fenceToken, String(Math.max(120_000, timeoutMs * 4)));
    if (Number(renewed) !== 1) fenceLost = true;
  };
  const startHeartbeat = () => {
    heartbeat = setInterval(() => { void renewFence().catch(() => { fenceLost = true; }); }, Math.max(1_000, Math.floor(Math.max(120_000, timeoutMs * 4) / 3)));
    heartbeat.unref?.();
  };
  const stopHeartbeat = () => { if (heartbeat) clearInterval(heartbeat); heartbeat = undefined; };
  const readCounts = async (): Promise<QueueCounts> => {
    const counts = await queue.getJobCounts("active", "waiting", "delayed", "paused", "prioritized", "waiting-children");
    const result = {
      active: counts.active ?? 0,
      waiting: counts.waiting ?? 0,
      delayed: counts.delayed ?? 0,
      paused: counts.paused ?? 0,
      prioritized: counts.prioritized ?? 0,
      waitingChildren: counts["waiting-children"] ?? 0,
    };
    if (!Object.values(result).every((item) => Number.isSafeInteger(item) && item >= 0)) throw new DeployError("queue_read_failed");
    return result;
  };
  const releaseFence = async () => {
    stopHeartbeat();
    if (!fenceHeld) return;
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, fenceKey, fenceToken);
    fenceHeld = false;
  };
  return {
    pause: async () => {
      wasPaused = await queue.isPaused();
      if (wasPaused) throw new DeployError("queue_read_failed");
      const acquired = await redis.set(fenceKey, fenceToken, "PX", Math.max(120_000, timeoutMs * 4), "NX");
      if (acquired !== "OK") throw new DeployError("queue_read_failed");
      fenceHeld = true;
      try {
        // Establish the watermark while owning the fence. Existing pending
        // work is rejected before BullMQ moves waiting jobs to `paused`.
        // The Redis token serializes deployers only; it does not claim that
        // producers authenticate against it. BullMQ's global pause is the
        // execution fence, so jobs submitted after pause remain held.
        const before = await readCounts();
        if (before.waiting !== 0 || before.delayed !== 0 || before.paused !== 0 || before.prioritized !== 0 || before.waitingChildren !== 0) throw new DeployError("queue_nonempty");
        if (await queue.isPaused()) throw new DeployError("queue_read_failed");
        paused = true;
        await queue.pause();
        if (!(await queue.isPaused())) throw new DeployError("queue_read_failed");
        startHeartbeat();
      }
      catch (error) {
        try { if (!wasPaused && paused && await queue.isPaused()) { await queue.resume(); if (await queue.isPaused()) throw new DeployError("queue_read_failed"); paused = false; } }
        catch (recoveryError) { error = recoveryError; }
        await releaseFence().catch(() => undefined);
        throw error;
      }
    },
    drainActive: true,
    allowPostFencePaused: true,
    assertOwnership: assertFence,
    counts: async () => {
      await assertFence();
      return readCounts();
    },
    runCanary: async (service, expected) => {
      // Canary traffic has its own control queue. The production queue remains
      // fenced for the whole recreate/health/canary sequence.
      await assertFence();
      await defaultCanary(service, expected, timeoutMs, canaryQueue);
    },
    resume: async () => {
      try {
        await assertFence();
        if (paused && !wasPaused) {
          await queue.resume();
          if (await queue.isPaused()) throw new DeployError("queue_read_failed");
          paused = false;
        }
      }
      finally {
        await releaseFence().catch(() => undefined);
        await canaryQueue.close().catch(() => undefined);
        await queue.close().catch(() => undefined);
      }
    },
  };
}

async function legacyQueueLease(queueName: string, dependencies: DeployDependencies, service: WorkerService, expected: Readonly<{ decisionId: string; commitSha: string; configSha256: string; runnerVersion: number; rolloutInstanceId: string }>): Promise<QueueLease> {
  const counts = dependencies.queueCounts ?? defaultQueueCounts;
  return {
    drainActive: false,
    pause: async () => undefined,
    counts: () => counts(queueName),
    runCanary: dependencies.runCanary ? () => dependencies.runCanary!(service, expected) : undefined,
    resume: async () => undefined,
  };
}

async function defaultSpawn(argv: readonly string[], options?: SpawnOptions): Promise<ProcessResult> {
  if (argv.length !== 6 || argv[0] !== "docker" || argv[1] !== "compose" || argv[2] !== "up" || argv[3] !== "-d" || argv[4] !== "--force-recreate" || !SERVICE_ORDER.includes(argv[5] as WorkerService)) throw new DeployError("invalid_request");
  try { await execFileAsync(argv[0], argv.slice(1), { ...EXEC_OPTIONS, env: options ? { ...process.env, ...options.env } : process.env }); return { exitCode: 0 }; }
  catch { return { exitCode: 1 }; }
}

async function defaultHealth(service: WorkerService): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const result = await execFileAsync("docker", ["compose", "ps", "--format", "json", "--status", "running", service], { shell: false, timeout: 5_000, maxBuffer: 1024 * 1024 });
      const output = String(result.stdout ?? "");
      if (output.includes(service) && !/"Health"\s*:\s*"unhealthy"|health[=: ]+unhealthy/i.test(output)) return;
    } catch { /* bounded retry */ }
    if (Date.now() >= deadline) throw new DeployError("health_failed");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function defaultRollback(): Promise<RollbackArtifact> {
  // The current compose file bind-mounts source and does not expose an
  // immutable previous image/digest. Continuing would make rollback a lie.
  throw new DeployError("rollback_unavailable");
}

async function appendDefault(event: Readonly<Record<string, unknown>>, root: string): Promise<CommitResult> {
  return appendLabelEvent({ eventId: String(event.eventId), ...event }, root);
}

export async function deployWithQualityGate(request: DeployRequest, dependencies: DeployDependencies = {}): Promise<DeployResult> {
  const requested = request && Array.isArray(request.services) ? request.services : [];
  const services = requested as readonly WorkerService[];
  if (!request || !Array.isArray(request.services) || typeof request.decisionId !== "string" || !DECISION_ID.test(request.decisionId)) return result(request ?? { decisionId: "", services: [] }, services, ["invalid_request"]);
  if (!validServices(requested)) return result(request, services, ["invalid_service"]);
  if (request.overrideReasonFile !== undefined && typeof request.overrideReasonFile !== "string") return result(request, services, ["invalid_override"]);
  const root = dependencies.root ?? DEFAULT_QUALITY_ROOT;
  let decision: GateDeployDecision;
  try { decision = await (dependencies.readDecision ?? defaultReadDecision)(request.decisionId, root); decision = validateDecision(decision, request.decisionId); }
  catch (error) { return result(request, services, [error instanceof DeployError ? error.code : "invalid_decision"]); }

  const mismatches: DeployReason[] = [];
  let actualCommitSha: string | undefined;
  let actualConfigSha256: string | undefined;
  let actualCorpusSha256: string | undefined;
  let actualRunnerVersion: number | undefined;
  let runtimeEnvironment: Readonly<Record<string, string | null | undefined>> = dependencies.environment ?? process.env;
  let runtimeConfig: { envAllowlist: readonly string[] } | undefined;
  const now = dependencies.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) mismatches.push("binding_mismatch");
  if (decision.verdict !== "pass") mismatches.push("decision_not_pass");
  if (new Date(decision.expiresAt).getTime() <= now.getTime()) mismatches.push("decision_expired");
  try {
    const state = await (dependencies.gitState ?? defaultGitState)();
    actualCommitSha = state.head;
    if (state.head !== decision.candidateCommitSha) mismatches.push("binding_mismatch");
    if (state.dirtyTracked) mismatches.push("dirty_tree");
    const config = dependencies.configSha256
      ? await dependencies.configSha256()
      : (() => {
        const loaded = dependencies.effectiveConfig ? dependencies.effectiveConfig() : effectiveConfigFromFile(dependencies.configFile ?? process.env.FEEDBACK_QUALITY_CONFIG_FILE);
        return loaded.then((value) => {
          runtimeConfig = value as { envAllowlist: readonly string[] };
          return effectiveConfigDigest(value, runtimeEnvironment);
        });
      })();
    const resolvedConfig = await config;
    const corpus = dependencies.corpusSha256 ? await dependencies.corpusSha256() : await deriveQualityCorpusDigest(root);
    const runner = dependencies.runnerVersion ? await dependencies.runnerVersion() : QUALITY_RUNNER_VERSION;
    actualConfigSha256 = resolvedConfig; actualCorpusSha256 = corpus; actualRunnerVersion = runner;
    if (resolvedConfig !== decision.configSha256 || corpus !== decision.corpusSha256 || runner !== decision.runnerVersion) mismatches.push("binding_mismatch");
  } catch (error) { mismatches.push(error instanceof DeployError ? error.code : "binding_mismatch"); }

  let reason: { text: string; digest: string } | undefined;
  if (request.overrideReasonFile !== undefined) {
    try { reason = await secureReason(request.overrideReasonFile); } catch { return result(request, services, ["invalid_override"]); }
  }
  const overridden = reason !== undefined;
  if (new Date(decision.createdAt).getTime() > now.getTime()) return result(request, services, ["invalid_decision"]);
  if (mismatches.length > 0 && !overridden) return result(request, services, mismatches);
  if (reason) {
    const override = reason;
    const event = { schemaVersion: 1, type: "quality_rollout_override", eventId: randomUUID(), decisionId: request.decisionId, operator: dependencies.operator ?? process.env.USER ?? "unknown", at: now.toISOString(), services: [...services], mismatches: [...new Set(mismatches)], actualCommitSha: actualCommitSha ?? "unknown", actualConfigSha256: actualConfigSha256 ?? "unknown", actualCorpusSha256: actualCorpusSha256 ?? "unknown", actualRunnerVersion: actualRunnerVersion ?? -1, reason: override.text, reasonSha256: override.digest };
    try {
      const committed = await (dependencies.appendEvent ?? appendDefault)(event, root);
      if (committed.status !== "committed" && committed.status !== "noop") return result(request, services, ["event_failed"], [], true);
      } catch { return result(request, services, ["event_failed"], [], true); }
  }
  // A gated compose rollout must point workers at the container-side path of
  // the read-only config mount. The development compose file intentionally
  // has no such mount, so production fails closed instead of passing a host
  // path that the new worker cannot read.
  if (!dependencies.spawn && !(dependencies.configFileContainer ?? process.env.FEEDBACK_QUALITY_CONFIG_FILE_CONTAINER ?? "").trim()) {
    return result(request, services, ["binding_mismatch"], [], overridden);
  }
  let rollback: RollbackArtifact;
  try {
    rollback = await (dependencies.prepareRollback ?? defaultRollback)(services, decision);
    if (!validRollback(rollback, services)) return result(request, services, ["rollback_unavailable"], [], overridden);
    const rollbackEvent = { schemaVersion: 1, type: "quality_rollback_artifact", eventId: randomUUID(), artifactId: rollback.artifactId, decisionId: request.decisionId, operator: dependencies.operator ?? process.env.USER ?? "unknown", at: now.toISOString(), command: [...rollback.command], previousCommitSha: rollback.previousCommitSha, previousImageRef: rollback.previousImageRef, previousImageDigest: rollback.previousImageDigest, composeFiles: [...rollback.composeFiles], composeFilesSha256: rollback.composeFilesSha256, services: [...rollback.services] };
    const persisted = await (dependencies.appendEvent ?? appendDefault)(rollbackEvent, root);
    if (persisted.status !== "committed" && persisted.status !== "noop") return result(request, services, ["event_failed"], [], overridden);
  } catch (error) { return result(request, services, [error instanceof DeployError ? error.code : "rollback_unavailable"], [], overridden); }
  const recreated: WorkerService[] = [];
  const auditedFailure = async (failure: DeployReason, phase: string, leaseRecovered: boolean): Promise<DeployResult> => {
    const event = { schemaVersion: 1, type: "quality_rollout_failed", eventId: randomUUID(), decisionId: request.decisionId, operator: dependencies.operator ?? process.env.USER ?? "unknown", at: (dependencies.now?.() ?? new Date()).toISOString(), services: [...services], recreatedServices: [...recreated], phase, reason: failure, leaseRecovered, rollbackArtifactId: rollback.artifactId };
    try {
      const committed = await (dependencies.appendEvent ?? appendDefault)(event, root);
      if (committed.status !== "committed" && committed.status !== "noop") return result(request, services, ["event_failed"], recreated, overridden, rollback);
    } catch { return result(request, services, ["event_failed"], recreated, overridden, rollback); }
    return result(request, services, [failure], recreated, overridden, rollback);
  };
  const spawn = dependencies.spawn;
  const health = dependencies.waitForHealthy ?? defaultHealth;
  for (const service of services) {
    const expected = { decisionId: decision.decisionId, commitSha: decision.candidateCommitSha, configSha256: decision.configSha256, runnerVersion: decision.runnerVersion, rolloutInstanceId: randomUUID() };
    let lease: QueueLease | undefined;
    let failure: DeployReason | undefined;
    let leaseRecovered = false;
    let phase: "queue" | "spawn" | "health" | "canary" = "queue";
    try {
      const queueName = QUEUE_NAMES[SERVICE_STAGE[service]];
      lease = dependencies.acquireQueueLease
        ? await dependencies.acquireQueueLease(queueName)
        : (dependencies.queueCounts !== undefined || dependencies.runCanary !== undefined)
          ? await legacyQueueLease(queueName, dependencies, service, expected)
          : await defaultQueueLease(queueName, dependencies.canaryTimeoutMs);
      await lease.pause();
      const deadline = Date.now() + 30_000;
      let queue: QueueCounts;
      do {
        queue = await lease.counts();
        const pending = (queue.waiting ?? 0) + (lease.allowPostFencePaused ? 0 : (queue.paused ?? 0)) + (queue.prioritized ?? 0) + (queue.waitingChildren ?? 0) + (queue.delayed ?? 0);
        if (pending !== 0) { failure = "queue_nonempty"; break; }
        if (!lease.drainActive && queue.active !== 0) { failure = "queue_nonempty"; break; }
        if (queue.active === 0) break;
        if (Date.now() >= deadline) { failure = "queue_nonempty"; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (true);
      if (!failure) {
        const argv = ["docker", "compose", "up", "-d", "--force-recreate", service] as const;
        const environment = {
            ...Object.fromEntries((runtimeConfig?.envAllowlist ?? []).map((key) => [key, runtimeEnvironment[key]])),
            FEEDBACK_QUALITY_ROLLOUT_INSTANCE_ID: expected.rolloutInstanceId,
            FEEDBACK_QUALITY_CONFIG_FILE: dependencies.configFileContainer ?? process.env.FEEDBACK_QUALITY_CONFIG_FILE_CONTAINER,
        };
        const spawnOperation = dependencies.spawnProduction
          ? (args: readonly string[]) => dependencies.spawnProduction!(args, environment)
          : dependencies.spawn ?? ((args: readonly string[]) => defaultSpawn(args, { env: environment }));
        phase = "spawn";
        if (lease.assertOwnership) await lease.assertOwnership().catch(() => { throw new DeployError("queue_read_failed"); });
        const commandResult = await spawnOperation(argv);
        if (commandResult.exitCode !== 0) failure = "process_failed";
        else recreated.push(service);
      }
      if (!failure) {
        if (lease.assertOwnership) await lease.assertOwnership().catch(() => { throw new DeployError("queue_read_failed"); });
        phase = "health";
        await health(service);
        phase = "canary";
        if (lease.assertOwnership) await lease.assertOwnership().catch(() => { throw new DeployError("queue_read_failed"); });
        if (lease.runCanary) await lease.runCanary(service, expected);
        else if (dependencies.runCanary) await dependencies.runCanary(service, expected);
        else await defaultCanary(service, expected, dependencies.canaryTimeoutMs);
      }
    } catch (error) {
      if (error instanceof DeployError) failure = error.code;
      else if (phase === "spawn") failure = "process_failed";
      else if (phase === "health") failure = "health_failed";
      else if (phase === "canary") failure = "canary_failed";
      else failure = "queue_read_failed";
    } finally {
      if (lease) {
        try { await lease.resume(); leaseRecovered = true; }
        catch { failure ??= "queue_read_failed"; }
      }
    }
    if (failure) return auditedFailure(failure, phase, leaseRecovered);
  }
  const event = { schemaVersion: 1, type: "quality_rollout", eventId: randomUUID(), decisionId: request.decisionId, operator: dependencies.operator ?? process.env.USER ?? "unknown", at: now.toISOString(), services: [...services], recreatedServices: [...recreated], overridden, rollbackArtifactId: rollback.artifactId, rollbackCommand: [...rollback.command], actualCommitSha: actualCommitSha ?? decision.candidateCommitSha, actualConfigSha256: actualConfigSha256 ?? decision.configSha256, actualCorpusSha256: actualCorpusSha256 ?? decision.corpusSha256, actualRunnerVersion: actualRunnerVersion ?? decision.runnerVersion };
  try {
    const committed = await (dependencies.appendEvent ?? appendDefault)(event, root);
    if (committed.status !== "committed" && committed.status !== "noop") return result(request, services, ["event_failed"], recreated, overridden, rollback);
  } catch { return result(request, services, ["event_failed"], recreated, overridden, rollback); }
  return Object.freeze({ status: "deployed" as const, verdict: "pass" as const, decisionId: request.decisionId, overridden, services: [...services], recreatedServices: [...recreated], reasons: [] as const, rollbackArtifactId: rollback.artifactId, rollbackArgv: [...rollback.command] });
}

export { SERVICE_ORDER as ALLOWED_WORKER_SERVICES };
