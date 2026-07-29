import { prisma } from "../lib/prisma";
import { deleteFile, getPresignedDownloadUrl } from "../lib/r2";
import { parseJobErrorCode, type JobErrorCode } from "../lib/job-error";
import { settleFreeLedgerOnDelete } from "./free-tier.service";
import type { JobStatus, NoClipsReason } from "@prisma/client";

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
  description: string | null;
  lowQuality: boolean;
  /** The retention sweep dropped the object. The row is kept on purpose - a
   *  clip that silently vanishes reads as data loss, an expired one does not. */
  expired: boolean;
}

export interface ProjectSummary {
  id: string;
  userId: string;
  title: string;
  sourceUrl: string | null;
  sourceKey: string | null;
  status: JobStatus;
  /** Same rule as ProjectDetail: code only, never the raw engine prose. */
  errorCode: JobErrorCode | null;
  sourceDurationSec: number | null;
  createdAt: Date;
  clipCount: number;
  previewUrl: string | null;
  thumbnailUrl: string | null;
  clips: ProjectClipSummary[];
}

export interface ProjectDetail {
  id: string;
  userId: string;
  title: string;
  sourceUrl: string | null;
  sourceKey: string | null;
  status: JobStatus;
  /** The ONLY failure signal that crosses into the UI. Raw Job.error is engineer
   *  prose ("critic produced 0 usable verdicts...") and is deliberately absent
   *  from this DTO: the project page serializes the whole object into the RSC
   *  payload of a client component, so anything carried here is shipped to the
   *  browser whether or not a component renders it. Keeping the raw string out
   *  of the type makes "never render it" a fact instead of a convention. Read
   *  Job.error straight from the database for diagnostics.
   *  null means "no code we know" - the caller shows its generic failure copy. */
  errorCode: JobErrorCode | null;
  sourceDurationSec: number | null;
  createdAt: Date;
  clipsGenerated: number;
  noClipsReason: NoClipsReason | null;
  transcriptPartial: boolean;
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
      deletedAt: true,
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
      description: true,
      lowQuality: true,
      deletedAt: true,
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
    errorCode: parseJobErrorCode(job.error),
    sourceDurationSec: job.sourceDurationSec,
    createdAt: job.createdAt,
    clipsGenerated: job.clipsGenerated,
    noClipsReason: job.noClipsReason,
    transcriptPartial: job.transcriptPartial,
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
        description: clip.description,
        lowQuality: clip.lowQuality,
        previewUrl:
          clip.storageKey && !clip.deletedAt
            ? await getPresignedDownloadUrl(clip.storageKey)
            : null,
        expired: Boolean(clip.deletedAt),
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
    thumbnailKey: string | null;
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
      deletedAt: Date | null;
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
  thumbnailKey: string | null;
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
    deletedAt: Date | null;
  }>;
}): Promise<ProjectSummary> {
  const previewClip = job.clips.find(
    (clip) => clip.storageKey.length > 0 && !clip.deletedAt
  );
  const previewUrl = previewClip
    ? await getPresignedDownloadUrl(previewClip.storageKey)
    : null;
  const thumbnailUrl = job.thumbnailKey
    ? await getPresignedDownloadUrl(job.thumbnailKey)
    : null;

  return {
    id: job.id,
    userId: job.userId,
    title: job.originalFilename || job.sourceUrl || "Untitled project",
    sourceUrl: job.sourceUrl,
    sourceKey: job.sourceKey,
    status: job.status,
    errorCode: parseJobErrorCode(job.error),
    sourceDurationSec: job.sourceDurationSec,
    createdAt: job.createdAt,
    clipCount: job.clips.length,
    previewUrl,
    thumbnailUrl,
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
      status: true,
      clipsGenerated: true,
      sourceKey: true,
      sourceArtifactKey: true,
      normalizedArtifactKey: true,
      thumbnailKey: true,
      clips: { select: { storageKey: true } },
    },
  });
  if (!job) return { status: "not_found" };

  // BEFORE the delete, and it cannot move after it.
  //
  // The refund sweep answers "does this charge deserve its allowance back?" by
  // joining free_usage to jobs, so the line below - which hard-deletes the job -
  // is the moment that question stops having an answer. Settling first is what
  // stops a user clearing away a project we broke and losing their trial for it.
  // See settleFreeLedgerOnDelete for the rules and for what an in-flight job
  // gets.
  //
  // Deliberately NOT wrapped in a try/catch. A settlement that throws leaves the
  // job row in place, so the delete fails, the user retries, and the sweep can
  // still reach the row in the meantime - every path stays recoverable. Deleting
  // anyway on a ledger error would strand exactly the charge this call exists to
  // release, which is the one outcome nothing downstream can undo.
  await settleFreeLedgerOnDelete(userId, job.id, {
    status: job.status,
    clipsGenerated: job.clipsGenerated,
  });

  // A Set, not an array: normalizeSource returning "none" stores the SAME key
  // in sourceArtifactKey and normalizedArtifactKey, and deleting it twice logs
  // a failure for an object that is already gone.
  const r2Keys = [
    ...new Set(
      [
        job.sourceKey,
        job.sourceArtifactKey,
        job.normalizedArtifactKey,
        job.thumbnailKey,
        ...job.clips.map((c) => c.storageKey),
      ].filter((key): key is string => Boolean(key))
    ),
  ];

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
