import { Worker } from "bullmq";
import { getRedis, VIDEO_QUEUE_NAME } from "@clipfast/shared";
import { processVideoJob } from "./pipeline";

console.log("ClipFast Worker starting...");

const worker = new Worker(
  VIDEO_QUEUE_NAME,
  async (job) => {
    console.log(`Processing job: ${job.id} (${job.name})`);

    if (job.name === "process-video") {
      await processVideoJob(job.data.jobId, job.data.userId);
    }

    // trim-clip handled in Phase 2 plan (frontend + billing)
  },
  {
    connection: getRedis(),
    concurrency: 2,
  }
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed:`, err.message);
});

console.log(`Worker listening on queue: ${VIDEO_QUEUE_NAME}`);
