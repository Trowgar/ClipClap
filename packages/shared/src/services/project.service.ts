import { prisma } from "../lib/prisma";
import { getPresignedDownloadUrl } from "../lib/r2";
import type { JobStatus } from "@prisma/client";

export interface ProjectClipSummary {
  id: string;
  title: string;
  duration: number;
  createdAt: Date;
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
