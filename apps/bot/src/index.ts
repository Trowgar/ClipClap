import { TelegramClient } from "./telegram-client";
import {
  deliverReadyTelegramJobs,
  handleUpdate,
  updateTelegramProgressBoards,
} from "./handlers";
import { configureBotProfile } from "./setup";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

const apiBaseUrl = process.env.TELEGRAM_API_BASE_URL;
const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || "https://clipclap.io";
const client = new TelegramClient(token, apiBaseUrl);
console.log(`Telegram API base: ${apiBaseUrl || "cloud (api.telegram.org)"}`);
let offset: number | undefined;
let running = true;

console.log("ClipClap Telegram bot starting");

void (async () => {
  // Real counts, not a fixed string. The old line read "sync complete (en, ru)"
  // - a locale list hardcoded back when there were two of them, printed
  // unconditionally - so it announced success under seven consecutive rate-limit
  // failures and told nobody that the profile had been left half-written.
  const { updated, current, failed } = await configureBotProfile(client);
  console.log(
    `Bot profile sync: ${updated} updated, ${current} already current, ${failed} failed`
  );
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
        await handleUpdate(client, update, { appUrl });
      }
    } catch (error) {
      console.error("Telegram polling failed:", error);
      await sleep(3000);
    }
  }
}

async function pollDeliveries() {
  while (running) {
    // Deliveries first: a finished job getting its clips outranks a running one
    // getting a nicer wait, and the delivery pass draws the board's last frame
    // itself. Separate try blocks so a failure in either cannot stop the other -
    // the progress board is a courtesy and must never cost anyone a clip.
    try {
      await deliverReadyTelegramJobs(client, appUrl);
    } catch (error) {
      console.error("Telegram delivery polling failed:", error);
    }
    try {
      await updateTelegramProgressBoards(client);
    } catch (error) {
      console.error("Telegram progress polling failed:", error);
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
