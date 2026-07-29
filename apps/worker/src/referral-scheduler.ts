import { Worker } from "bullmq";
import {
  getRedis,
  REFERRAL_QUEUE_NAME,
  HOLD_RELEASE_JOB,
  SUBSCRIPTION_RECONCILE_JOB,
  RETENTION_SWEEP_JOB,
  FREE_REFUND_SWEEP_JOB,
  releaseMaturedCommissions,
  reconcileSubscriptions,
  runRetentionSweep,
  runFreeRefundSweep,
  TRIBUTE_RECONCILE_JOB,
  releaseMaturedCommissions,
  reconcileSubscriptions,
  runRetentionSweep,
  reconcilePendingTributeOrders,
} from "@clipclap/shared";

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
      if (job.name === RETENTION_SWEEP_JOB) {
        await runRetentionSweep(now);
        return;
      }
      if (job.name === FREE_REFUND_SWEEP_JOB) {
        // Returns the allowance for free jobs that failed in a stage finalize
        // never sees. It logs its own refunds, one line each, so nothing is
        // summarised here.
        await runFreeRefundSweep(now);
      if (job.name === TRIBUTE_RECONCILE_JOB) {
        const r = await reconcilePendingTributeOrders(new Date());
        console.log(
          `[tribute-reconcile] checked=${r.checked} activated=${r.activated} failed=${r.failed} expired=${r.expired}`
        );
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
