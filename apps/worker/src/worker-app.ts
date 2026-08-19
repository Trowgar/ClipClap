import { Worker } from "bullmq";
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
  const worker = new Worker(
    getQueueNameForStage(role),
    async (job) => dispatchStageJob(role, job.data),
    {
      connection: getRedis(),
      concurrency: getWorkerConcurrency(role),
      lockDuration: role === "render" ? 30 * 60 * 1000 : 5 * 60 * 1000,
      stalledInterval: 60 * 1000,
      maxStalledCount: 1,
    }
  );

  worker.on("completed", (job) => {
    console.log(`[${role}] completed ${job.id}`);
    void maybeReleaseAfterStageEvent(role, "completed", job);
  });
  worker.on("failed", (job, err) => {
    console.error(`[${role}] failed ${job?.id}:`, err.message);
    void maybeReleaseAfterStageEvent(role, "failed", job ?? undefined);
  });

  return worker;
}

export async function dispatchStageJob(
  role: StageName,
  data: unknown
): Promise<void> {
  if (role === "download") return runDownloadStage(data as never);
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
