import { createStageWorker } from "./worker-app";
import { audioPricePerMinute, loadModelPrices, registerReferralSchedules, tokenPrice } from "@clipclap/shared";
import { createReferralScheduler } from "./referral-scheduler";
import { loadAnalyzeConfig } from "./analyze-v2/config";
import { highlightsModel, transcriptionModel } from "./model-selection";

const role = process.env.WORKER_ROLE;

console.log(`ClipClap worker starting with role=${role ?? "(empty)"}`);

/**
 * A missing price is not fatal - jobs still run, they just record no cost - so
 * the only thing standing between it and going unnoticed is this line. Emitted
 * at boot rather than at the first job, because the first job may be hours away
 * and by then the log has scrolled.
 *
 * This reads the REAL environment, which is what makes it different from the
 * price-table test: that test can only see the shipped defaults, because no
 * process inside a container can read .env. An operator who points
 * OPENAI_CRITIC_MODEL at an unpriced model is caught here and nowhere else.
 */
function warnAboutMissingPrices(): void {
  const prices = loadModelPrices();
  const cfg = loadAnalyzeConfig();
  const missing: string[] = [];
  for (const model of [
    cfg.scanModel,
    cfg.criticModel,
    cfg.criticModelFallback,
    cfg.finalizerModel,
    highlightsModel(),
  ]) {
    if (tokenPrice(prices, model) === undefined) missing.push(model);
  }
  const asr = transcriptionModel();
  if (audioPricePerMinute(prices, asr) === undefined) missing.push(asr);
  if (missing.length > 0) {
    console.warn(
      `[cost] no price in MODEL_PRICES_JSON for: ${[...new Set(missing)].join(", ")}. ` +
        `Those jobs will record no cost figure. Add them to .env and restart.`
    );
  }
}

warnAboutMissingPrices();

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
