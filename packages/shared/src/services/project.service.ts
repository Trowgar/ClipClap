import { prisma } from "../lib/prisma";
import { deleteFile, getPresignedDownloadUrl } from "../lib/r2";
import type { JobStatus } from "@prisma/client";

export interface ProjectClipSummary {
  id: string;
  title: string;
  duration: number;
  createdAt: Date;
}

export interface ProjectDetailClip extends ProjectClipSummary {
  startTime: number;
  endTime: number;
  subtitles: boolean;
  parentClipId: string | null;
  previewUrl: string | null;
}

export interface ProjectSummary {
  id: string;
  userId: string;
  title: string;
  sourceUrl: string | null;
  sourceKey: string | null;
  status: JobStatus;
  error: string | null;
  sourceDurationSec: number | null;
  createdAt: Date;
  clipCount: number;
  previewUrl: string | null;
  clips: ProjectClipSummary[];
}

export interface ProjectDetail {
  id: string;
  userId: string;
  title: string;
  sourceUrl: string | null;
  sourceKey: string | null;
  status: JobStatus;
  error: string | null;
  sourceDurationSec: number | null;
  createdAt: Date;
  clipsGenerated: number;
  clips: ProjectDetailClip[];
}

export interface RecentProjectsResult {
  projects: ProjectSummary[];
  hasMore: boolean;
}

const PROJECT_INCLUDE = {
  clips: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      title: true,
      storageKey: true,
      duration: true,
      createdAt: true,
    },
  },
};

const PROJECT_DETAIL_INCLUDE = {
  clips: {
    orderBy: { startTime: "asc" as const },
    select: {
      id: true,
      title: true,
      storageKey: true,
      duration: true,
      startTime: true,
      endTime: true,
      subtitles: true,
      parentClipId: true,
      createdAt: true,
    },
  },
};

export async function getRecentProjects(
  userId: string,
  limit = 3
): Promise<RecentProjectsResult> {
  const jobs = await prisma.job.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: PROJECT_INCLUDE,
    take: limit + 1,
  });

  return {
    projects: await toProjectSummaries(jobs.slice(0, limit)),
    hasMore: jobs.length > limit,
  };
}

export async function getUserProjects(
  userId: string,
  take = 50
): Promise<ProjectSummary[]> {
  const jobs = await prisma.job.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: PROJECT_INCLUDE,
    take,
  });

  return toProjectSummaries(jobs);
}

export async function getProjectDetail(
  projectId: string,
  userId: string
): Promise<ProjectDetail | null> {
  const jobs = await prisma.job.findMany({
    where: { id: projectId, userId },
    orderBy: { createdAt: "desc" },
    include: PROJECT_DETAIL_INCLUDE,
    take: 1,
  });
  const job = jobs[0];
  if (!job) return null;

  return {
    id: job.id,
    userId: job.userId,
    title: job.originalFilename || job.sourceUrl || "Untitled project",
    sourceUrl: job.sourceUrl,
    sourceKey: job.sourceKey,
    status: job.status,
    error: job.error,
    sourceDurationSec: job.sourceDurationSec,
    createdAt: job.createdAt,
    clipsGenerated: job.clipsGenerated,
    clips: await Promise.all(
      job.clips.map(async (clip) => ({
        id: clip.id,
        title: clip.title,
        duration: clip.duration,
        startTime: clip.startTime,
        endTime: clip.endTime,
        subtitles: clip.subtitles,
        parentClipId: clip.parentClipId,
        createdAt: clip.createdAt,
        previewUrl: clip.storageKey
          ? await getPresignedDownloadUrl(clip.storageKey)
          : null,
      }))
    ),
  };
}

async function toProjectSummaries(
  jobs: Array<{
    id: string;
    userId: string;
    sourceUrl: string | null;
    sourceKey: string | null;
    originalFilename: string | null;
    status: JobStatus;
    error: string | null;
    sourceDurationSec: number | null;
    createdAt: Date;
    clips: Array<{
      id: string;
      title: string;
      storageKey: string;
      duration: number;
      createdAt: Date;
    }>;
  }>
): Promise<ProjectSummary[]> {
  return Promise.all(jobs.map(toProjectSummary));
}

async function toProjectSummary(job: {
  id: string;
  userId: string;
  sourceUrl: string | null;
  sourceKey: string | null;
  originalFilename: string | null;
  status: JobStatus;
  error: string | null;
  sourceDurationSec: number | null;
  createdAt: Date;
  clips: Array<{
    id: string;
    title: string;
    storageKey: string;
    duration: number;
    createdAt: Date;
  }>;
}): Promise<ProjectSummary> {
  const previewClip = job.clips.find((clip) => clip.storageKey.length > 0);
  const previewUrl = previewClip
    ? await getPresignedDownloadUrl(previewClip.storageKey)
    : null;

  return {
    id: job.id,
    userId: job.userId,
    title: job.originalFilename || job.sourceUrl || "Untitled project",
    sourceUrl: job.sourceUrl,
    sourceKey: job.sourceKey,
    status: job.status,
    error: job.error,
    sourceDurationSec: job.sourceDurationSec,
    createdAt: job.createdAt,
    clipCount: job.clips.length,
    previewUrl,
    clips: job.clips.map((clip) => ({
      id: clip.id,
      title: clip.title,
      duration: clip.duration,
      createdAt: clip.createdAt,
    })),
  };
}

export type DeleteProjectResult =
  | { status: "deleted"; deletedClips: number }
  | { status: "not_found" };

export async function deleteProject(
  projectId: string,
  userId: string
): Promise<DeleteProjectResult> {
  const job = await prisma.job.findFirst({
    where: { id: projectId, userId },
    select: {
      id: true,
      sourceKey: true,
      sourceArtifactKey: true,
      clips: { select: { storageKey: true } },
    },
  });
  if (!job) return { status: "not_found" };

  const r2Keys = [
    job.sourceKey,
    job.sourceArtifactKey,
    ...job.clips.map((c) => c.storageKey),
  ].filter((key): key is string => Boolean(key));

  // Delete DB record first - Prisma cascades to clips, steps, deliveries.
  await prisma.job.delete({ where: { id: job.id } });

  // Best-effort R2 cleanup. Don't fail the operation if R2 hiccups -
  // orphan keys are recoverable via a retention sweep, but a half-deleted DB
  // state is not.
  await Promise.allSettled(
    r2Keys.map((key) =>
      deleteFile(key).catch((error) => {
        console.error(`[deleteProject] failed to delete R2 key ${key}:`, error);
        throw error;
      })
    )
  );

  return { status: "deleted", deletedClips: job.clips.length };
}
