import { Prisma, type PrismaClient } from "@prisma/client";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import type { FeedbackProjection } from "../feedback-learning/types";
import type { ContentHash, PromotionIdentity, PromotionSnapshot, QualityClipProjection, QualityJobProjection } from "./promote";

const TRANSACTION_TIMEOUT_MS = 15_000;
const FEEDBACK_SELECT = {
  id: true, clipId: true, jobId: true, userId: true, surface: true, verdict: true,
  reason: true, note: true, snapshot: true, evidenceKey: true, locale: true, createdAt: true, updatedAt: true,
} as const;
const CLIP_SELECT = {
  id: true, jobId: true, storageKey: true, duration: true, startTime: true, endTime: true,
  title: true, subtitleTrack: true, cropPlan: true, language: true, clipKind: true,
  hookStart: true, hookEnd: true, payoffAt: true,
} as const;
const JOB_SELECT = {
  id: true, userId: true, transcriptJson: true, transcriptPartial: true,
  sourceKey: true, sourceArtifactKey: true, normalizedArtifactKey: true, sourceDurationSec: true,
} as const;

export class QualityPromotionRepositoryError extends Error {
  constructor(readonly code: "feedback_missing" | "clip_missing" | "job_missing" | "identity_mismatch" | "projection_invalid" | "database_failed") {
    super(code);
    this.name = "QualityPromotionRepositoryError";
  }
}

function dataObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new QualityPromotionRepositoryError("projection_invalid");
  return value as Record<string, unknown>;
}

function dateIso(value: unknown): string {
  try {
    const result = (value as Date).toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)) throw new Error();
    return result;
  } catch {
    throw new QualityPromotionRepositoryError("projection_invalid");
  }
}

function hashSnapshot(value: unknown): ContentHash {
  try { return sha256(canonicalJson(value)); }
  catch { throw new QualityPromotionRepositoryError("projection_invalid"); }
}

function projectionFeedback(raw: unknown): FeedbackProjection {
  const value = dataObject(raw);
  if (typeof value.id !== "string" || typeof value.clipId !== "string" || typeof value.jobId !== "string" || typeof value.userId !== "string" ||
      typeof value.verdict !== "string" || (value.reason !== null && typeof value.reason !== "string") ||
      (value.note !== null && typeof value.note !== "string") || (value.evidenceKey !== null && typeof value.evidenceKey !== "string")) {
    throw new QualityPromotionRepositoryError("projection_invalid");
  }
  dateIso(value.updatedAt);
  return value as unknown as FeedbackProjection;
}

function projectionClip(raw: unknown): QualityClipProjection {
  const value = dataObject(raw);
  if (typeof value.id !== "string" || typeof value.jobId !== "string" || typeof value.storageKey !== "string" ||
      typeof value.duration !== "number" || !Number.isFinite(value.duration) || typeof value.startTime !== "number" ||
      typeof value.endTime !== "number" || !Number.isFinite(value.startTime) || !Number.isFinite(value.endTime)) {
    throw new QualityPromotionRepositoryError("projection_invalid");
  }
  return value as unknown as QualityClipProjection;
}

function projectionJob(raw: unknown): QualityJobProjection {
  const value = dataObject(raw);
  if (typeof value.id !== "string" || typeof value.userId !== "string" || typeof value.transcriptPartial !== "boolean" ||
      (value.sourceKey !== null && typeof value.sourceKey !== "string") ||
      (value.sourceArtifactKey !== null && typeof value.sourceArtifactKey !== "string") ||
      (value.normalizedArtifactKey !== null && typeof value.normalizedArtifactKey !== "string") ||
      (value.sourceDurationSec !== null && (typeof value.sourceDurationSec !== "number" || !Number.isFinite(value.sourceDurationSec)))) {
    throw new QualityPromotionRepositoryError("projection_invalid");
  }
  return value as unknown as QualityJobProjection;
}

function candidateVersion(input: Pick<PromotionIdentity, "feedbackId" | "feedbackUpdatedAt" | "snapshotSha256">): ContentHash {
  return sha256(`${input.feedbackId}\n${input.feedbackUpdatedAt}\n${input.snapshotSha256}`);
}

function assertIdentity(input: PromotionIdentity, feedback: FeedbackProjection): void {
  const currentUpdatedAt = dateIso(feedback.updatedAt);
  if (feedback.id !== input.feedbackId || feedback.clipId !== input.clipId || feedback.jobId !== input.jobId || feedback.userId !== input.userId || currentUpdatedAt !== input.feedbackUpdatedAt ||
      hashSnapshot(feedback.snapshot) !== input.snapshotSha256 || candidateVersion(input) !== input.candidateVersion) {
    throw new QualityPromotionRepositoryError("identity_mismatch");
  }
}

function transactionOptions() {
  return { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: TRANSACTION_TIMEOUT_MS } as const;
}

export interface QualityPromotionRepository {
  capture(input: PromotionIdentity): Promise<PromotionSnapshot>;
}

export function createPrismaQualityPromotionRepository(client: PrismaClient): QualityPromotionRepository {
  return Object.freeze({
    async capture(input: PromotionIdentity): Promise<PromotionSnapshot> {
      try {
        return await client.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
          const rawFeedback = await transaction.clipFeedback.findUnique({ where: { id: input.feedbackId }, select: FEEDBACK_SELECT });
          if (rawFeedback === null) throw new QualityPromotionRepositoryError("feedback_missing");
          const feedback = projectionFeedback(rawFeedback);
          assertIdentity(input, feedback);
          const rawClip = await transaction.clip.findUnique({ where: { id: feedback.clipId }, select: CLIP_SELECT });
          if (rawClip === null) throw new QualityPromotionRepositoryError("clip_missing");
          const clip = projectionClip(rawClip);
          if (clip.jobId !== feedback.jobId || clip.id !== input.clipId) throw new QualityPromotionRepositoryError("identity_mismatch");
          const rawJob = await transaction.job.findUnique({ where: { id: feedback.jobId }, select: JOB_SELECT });
          if (rawJob === null) throw new QualityPromotionRepositoryError("job_missing");
          const job = projectionJob(rawJob);
          if (job.userId !== feedback.userId || job.id !== input.jobId) throw new QualityPromotionRepositoryError("identity_mismatch");
          return { feedback, clip, job };
        }, transactionOptions());
      } catch (error) {
        if (error instanceof QualityPromotionRepositoryError) throw error;
        throw new QualityPromotionRepositoryError("database_failed");
      }
    },
  });
}
