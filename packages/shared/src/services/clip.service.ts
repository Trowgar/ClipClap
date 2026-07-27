import { prisma } from "../lib/prisma";
import { getPresignedDownloadUrl, deleteFile } from "../lib/r2";
import { getStageQueue } from "../lib/queues";
import { computeClipExpiresAt } from "../lib/retention";
import type { Clip, Prisma } from "@prisma/client";
import type { EditClipInput } from "../types";

export async function getClipsByJob(
  jobId: string,
  userId: string
): Promise<Clip[]> {
  return prisma.clip.findMany({
    where: { jobId, userId },
    orderBy: [{ score: { sort: "desc", nulls: "last" } }, { startTime: "asc" }],
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

/** The clip existed and its retention period ended. Distinct from "not found"
 *  because the answers differ: one is a 404, the other is a 410 with copy that
 *  tells the user what happened to their clip. */
export class ClipExpiredError extends Error {
  constructor(clipId: string) {
    super(`Clip ${clipId} is past its retention period`);
    this.name = "ClipExpiredError";
  }
}

export async function getDownloadUrl(
  clipId: string,
  userId: string
): Promise<string> {
  const clip = await prisma.clip.findFirst({
    where: { id: clipId, userId },
  });
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  // The bytes are gone; a signed URL here is a 404 from R2 inside a <video>
  // tag, which reads to the user as a broken product rather than an expiry.
  if (clip.deletedAt) throw new ClipExpiredError(clipId);
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

export async function editClip(input: EditClipInput): Promise<Clip> {
  const original = await prisma.clip.findFirstOrThrow({
    where: { id: input.clipId, userId: input.userId },
    include: { job: true },
  });

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { plan: true, billingCycle: true },
  });
  const expiresAt = computeClipExpiresAt(user.plan, user.billingCycle);

  // Create a new clip record as a placeholder
  const newClip = await prisma.clip.create({
    data: {
      jobId: original.jobId,
      userId: input.userId,
      title: `${original.title} (edited)`,
      storageKey: "", // will be set by worker
      duration: Math.round(input.end - input.start),
      startTime: input.start,
      endTime: input.end,
      subtitles: input.subtitles,
      subtitleTrack:
        (input.subtitleTrack as unknown as Prisma.InputJsonValue) ?? undefined,
      parentClipId: original.id,
      expiresAt,
    },
  });

  const relativeStart = Math.max(0, input.start - original.startTime);
  const relativeEnd = Math.max(relativeStart, input.end - original.startTime);

  await getStageQueue("render").add("render", {
    clipId: newClip.id,
    originalClipStorageKey: original.storageKey,
    jobId: original.jobId,
    userId: input.userId,
    start: relativeStart,
    end: relativeEnd,
    subtitles: input.subtitles,
    subtitleTrack: input.subtitleTrack,
    sourceArtifactKey:
      original.job.normalizedArtifactKey ??
      original.job.sourceArtifactKey ??
      undefined,
    sourceStart: input.start,
    sourceEnd: input.end,
    mode: "trim",
  });

  return newClip;
}
