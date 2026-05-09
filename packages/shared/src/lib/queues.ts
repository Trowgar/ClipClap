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
