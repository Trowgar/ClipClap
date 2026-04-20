import { Queue } from "bullmq";
import { getRedis } from "./redis";

let videoQueue: Queue | null = null;

export const VIDEO_QUEUE_NAME = "video-processing";

export function getVideoQueue(): Queue {
  if (!videoQueue) {
    videoQueue = new Queue(VIDEO_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    });
  }
  return videoQueue;
}
