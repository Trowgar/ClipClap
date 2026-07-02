import { Worker } from "bullmq";
import {
  getQueueNameForStage,
  getRedis,
  parseWorkerRole,
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
  });
  worker.on("failed", (job, err) => {
    console.error(`[${role}] failed ${job?.id}:`, err.message);
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

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}
