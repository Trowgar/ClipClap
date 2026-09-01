import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";

import { sha256 } from "../feedback-learning/canonical";
import { Queue } from "bullmq";
import { getRedis } from "@clipclap/shared/lib/redis";
import {
  appendLabelEvent,
  contentId,
  DEFAULT_QUALITY_ROOT,
  readBundle,
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
  "invalid_request", "invalid_decision", "decision_expired", "decision_not_pass", "binding_mismatch", "dirty_tree",
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
  baseline: Readonly<Record<string, number>>;
  candidate: Readonly<Record<string, number>>;
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
  corpusSha256?: () => Promise<string>;
  runnerVersion?: () => Promise<number>;
  queueCounts?: (queueName: string) => Promise<QueueCounts>;
  spawn?: (argv: readonly string[]) => Promise<ProcessResult>;
  waitForHealthy?: (service: WorkerService) => Promise<void>;
  runCanary?: (service: WorkerService, expected: Readonly<{ decisionId: string; commitSha: string; configSha256: string; runnerVersion: number }>) => Promise<void>;
  appendEvent?: (event: Readonly<Record<string, unknown>>, root: string) => Promise<CommitResult>;
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
  return value as unknown as GateDeployDecision;
}

function validServices(requested: readonly string[]): requested is readonly WorkerService[] {
  if (requested.length === 0) return false;
  const indexes = requested.map((service) => SERVICE_ORDER.indexOf(service as WorkerService));
  return indexes.every((index) => index >= 0) && new Set(indexes).size === indexes.length && indexes.every((index, position) => position === 0 || index > indexes[position - 1]);
}

function result(request: DeployRequest, services: readonly WorkerService[], reasons: readonly DeployReason[], recreated: readonly WorkerService[] = [], overridden = false): DeployResult {
  return Object.freeze({ status: "failed" as const, verdict: "fail" as const, decisionId: request.decisionId, overridden, services, recreatedServices: recreated, reasons: [...new Set(reasons)], rollbackCommand: recreated.length ? `docker compose up -d --force-recreate ${recreated.join(" ")}` : undefined });
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
  const files = await readBundle("decision", id, root);
  if (files.size !== 2 || !files.has("decision.json") || !files.has("report.md")) throw new DeployError("invalid_decision");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(files.get("decision.json")!).toString("utf8")); } catch { throw new DeployError("invalid_decision"); }
  return validateDecision(parsed, id);
}

async function defaultGitState(): Promise<GitState> {
  try {
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"])).stdout.trim();
    const dirtyTracked = Boolean((await execFileAsync("git", ["status", "--porcelain", "--untracked-files=no"])).stdout.trim());
    if (!COMMIT.test(head)) throw new Error();
    return { head, dirtyTracked };
  } catch { throw new DeployError("binding_mismatch"); }
}

function envHash(name: string): Promise<string> {
  const value = process.env[name];
  if (!safeHash(value)) return Promise.reject(new DeployError("binding_mismatch"));
  return Promise.resolve(value);
}

function envRunner(): Promise<number> {
  const value = Number(process.env.FEEDBACK_QUALITY_RUNNER_VERSION);
  return Number.isSafeInteger(value) && value >= 0 ? Promise.resolve(value) : Promise.reject(new DeployError("binding_mismatch"));
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

async function defaultSpawn(argv: readonly string[]): Promise<ProcessResult> {
  if (argv.length !== 6 || argv[0] !== "docker" || argv[1] !== "compose" || argv[2] !== "up" || argv[3] !== "-d" || argv[4] !== "--force-recreate" || !SERVICE_ORDER.includes(argv[5] as WorkerService)) throw new DeployError("invalid_request");
  try { await execFileAsync(argv[0], argv.slice(1), { shell: false }); return { exitCode: 0 }; }
  catch { return { exitCode: 1 }; }
}

async function defaultHealth(service: WorkerService): Promise<void> {
  try {
    const result = await execFileAsync("docker", ["compose", "ps", "--status", "running", "--services", service], { shell: false });
    if (!result.stdout.split(/\r?\n/).map((line) => line.trim()).includes(service)) throw new Error();
  } catch { throw new DeployError("health_failed"); }
}

async function appendDefault(event: Readonly<Record<string, unknown>>, root: string): Promise<CommitResult> {
  return appendLabelEvent({ eventId: String(event.eventId), ...event }, root);
}

export async function deployWithQualityGate(request: DeployRequest, dependencies: DeployDependencies = {}): Promise<DeployResult> {
  const requested = request?.services ?? [];
  const services = requested as readonly WorkerService[];
  if (!request || typeof request.decisionId !== "string" || !DECISION_ID.test(request.decisionId) || !validServices(requested)) return result(request ?? { decisionId: "", services: [] }, services, ["invalid_request"]);
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
    const [config, corpus, runner] = await Promise.all([(dependencies.configSha256 ?? (() => envHash("FEEDBACK_QUALITY_CONFIG_SHA256")))(), (dependencies.corpusSha256 ?? (() => envHash("FEEDBACK_QUALITY_CORPUS_SHA256")))(), (dependencies.runnerVersion ?? envRunner)()]);
    actualConfigSha256 = config; actualCorpusSha256 = corpus; actualRunnerVersion = runner;
    if (config !== decision.configSha256 || corpus !== decision.corpusSha256 || runner !== decision.runnerVersion) mismatches.push("binding_mismatch");
  } catch (error) { mismatches.push(error instanceof DeployError ? error.code : "binding_mismatch"); }

  let reason: { text: string; digest: string } | undefined;
  if (request.overrideReasonFile !== undefined) {
    try { reason = await secureReason(request.overrideReasonFile); } catch { return result(request, services, ["invalid_override"]); }
  }
  const overridden = reason !== undefined;
  if (mismatches.length > 0 && !overridden) return result(request, services, mismatches);
  if (reason) {
    const override = reason;
    const event = { schemaVersion: 1, type: "quality_rollout_override", eventId: randomUUID(), decisionId: request.decisionId, operator: dependencies.operator ?? process.env.USER ?? "unknown", at: now.toISOString(), services: [...services], mismatches: [...new Set(mismatches)], actualCommitSha: actualCommitSha ?? "unknown", actualConfigSha256: actualConfigSha256 ?? "unknown", actualCorpusSha256: actualCorpusSha256 ?? "unknown", actualRunnerVersion: actualRunnerVersion ?? -1, reason: override.text, reasonSha256: override.digest };
    try {
      const committed = await (dependencies.appendEvent ?? appendDefault)(event, root);
      if (committed.status !== "committed" && committed.status !== "noop") return result(request, services, ["event_failed"], [], true);
    } catch { return result(request, services, ["event_failed"], [], true); }
  }
  const recreated: WorkerService[] = [];
  const counts = dependencies.queueCounts ?? defaultQueueCounts;
  const spawn = dependencies.spawn ?? defaultSpawn;
  const health = dependencies.waitForHealthy ?? defaultHealth;
  const canary = dependencies.runCanary ?? (async () => { throw new DeployError("canary_failed"); });
  for (const service of services) {
    let queue: QueueCounts;
    try { queue = await counts(QUEUE_NAMES[SERVICE_STAGE[service]]); }
    catch (error) { return result(request, services, [error instanceof DeployError ? error.code : "queue_read_failed"], recreated, overridden); }
    if (queue.active !== 0 || queue.waiting !== 0) return result(request, services, ["queue_nonempty"], recreated, overridden);
    try {
      const process = await spawn(["docker", "compose", "up", "-d", "--force-recreate", service]);
      if (process.exitCode !== 0) return result(request, services, ["process_failed"], recreated, overridden);
    } catch { return result(request, services, ["process_failed"], recreated, overridden); }
    recreated.push(service);
    try { await health(service); } catch { return result(request, services, ["health_failed"], recreated, overridden); }
    try { await canary(service, { decisionId: decision.decisionId, commitSha: decision.candidateCommitSha, configSha256: decision.configSha256, runnerVersion: decision.runnerVersion }); }
    catch { return result(request, services, ["canary_failed"], recreated, overridden); }
  }
  const event = { schemaVersion: 1, type: "quality_rollout", eventId: randomUUID(), decisionId: request.decisionId, operator: dependencies.operator ?? process.env.USER ?? "unknown", at: now.toISOString(), services: [...services], recreatedServices: [...recreated], overridden, actualCommitSha: actualCommitSha ?? decision.candidateCommitSha, actualConfigSha256: actualConfigSha256 ?? decision.configSha256, actualCorpusSha256: actualCorpusSha256 ?? decision.corpusSha256, actualRunnerVersion: actualRunnerVersion ?? decision.runnerVersion };
  try {
    const committed = await (dependencies.appendEvent ?? appendDefault)(event, root);
    if (committed.status !== "committed" && committed.status !== "noop") return result(request, services, ["event_failed"], recreated, overridden);
  } catch { return result(request, services, ["event_failed"], recreated, overridden); }
  return Object.freeze({ status: "deployed" as const, verdict: "pass" as const, decisionId: request.decisionId, overridden, services: [...services], recreatedServices: [...recreated], reasons: [] as const });
}

export { SERVICE_ORDER as ALLOWED_WORKER_SERVICES };
