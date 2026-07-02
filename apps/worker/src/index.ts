import { createStageWorker } from "./worker-app";
import { registerReferralSchedules } from "@clipclap/shared";
import { createReferralScheduler } from "./referral-scheduler";

const role = process.env.WORKER_ROLE;

console.log(`ClipClap worker starting with role=${role ?? "(empty)"}`);

const worker = createStageWorker(role);

let referralScheduler: ReturnType<typeof createReferralScheduler> | null = null;
if (role === "finalize") {
  referralScheduler = createReferralScheduler();
  void registerReferralSchedules().catch((err) =>
    console.error("[referral] failed to register schedules:", err)
  );
}

async function shutdown(signal: string) {
  console.log(`${signal} received; closing worker`);
  await worker.close();
  if (referralScheduler) await referralScheduler.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
