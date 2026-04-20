import { prisma } from "../lib/prisma";
import { getPresignedDownloadUrl, deleteFile } from "../lib/r2";
import { getVideoQueue } from "../lib/queue";
import type { Clip } from "@prisma/client";
import type { TrimClipInput } from "../types";

export async function getClipsByJob(
  jobId: string,
  userId: string
): Promise<Clip[]> {
  return prisma.clip.findMany({
    where: { jobId, userId },
    orderBy: { startTime: "asc" },
  });
}

export async function getUserClips(userId: string): Promise<Clip[]> {
  return prisma.clip.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function getClip(
  clipId: string,
  userId: string
): Promise<Clip | null> {
  return prisma.clip.findFirst({
    where: { id: clipId, userId },
  });
}

export async function getDownloadUrl(
  clipId: string,
  userId: string
): Promise<string> {
  const clip = await prisma.clip.findFirstOrThrow({
    where: { id: clipId, userId },
  });
  return getPresignedDownloadUrl(clip.storageKey);
}

export async function deleteClip(
  clipId: string,
  userId: string
): Promise<void> {
  const clip = await prisma.clip.findFirstOrThrow({
    where: { id: clipId, userId },
  });

  await deleteFile(clip.storageKey);
  await prisma.clip.delete({ where: { id: clipId } });
}

export async function trimClip(input: TrimClipInput): Promise<Clip> {
  const original = await prisma.clip.findFirstOrThrow({
    where: { id: input.clipId, userId: input.userId },
    include: { job: true },
  });

  // Create a new clip record as a placeholder
  const newClip = await prisma.clip.create({
    data: {
      jobId: original.jobId,
      userId: input.userId,
      title: `${original.title} (trimmed)`,
      storageKey: "", // will be set by worker
      duration: Math.round(input.end - input.start),
      startTime: input.start,
      endTime: input.end,
      subtitles: input.subtitles,
      subtitlePreset: input.subtitlePreset,
      parentClipId: original.id,
    },
  });

  // Enqueue a trim job
  await getVideoQueue().add("trim-clip", {
    clipId: newClip.id,
    originalClipStorageKey: original.storageKey,
    jobId: original.jobId,
    userId: input.userId,
    start: input.start,
    end: input.end,
    subtitles: input.subtitles,
    subtitlePreset: input.subtitlePreset,
  });

  return newClip;
}
