import { Worker } from "bullmq";
import {
  getRedis,
  REFERRAL_QUEUE_NAME,
  HOLD_RELEASE_JOB,
  PAYOUT_BATCH_JOB,
  REFERRAL_CONFIG,
  releaseMaturedCommissions,
  runPayoutBatch,
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
      if (job.name === PAYOUT_BATCH_JOB) {
        const day = now.getUTCDate();
        if (!(REFERRAL_CONFIG.payoutDays as readonly number[]).includes(day)) {
          console.log(`[referral] payout-batch skipped (day ${day})`);
          return;
        }
        const { created } = await runPayoutBatch(now);
        console.log(`[referral] created ${created} payouts`);
      }
    },
    { connection: getRedis(), concurrency: 1 }
  );
  worker.on("failed", (job, err) =>
    console.error(`[referral] ${job?.name} failed:`, err.message)
  );
  return worker;
}
