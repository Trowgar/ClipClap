import { Queue } from "bullmq";
import { getRedis } from "./redis";

export const REFERRAL_QUEUE_NAME = "referral-maintenance";
export const HOLD_RELEASE_JOB = "hold-release";
export const PAYOUT_BATCH_JOB = "payout-batch";

let referralQueue: Queue | null = null;

export function getReferralQueue(): Queue {
  if (!referralQueue) {
    referralQueue = new Queue(REFERRAL_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      },
    });
  }
  return referralQueue;
}

/**
 * Register repeatable jobs. Idempotent on jobId, so calling on every worker
 * boot is safe. Hold-release runs hourly; payout-batch runs daily at 02:00 UTC
 * (the job body itself checks whether "today" is a payout day).
 */
export async function registerReferralSchedules(): Promise<void> {
  const queue = getReferralQueue();
  await queue.add(
    HOLD_RELEASE_JOB,
    {},
    { repeat: { pattern: "0 * * * *" }, jobId: HOLD_RELEASE_JOB }
  );
  await queue.add(
    PAYOUT_BATCH_JOB,
    {},
    { repeat: { pattern: "0 2 * * *" }, jobId: PAYOUT_BATCH_JOB }
  );
}
