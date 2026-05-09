import { createStageWorker } from "./worker-app";

const role = process.env.WORKER_ROLE;

console.log(`ClipClap worker starting with role=${role ?? "(empty)"}`);

const worker = createStageWorker(role);

async function shutdown(signal: string) {
  console.log(`${signal} received; closing worker`);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
