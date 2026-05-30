import { Worker } from "bullmq";
import {
  getRedis,
  REFERRAL_QUEUE_NAME,
  HOLD_RELEASE_JOB,
  SUBSCRIPTION_RECONCILE_JOB,
  releaseMaturedCommissions,
  reconcileSubscriptions,
} from "@clipfast/shared";

export function createReferralScheduler(): Worker {
  const worker = new Worker(
    REFERRAL_QUEUE_NAME,
    async (job) => {
      const now = new Date();
      if (job.name === HOLD_RELEASE_JOB) {
        const { released } = await releaseMaturedCommissions(now);
        console.log(`[referral] released ${released} commissions`);
        return;
      }
      if (job.name === SUBSCRIPTION_RECONCILE_JOB) {
        const { reconciled } = await reconcileSubscriptions(now);
        console.log(`[reconcile] reconciled ${reconciled} subscriptions`);
        return;
      }
    },
    { connection: getRedis(), concurrency: 1 }
  );
  worker.on("failed", (job, err) =>
    console.error(`[referral] ${job?.name} failed:`, err.message)
  );
  return worker;
}
