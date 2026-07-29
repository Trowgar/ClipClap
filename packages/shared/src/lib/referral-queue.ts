import { Queue } from "bullmq";
import { getRedis } from "./redis";

export const REFERRAL_QUEUE_NAME = "referral-maintenance";
export const HOLD_RELEASE_JOB = "hold-release";
export const SUBSCRIPTION_RECONCILE_JOB = "subscription-reconcile";
/** Storage retention sweep. It shares this queue because it is the same kind
 *  of work - hourly, idempotent, nobody is waiting for it - and a second queue
 *  would mean a second Worker and a second shutdown path for no gain. */
export const RETENTION_SWEEP_JOB = "retention-sweep";
/** Free-allowance refund sweep. Same queue and the same reasoning as the
 *  retention sweep: hourly, idempotent, nobody is waiting for it. */
export const FREE_REFUND_SWEEP_JOB = "free-refund-sweep";

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
 * boot is safe. Hold-release runs hourly.
 * Also retires the old payout-batch repeatable job from Redis if still present.
 */
export async function registerReferralSchedules(): Promise<void> {
  const queue = getReferralQueue();
  await queue.add(HOLD_RELEASE_JOB, {}, { repeat: { pattern: "0 * * * *" }, jobId: HOLD_RELEASE_JOB });
  await queue.add(SUBSCRIPTION_RECONCILE_JOB, {}, { repeat: { pattern: "0 * * * *" }, jobId: SUBSCRIPTION_RECONCILE_JOB });
  await queue.add(RETENTION_SWEEP_JOB, {}, { repeat: { pattern: "0 * * * *" }, jobId: RETENTION_SWEEP_JOB });
  await queue.add(FREE_REFUND_SWEEP_JOB, {}, { repeat: { pattern: "0 * * * *" }, jobId: FREE_REFUND_SWEEP_JOB });
  // Retire the old 1st/15th payout batch if still scheduled in Redis.
  for (const job of await queue.getRepeatableJobs()) {
    if (job.name === "payout-batch") await queue.removeRepeatableByKey(job.key);
  }
}
