import { Worker, type Job } from "bullmq";
import {
  getQueueNameForStage,
  getRedis,
  parseWorkerRole,
  releaseNextQueued,
  type StageName,
} from "@clipclap/shared";
import { runAnalyzeStage } from "./stages/analyze";
import { runDownloadStage } from "./stages/download";
import { runFinalizeStage } from "./stages/finalize";
import { runRenderStage } from "./stages/render";
import { runTranscribeStage } from "./stages/transcribe";
import { effectiveConfigDigest, QUALITY_RUNNER_VERSION, readSecureConfig, validateSecureConfig } from "./feedback-quality/config";

const DEFAULT_CONCURRENCY: Record<StageName, number> = {
  download: 4,
  transcribe: 2,
  analyze: 5,
  render: 1,
  finalize: 3,
};

export function getWorkerConcurrency(role: StageName): number {
  const roleEnvName = `${role.toUpperCase()}_CONCURRENCY`;
  return readPositiveInt(
    process.env[roleEnvName] ?? process.env.WORKER_CONCURRENCY,
    DEFAULT_CONCURRENCY[role]
  );
}

export function createStageWorker(
  roleValue = process.env.WORKER_ROLE
): Worker {
  const role = parseWorkerRole(roleValue);
  const startupRolloutInstanceId = process.env.FEEDBACK_QUALITY_ROLLOUT_INSTANCE_ID ?? "";
  const workerOptions = {
    connection: getRedis(),
    concurrency: getWorkerConcurrency(role),
    lockDuration: role === "render" ? 30 * 60 * 1000 : 5 * 60 * 1000,
    stalledInterval: 60 * 1000,
    maxStalledCount: 1,
  } as const;
  const processor = async (job: Job, token?: string) => {
    if (isQualityCanary(job.data)) throw new Error("quality_canary_control_queue_required");
    return dispatchStageJob(role, job.data, job, token);
  };
  const worker = new Worker(
    getQueueNameForStage(role),
    processor,
    workerOptions
  );

  // Quality canaries use a dedicated control queue. This keeps the production
  // queue fenced during recreate/health/canary and prevents a canary from
  // competing with (or releasing) ordinary user jobs.
  const canaryWorker = new Worker(
    `${getQueueNameForStage(role)}:quality-canary`,
    async (job) => {
      if (!isQualityCanary(job.data)) throw new Error("quality_canary_required");
      return runQualityCanary(role, job.data, startupRolloutInstanceId);
    },
    { ...workerOptions, concurrency: 1 }
  );
  const closePrimary = worker.close.bind(worker);
  worker.close = async (force?: boolean) => {
    await canaryWorker.close(force);
    return closePrimary(force);
  };

  worker.on("completed", (job) => {
    console.log(`[${role}] completed ${job.id}`);
    if (!isQualityCanary(job.data)) void maybeReleaseAfterStageEvent(role, "completed", job);
  });
  worker.on("failed", (job, err) => {
    console.error(`[${role}] failed ${job?.id}:`, err.message);
    if (!isQualityCanary(job?.data)) void maybeReleaseAfterStageEvent(role, "failed", job ?? undefined);
  });

  return worker;
}

type QualityCanaryJob = Readonly<{ kind: "feedback-quality-canary"; nonce: string; decisionId: string; rolloutInstanceId: string }>;
export type QualityCanaryResponse = Readonly<{ kind: "feedback-quality-canary"; nonce: string; decisionId: string; rolloutInstanceId: string; role: StageName; commitSha: string; configSha256: string; runnerVersion: number }>;

function isQualityCanary(value: unknown): value is QualityCanaryJob {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 4 && item.kind === "feedback-quality-canary" && typeof item.nonce === "string" && item.nonce.length > 0 && typeof item.decisionId === "string" && typeof item.rolloutInstanceId === "string" && item.rolloutInstanceId.length > 0;
}

async function runQualityCanary(role: StageName, job: QualityCanaryJob, startupRolloutInstanceId: string): Promise<QualityCanaryResponse> {
  if (!startupRolloutInstanceId || job.rolloutInstanceId !== startupRolloutInstanceId) throw new Error("quality_canary_instance_mismatch");
  let configSha256 = "";
  try {
    const path = process.env.FEEDBACK_QUALITY_CONFIG_FILE;
    if (!path) throw new Error();
    const config = validateSecureConfig(await readSecureConfig(path), true);
    const environment = readQualityEnvironmentSnapshot(config.envAllowlist);
    configSha256 = effectiveConfigDigest(config, environment);
  } catch { /* empty binding deliberately fails deploy verification */ }
  const commitSha = process.env.GIT_SHA ?? "";
  return { kind: "feedback-quality-canary", nonce: job.nonce, decisionId: job.decisionId, rolloutInstanceId: startupRolloutInstanceId, role, commitSha, configSha256, runnerVersion: QUALITY_RUNNER_VERSION };
}

function readQualityEnvironmentSnapshot(allowlist: readonly string[]): Readonly<Record<string, string | null>> {
  const encoded = process.env.FEEDBACK_QUALITY_ENV_SNAPSHOT;
  if (!encoded) throw new Error("quality_environment_snapshot_missing");
  const parsed: unknown = JSON.parse(encoded);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("quality_environment_snapshot_invalid");
  const item = parsed as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  const expected = [...allowlist].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error("quality_environment_snapshot_keys");
  if (keys.some((key) => item[key] !== null && typeof item[key] !== "string")) throw new Error("quality_environment_snapshot_value");
  if (keys.some((key) => item[key] !== (process.env[key] ?? null))) throw new Error("quality_environment_snapshot_drift");
  return item as Readonly<Record<string, string | null>>;
}

export async function dispatchStageJob(
  role: StageName,
  data: unknown,
  job?: Job,
  token?: string
): Promise<void> {
  // Only DOWNLOAD ever parks a job (see FLAP_WAIT_DELAYS_MS in
  // stages/download.ts): it is the one stage whose failure class - YouTube
  // throttling the WARP exit - passes on its own. No other stage gets the
  // BullMQ job handle, so no other stage can call moveToDelayed by accident.
  if (role === "download") return runDownloadStage(data as never, job, token);
  if (role === "transcribe") return runTranscribeStage(data as never);
  if (role === "analyze") return runAnalyzeStage(data as never);
  if (role === "render") return runRenderStage(data as never);
  return runFinalizeStage(data as never);
}

/**
 * Free a queue slot when - and only when - a job's PIPELINE ended.
 *
 * "Ended" is finalize completing (the one stage that runs last) or any stage
 * exhausting its BullMQ attempts (a mid-pipeline terminal failure never
 * reaches finalize). A retriable failure keeps its slot: the job is still
 * alive and about to run again, and releasing on it would put two of the
 * user's jobs on workers with a limit of one - exactly what the advisory
 * lock in createJob exists to prevent.
 *
 * Swallows everything. This runs inside BullMQ event handlers; the queue is
 * self-healing (next completion or the hourly stall guard retries), a downed
 * worker is not.
 */
export async function maybeReleaseAfterStageEvent(
  role: StageName,
  event: "completed" | "failed",
  job:
    | {
        data?: unknown;
        attemptsMade?: number;
        opts?: { attempts?: number };
      }
    | undefined
): Promise<void> {
  try {
    if (!job) return;
    if (event === "completed" && role !== "finalize") return;
    if (event === "failed") {
      const attempts = job.opts?.attempts ?? 1;
      if ((job.attemptsMade ?? 0) < attempts) return;
    }
    const userId = (job.data as { userId?: string } | undefined)?.userId;
    if (!userId) return;
    const released = await releaseNextQueued(userId);
    if (released.length > 0) {
      console.log(
        `[queue] ${event === "completed" ? "finalize" : "terminal failure"} freed a slot for ${userId}; released ${released.map((j) => j.id).join(", ")}`
      );
    }
  } catch (error) {
    console.error(`[queue] post-${event} release failed:`, error);
  }
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}
