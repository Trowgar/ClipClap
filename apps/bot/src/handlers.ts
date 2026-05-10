import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  canSubmitJob,
  createTelegramDelivery,
  findOrCreateTelegramUser,
  getPlanLimits,
  getPresignedDownloadUrl,
  jobService,
  markTelegramDeliveryFailed,
  markTelegramDeliverySent,
  prisma,
  telegramDeliveryService,
  uploadFile,
} from "@clipfast/shared";
import type { User } from "@prisma/client";
import type { TelegramClient } from "./telegram-client";
import type {
  TelegramDocument,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
  TelegramVideo,
} from "./types";

const ACTIVE_STATUSES = [
  "PENDING",
  "DOWNLOADING",
  "TRANSCRIBING",
  "ANALYZING",
  "CUTTING",
] as const;

export interface BotRuntimeConfig {
  appUrl: string;
}

export async function handleUpdate(
  client: TelegramClient,
  update: TelegramUpdate,
  config: BotRuntimeConfig
) {
  const message = update.message;
  if (!message?.from) return;

  if (message.text?.startsWith("/start")) {
    await handleStart(client, message, config);
    return;
  }

  const source = getVideoSource(message);
  if (!source) {
    await client.sendMessage(
      message.chat.id,
      "Send me a video and I will turn it into vertical clips. Use /start to connect your account."
    );
    return;
  }

  await handleVideo(client, message, message.from, source, config);
}

export async function deliverReadyTelegramJobs(client: TelegramClient) {
  const deliveries = await telegramDeliveryService.getPendingTelegramDeliveries();

  for (const delivery of deliveries) {
    try {
      if (delivery.job.status === "FAILED") {
        await client.sendMessage(
          delivery.chatId,
          `Processing failed: ${delivery.job.error || "Unknown error"}`
        );
        await markTelegramDeliveryFailed(
          delivery.id,
          delivery.job.error || "Job failed"
        );
        continue;
      }

      await client.sendMessage(
        delivery.chatId,
        `Done. ${delivery.job.clips.length} clips are ready.`
      );

      for (const clip of delivery.job.clips) {
        const url = await getPresignedDownloadUrl(clip.storageKey);
        await client.sendVideo(delivery.chatId, url, clip.title);
      }

      await markTelegramDeliverySent(delivery.id);
    } catch (error) {
      await markTelegramDeliveryFailed(
        delivery.id,
        error instanceof Error ? error.message : "Delivery failed"
      );
    }
  }
}

async function handleStart(
  client: TelegramClient,
  message: TelegramMessage,
  config: BotRuntimeConfig
) {
  const user = await resolveTelegramUser(message.from!);
  const usage = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  if (usage.plan === "NONE") {
    await client.sendMessage(
      message.chat.id,
      `Connected. Open ${config.appUrl}/login and continue with Telegram to activate a plan.`
    );
    return;
  }

  await client.sendMessage(
    message.chat.id,
    "Connected. Send a video here and I will return the generated clips."
  );
}

async function handleVideo(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  source: VideoSource,
  config: BotRuntimeConfig
) {
  const user = await resolveTelegramUser(from);
  const blockedReason = await getSubmissionBlocker(user.id, source.duration);
  if (blockedReason) {
    await client.sendMessage(
      message.chat.id,
      `${blockedReason}\n\nManage your plan: ${config.appUrl}/dashboard/plans`
    );
    return;
  }

  await client.sendMessage(message.chat.id, "Uploading your video...");

  const tempDir = join(tmpdir(), "clipclap-telegram");
  await mkdir(tempDir, { recursive: true });
  const tempPath = join(tempDir, `${source.fileUniqueId}.mp4`);

  try {
    await client.downloadFile(source.fileId, tempPath);

    const sourceKey = `uploads/${user.id}/telegram/${Date.now()}-${source.fileUniqueId}.mp4`;
    await uploadFile(sourceKey, tempPath, source.mimeType || "video/mp4");

    const job = await jobService.createJob({
      userId: user.id,
      sourceKey,
      originalFilename: source.fileName || "telegram-video.mp4",
      subtitles: true,
      subtitlePreset: "tiktok",
      sourceDurationSec: source.duration,
    });

    await createTelegramDelivery({
      jobId: job.id,
      userId: user.id,
      chatId: String(message.chat.id),
    });

    await client.sendMessage(
      message.chat.id,
      "Queued. I will send the clips back here when rendering finishes."
    );
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function resolveTelegramUser(from: TelegramUser): Promise<User> {
  return findOrCreateTelegramUser({
    id: from.id,
    firstName: from.first_name,
    lastName: from.last_name,
    username: from.username,
  });
}

async function getSubmissionBlocker(userId: string, durationSec?: number) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.plan === "NONE") {
    return "Active subscription required to process videos.";
  }

  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");
  const durationMinutes =
    typeof durationSec === "number" && durationSec > 0
      ? Math.ceil(durationSec / 60)
      : 0;

  if (
    durationMinutes > 0 &&
    durationMinutes > limits.maxSourceDurationMinutes
  ) {
    return `Source exceeds max duration (${limits.maxSourceDurationMinutes} min).`;
  }

  const submission = await canSubmitJob(userId, durationMinutes);
  if (!submission.allowed) return submission.reason;

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const jobsToday = await prisma.job.count({
    where: { userId, createdAt: { gte: dayStart } },
  });
  if (jobsToday >= limits.maxJobsPerDay) {
    return `Daily job limit reached (${limits.maxJobsPerDay}).`;
  }

  const inFlight = await prisma.job.count({
    where: { userId, status: { in: [...ACTIVE_STATUSES] } },
  });
  if (inFlight >= limits.concurrentJobsLimit) {
    return `You have ${inFlight} active jobs (limit: ${limits.concurrentJobsLimit}).`;
  }

  return null;
}

interface VideoSource {
  fileId: string;
  fileUniqueId: string;
  duration?: number;
  fileName?: string;
  mimeType?: string;
}

function getVideoSource(message: TelegramMessage): VideoSource | null {
  if (message.video) return fromTelegramVideo(message.video);
  if (message.document?.mime_type?.startsWith("video/")) {
    return fromTelegramDocument(message.document);
  }
  return null;
}

function fromTelegramVideo(video: TelegramVideo): VideoSource {
  return {
    fileId: video.file_id,
    fileUniqueId: video.file_unique_id,
    duration: video.duration,
    fileName: video.file_name,
    mimeType: video.mime_type,
  };
}

function fromTelegramDocument(document: TelegramDocument): VideoSource {
  return {
    fileId: document.file_id,
    fileUniqueId: document.file_unique_id,
    fileName: document.file_name,
    mimeType: document.mime_type,
  };
}
