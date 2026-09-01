import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";

import { sha256 } from "../feedback-learning/canonical";
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

export type QueueCounts = Readonly<{ active: number; waiting: number; delayed?: number }>;
export type GitState = Readonly<{ head: string; dirtyTracked: boolean }>;
export type ProcessResult = Readonly<{ exitCode: number }>;

export type DeployDependencies = Readonly<{
  root?: string;
  now?: () => Date;
  operator?: string;
  readDecision?: (decisionId: string, root: string) => Promise<GateDeployDecision>;
  gitState?: () => Promise<GitState>;
  configSha256?: () => Promise<string>;
  effectiveConfig?: () => Promise<unknown>;
  configFile?: string;
  corpusSha256?: () => Promise<string>;
  runnerVersion?: () => Promise<number>; // Test seam; production uses QUALITY_RUNNER_VERSION.
  queueCounts?: (queueName: string) => Promise<QueueCounts>;
  spawn?: (argv: readonly string[]) => Promise<ProcessResult>;
  waitForHealthy?: (service: WorkerService) => Promise<void>;
  runCanary?: (service: WorkerService, expected: Readonly<{ decisionId: string; commitSha: string; configSha256: string; runnerVersion: number }>) => Promise<void>;
  prepareRollback?: (services: readonly WorkerService[], decision: GateDeployDecision) => Promise<RollbackArtifact>;
  canaryTimeoutMs?: number;
  appendEvent?: (event: Readonly<Record<string, unknown>>, root: string) => Promise<CommitResult>;
}>;

export type RollbackArtifact = Readonly<{
  schemaVersion: 1;
  artifactId: string;
  createdAt: string;
  immutable: true;
  verified: true;
  command: readonly string[];
  previousCommitSha: string;
}>;

export type DeployResult = Readonly<{
  status: "deployed" | "failed";
  verdict: "pass" | "fail";
  decisionId: string;
  overridden: boolean;
  services: readonly WorkerService[];
  recreatedServices: readonly WorkerService[];
  reasons: readonly DeployReason[];
  rollbackCommand?: string;
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
  return Object.freeze({ status: "failed" as const, verdict: "fail" as const, decisionId: request.decisionId, overridden, services, recreatedServices: recreated, reasons: [...new Set(reasons)], rollbackCommand: rollback?.command.join(" ") ?? (recreated.length ? `docker compose up -d --force-recreate ${recreated.join(" ")}` : undefined), rollbackArtifactId: rollback?.artifactId });
}

function validRollback(value: unknown, services: readonly WorkerService[]): value is RollbackArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!ownKeys(item, ["schemaVersion", "artifactId", "createdAt", "immutable", "verified", "command", "previousCommitSha"]) || item.schemaVersion !== 1 || typeof item.artifactId !== "string" || item.artifactId.length === 0 || !utc(item.createdAt) || item.immutable !== true || item.verified !== true || typeof item.previousCommitSha !== "string" || !COMMIT.test(item.previousCommitSha) || !Array.isArray(item.command) || item.command.length < 6 || item.command.some((part) => typeof part !== "string" || part.length === 0 || /[\0\n\r]/.test(part)) || item.command.slice(0, 5).join(" ") !== "docker compose up -d --force-recreate") return false;
  const targetServices = item.command.slice(5);
  const indexes = targetServices.map((service) => SERVICE_ORDER.indexOf(service as WorkerService));
  return targetServices.length > 0 && indexes.every((index) => index >= 0) && indexes.every((index, position) => position === 0 || index > indexes[position - 1]) && new Set(targetServices).size === targetServices.length && services.every((service) => targetServices.includes(service));
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
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"])).stdout.trim();
    const dirtyTracked = Boolean((await execFileAsync("git", ["status", "--porcelain", "--untracked-files=no"])).stdout.trim());
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
      const counts = await queue.getJobCounts("active", "waiting", "delayed");
      const active = counts.active ?? 0; const waiting = counts.waiting ?? 0; const delayed = counts.delayed ?? 0;
      if (![active, waiting, delayed].every((item) => Number.isSafeInteger(item) && item >= 0)) throw new Error();
      return { active, waiting, delayed };
    } finally { await queue.close().catch(() => undefined); }
  } catch { throw new DeployError("queue_read_failed"); }
}

async function defaultCanary(service: WorkerService, expected: Readonly<{ decisionId: string; commitSha: string; configSha256: string; runnerVersion: number }>, timeoutMs = 30_000): Promise<void> {
  const stage = SERVICE_STAGE[service];
  const queue = new Queue(QUEUE_NAMES[stage], { connection: getRedis() });
  const nonce = randomUUID();
  try {
    const job = await queue.add("feedback-quality-canary", { kind: "feedback-quality-canary", nonce, decisionId: expected.decisionId }, { attempts: 1, removeOnComplete: false, removeOnFail: false });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await queue.getJob(job.id!);
      const state = await current?.getState();
      if (state === "completed") {
        const value = current?.returnvalue as Record<string, unknown> | undefined;
        if (!value || value.kind !== "feedback-quality-canary" || value.nonce !== nonce || value.role !== stage || value.configSha256 !== expected.configSha256 || value.runnerVersion !== expected.runnerVersion || value.commitSha !== expected.commitSha) throw new DeployError("canary_failed");
        await current?.remove();
        return;
      }
      if (state === "failed") throw new DeployError("canary_failed");
      if (Date.now() >= deadline) throw new DeployError("canary_failed");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw new DeployError("canary_failed");
  } finally { await queue.close().catch(() => undefined); }
}

async function defaultSpawn(argv: readonly string[]): Promise<ProcessResult> {
  if (argv.length !== 6 || argv[0] !== "docker" || argv[1] !== "compose" || argv[2] !== "up" || argv[3] !== "-d" || argv[4] !== "--force-recreate" || !SERVICE_ORDER.includes(argv[5] as WorkerService)) throw new DeployError("invalid_request");
  try { await execFileAsync(argv[0], argv.slice(1), { shell: false }); return { exitCode: 0 }; }
  catch { return { exitCode: 1 }; }
}

async function defaultHealth(service: WorkerService): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const result = await execFileAsync("docker", ["compose", "ps", "--format", "json", "--status", "running", service], { shell: false, timeout: 5_000 });
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
      : effectiveConfigDigest(await (dependencies.effectiveConfig ? dependencies.effectiveConfig() : effectiveConfigFromFile(dependencies.configFile ?? process.env.FEEDBACK_QUALITY_CONFIG_FILE)));
    const corpus = dependencies.corpusSha256 ? await dependencies.corpusSha256() : await deriveQualityCorpusDigest(root);
    const runner = dependencies.runnerVersion ? await dependencies.runnerVersion() : QUALITY_RUNNER_VERSION;
    actualConfigSha256 = config; actualCorpusSha256 = corpus; actualRunnerVersion = runner;
    if (config !== decision.configSha256 || corpus !== decision.corpusSha256 || runner !== decision.runnerVersion) mismatches.push("binding_mismatch");
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
  let rollback: RollbackArtifact;
  try {
    rollback = await (dependencies.prepareRollback ?? defaultRollback)(services, decision);
    if (!validRollback(rollback, services)) return result(request, services, ["rollback_unavailable"], [], overridden);
    const rollbackEvent = { schemaVersion: 1, type: "quality_rollback_artifact", eventId: randomUUID(), artifactId: rollback.artifactId, decisionId: request.decisionId, operator: dependencies.operator ?? process.env.USER ?? "unknown", at: now.toISOString(), command: [...rollback.command], previousCommitSha: rollback.previousCommitSha };
    const persisted = await (dependencies.appendEvent ?? appendDefault)(rollbackEvent, root);
    if (persisted.status !== "committed" && persisted.status !== "noop") return result(request, services, ["event_failed"], [], overridden);
  } catch (error) { return result(request, services, [error instanceof DeployError ? error.code : "rollback_unavailable"], [], overridden); }
  const recreated: WorkerService[] = [];
  const counts = dependencies.queueCounts ?? defaultQueueCounts;
  const spawn = dependencies.spawn ?? defaultSpawn;
  const health = dependencies.waitForHealthy ?? defaultHealth;
  const canary = dependencies.runCanary ?? ((service, expected) => defaultCanary(service, expected, dependencies.canaryTimeoutMs));
  for (const service of services) {
    let queue: QueueCounts;
    try { queue = await counts(QUEUE_NAMES[SERVICE_STAGE[service]]); }
    catch (error) { return result(request, services, [error instanceof DeployError ? error.code : "queue_read_failed"], recreated, overridden, rollback); }
    if (queue.active !== 0 || queue.waiting !== 0) return result(request, services, ["queue_nonempty"], recreated, overridden, rollback);
    try {
      const process = await spawn(["docker", "compose", "up", "-d", "--force-recreate", service]);
      if (process.exitCode !== 0) return result(request, services, ["process_failed"], recreated, overridden, rollback);
    } catch { return result(request, services, ["process_failed"], recreated, overridden, rollback); }
    recreated.push(service);
    try { await health(service); } catch { return result(request, services, ["health_failed"], recreated, overridden, rollback); }
    try { await canary(service, { decisionId: decision.decisionId, commitSha: decision.candidateCommitSha, configSha256: decision.configSha256, runnerVersion: decision.runnerVersion }); }
    catch { return result(request, services, ["canary_failed"], recreated, overridden, rollback); }
  }
  const event = { schemaVersion: 1, type: "quality_rollout", eventId: randomUUID(), decisionId: request.decisionId, operator: dependencies.operator ?? process.env.USER ?? "unknown", at: now.toISOString(), services: [...services], recreatedServices: [...recreated], overridden, rollbackArtifactId: rollback.artifactId, rollbackCommand: [...rollback.command], actualCommitSha: actualCommitSha ?? decision.candidateCommitSha, actualConfigSha256: actualConfigSha256 ?? decision.configSha256, actualCorpusSha256: actualCorpusSha256 ?? decision.corpusSha256, actualRunnerVersion: actualRunnerVersion ?? decision.runnerVersion };
  try {
    const committed = await (dependencies.appendEvent ?? appendDefault)(event, root);
    if (committed.status !== "committed" && committed.status !== "noop") return result(request, services, ["event_failed"], recreated, overridden, rollback);
  } catch { return result(request, services, ["event_failed"], recreated, overridden, rollback); }
  return Object.freeze({ status: "deployed" as const, verdict: "pass" as const, decisionId: request.decisionId, overridden, services: [...services], recreatedServices: [...recreated], reasons: [] as const, rollbackArtifactId: rollback.artifactId, rollbackCommand: rollback.command.join(" ") });
}

export { SERVICE_ORDER as ALLOWED_WORKER_SERVICES };
