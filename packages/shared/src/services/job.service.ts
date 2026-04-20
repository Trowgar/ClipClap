import { prisma } from "../lib/prisma";
import { getVideoQueue } from "../lib/queue";
import type { Job, JobStatus, Prisma } from "@prisma/client";
import type { CreateJobInput } from "../types";

export async function createJob(input: CreateJobInput): Promise<Job> {
  const job = await prisma.job.create({
    data: {
      userId: input.userId,
      sourceUrl: input.sourceUrl,
      sourceKey: input.sourceKey,
      originalFilename: input.originalFilename,
      subtitles: input.subtitles ?? true,
      subtitlePreset: input.subtitlePreset ?? "tiktok",
      status: "PENDING",
    },
  });

  await getVideoQueue().add("process-video", {
    jobId: job.id,
    userId: job.userId,
  });

  return job;
}

export async function getJob(
  jobId: string,
  userId: string
): Promise<Job | null> {
  return prisma.job.findFirst({
    where: { id: jobId, userId },
    include: { clips: true },
  });
}

export async function getUserJobs(userId: string): Promise<Job[]> {
  return prisma.job.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { clips: true },
    take: 50,
  });
}

export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  extra?: { error?: string; transcription?: string; highlights?: unknown }
): Promise<Job> {
  return prisma.job.update({
    where: { id: jobId },
    data: {
      status,
      ...(extra?.error ? { error: extra.error } : {}),
      ...(extra?.transcription ? { transcription: extra.transcription } : {}),
      ...(extra?.highlights
        ? { highlights: extra.highlights as Prisma.InputJsonValue }
        : {}),
    },
  });
}
