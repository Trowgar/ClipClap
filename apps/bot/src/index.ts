import { TelegramClient } from "./telegram-client";
import { deliverReadyTelegramJobs, handleUpdate } from "./handlers";
import { configureBotProfile } from "./setup";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

const apiBaseUrl = process.env.TELEGRAM_API_BASE_URL;
const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || "https://clipclap.io";
const tributeUrls = {
  starterWeekly: process.env.TRIBUTE_PRODUCT_STARTER_WEEKLY_URL,
  starter: process.env.TRIBUTE_PRODUCT_STARTER_MONTHLY_URL,
  plus: process.env.TRIBUTE_PRODUCT_PLUS_MONTHLY_URL,
  max: process.env.TRIBUTE_PRODUCT_MAX_MONTHLY_URL,
};
const client = new TelegramClient(token, apiBaseUrl);
console.log(`Telegram API base: ${apiBaseUrl || "cloud (api.telegram.org)"}`);
let offset: number | undefined;
let running = true;

console.log("ClipClap Telegram bot starting");

void (async () => {
  await configureBotProfile(client);
  console.log("Bot profile sync complete (en, ru) — check warnings above for any locale failures");
})();

void pollUpdates();
void pollDeliveries();

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function pollUpdates() {
  while (running) {
    try {
      const updates = await client.getUpdates(offset, 25);
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(client, update, { appUrl, tributeUrls });
      }
    } catch (error) {
      console.error("Telegram polling failed:", error);
      await sleep(3000);
    }
  }
}

async function pollDeliveries() {
  while (running) {
    try {
      await deliverReadyTelegramJobs(client);
    } catch (error) {
      console.error("Telegram delivery polling failed:", error);
    }
    await sleep(10_000);
  }
}

function shutdown(signal: string) {
  console.log(`${signal} received; stopping Telegram bot`);
  running = false;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
