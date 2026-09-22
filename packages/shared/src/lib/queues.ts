import { Queue } from "bullmq";
import { getRedis } from "./redis";

export const QUEUE_NAMES = {
  download: "video-download",
  transcribe: "video-transcribe",
  analyze: "video-analyze",
  render: "video-render",
  finalize: "video-finalize",
} as const;

export type StageName = keyof typeof QUEUE_NAMES;

const STAGES = Object.keys(QUEUE_NAMES) as StageName[];
const queues = new Map<StageName, Queue>();

export function parseWorkerRole(value: string | undefined): StageName {
  if (value && STAGES.includes(value as StageName)) {
    return value as StageName;
  }
  throw new Error(`Unknown worker role: ${value ?? "(empty)"}`);
}

export function getQueueNameForStage(stage: StageName): string {
  return QUEUE_NAMES[stage];
}

export function getStageQueue(stage: StageName): Queue {
  const existing = queues.get(stage);
  if (existing) return existing;

  const queue = new Queue(getQueueNameForStage(stage), {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: stage === "render" ? 2 : 3,
      backoff: {
        type: "exponential",
        delay: 5000,
      },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  });
  queues.set(stage, queue);
  return queue;
}

const REMOVABLE_PIPELINE_JOB_STATES = [
  "waiting",
  "delayed",
  "prioritized",
  "paused",
] as const;

export async function removeQueuedPipelineJobs(
  pipelineJobId: string
): Promise<number> {
  const results = await Promise.allSettled(
    STAGES.map(async (stage) => {
      const jobs = await getStageQueue(stage).getJobs([
        ...REMOVABLE_PIPELINE_JOB_STATES,
      ]);
      let removed = 0;

      for (const job of jobs) {
        const data = job.data as { jobId?: unknown } | null;
        if (data?.jobId !== pipelineJobId) continue;
        try {
          await job.remove();
          removed += 1;
        } catch (error) {
          console.error(
            `[queue] could not remove ${stage} item ${job.id} for deleted job ${pipelineJobId}:`,
            error
          );
        }
      }
      return removed;
    })
  );

  return results.reduce((count, result, index) => {
    if (result.status === "fulfilled") return count + result.value;
    console.error(
      `[queue] could not scan ${STAGES[index]} for deleted job ${pipelineJobId}:`,
      result.reason
    );
    return count;
  }, 0);
}
