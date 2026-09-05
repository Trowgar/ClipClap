import { createHash, randomUUID } from "node:crypto";
import type { StageName } from "../lib/queues";
import { getRedis } from "../lib/redis";
import { sendTelegramMessage } from "./telegram-notification.service";

export const PIPELINE_INCIDENT_TTL_SECONDS = 24 * 60 * 60;
const PIPELINE_INCIDENT_LEASE_SECONDS = 10 * 60;
const ERROR_EXCERPT_LENGTH = 600;

export interface PipelineIncident {
  stage: StageName;
  queueJobId: string;
  pipelineJobId: string;
  attemptsMade: number;
  error: Error;
}

function errorExcerpt(message: string): string {
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.join("\n") || "Unknown error").slice(0, ERROR_EXCERPT_LENGTH);
}

function incidentKey(stage: StageName, error: Error): string {
  const signature = errorExcerpt(error.message)
    .replace(/c[a-z0-9]{20,}/gi, "<id>")
    .replace(/\d+/g, "#");
  const digest = createHash("sha256").update(`${stage}\n${signature}`).digest("hex").slice(0, 24);
  return `pipeline-incident:${stage}:${digest}`;
}

export async function notifyPipelineIncident(incident: PipelineIncident): Promise<boolean> {
  const chat = process.env.SUPPORT_CHAT_ID?.trim();
  if (!chat) return false;

  const redis = getRedis();
  const key = incidentKey(incident.stage, incident.error);
  const deliveredKey = `${key}:delivered`;
  const leaseKey = `${key}:sending`;
  if (await redis.get(deliveredKey)) return false;
  const leaseToken = randomUUID();
  const claimed = await redis.set(
    leaseKey,
    leaseToken,
    "EX",
    PIPELINE_INCIDENT_LEASE_SECONDS,
    "NX"
  );
  if (claimed !== "OK") return false;

  const text =
    `🚨 Pipeline job exhausted retries\n` +
    `stage=${incident.stage} job=${incident.pipelineJobId} queueJob=${incident.queueJobId} attempts=${incident.attemptsMade}\n\n` +
    errorExcerpt(incident.error.message);
  const sent = await sendTelegramMessage(chat, text);
  if (sent) {
    await redis.set(deliveredKey, new Date().toISOString(), "EX", PIPELINE_INCIDENT_TTL_SECONDS);
  }
  await redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    leaseKey,
    leaseToken
  );
  return sent;
}
