import { Prisma, type PrismaClient } from "@prisma/client";

import { canonicalJson } from "./canonical";
import type { FeedbackProjection, JobProjection } from "./types";

const TRANSACTION_TIMEOUT_MS = 15_000;
const FEEDBACK_SELECT = {
  id: true,
  clipId: true,
  jobId: true,
  userId: true,
  verdict: true,
  note: true,
  snapshot: true,
  evidenceKey: true,
  updatedAt: true,
} as const;
const JOB_SELECT = {
  id: true,
  transcriptJson: true,
  transcriptPartial: true,
} as const;

export type SnapshotRequest = Readonly<{
  updatedFrom: Date;
  updatedTo: Date;
  activeApprovalFeedbackIds: readonly string[];
}>;

export type ReviewSnapshotRequest = Readonly<{
  candidateFeedbackId: string;
  activeApprovalFeedbackIds: readonly string[];
}>;

export type DatabaseSnapshot = Readonly<{
  feedback: readonly FeedbackProjection[];
  jobs: readonly JobProjection[];
  currentApprovals: readonly FeedbackProjection[];
}>;

export type ReviewDatabaseSnapshot = Readonly<{
  candidate: FeedbackProjection | null;
  currentApprovals: readonly FeedbackProjection[];
}>;

export interface FeedbackLearningRepository {
  captureExportSnapshot(input: SnapshotRequest): Promise<DatabaseSnapshot>;
  captureReviewSnapshot(input: ReviewSnapshotRequest): Promise<ReviewDatabaseSnapshot>;
}

function invalidRequest(): never {
  throw new TypeError("snapshot_request_invalid");
}

function dateMilliseconds(value: unknown): number | undefined {
  try {
    const milliseconds = Date.prototype.getTime.call(value);
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  } catch {
    return undefined;
  }
}

function sortedUniqueIds(value: readonly string[]): string[] {
  if (!Array.isArray(value)) return invalidRequest();
  const unique = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || id.length === 0) return invalidRequest();
    unique.add(id);
  }
  return [...unique].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
}

function copyJson(value: unknown): unknown {
  return JSON.parse(canonicalJson(value)) as unknown;
}

function copyFeedback(row: FeedbackProjection): FeedbackProjection {
  return {
    id: row.id,
    clipId: row.clipId,
    jobId: row.jobId,
    userId: row.userId,
    verdict: row.verdict,
    note: row.note,
    snapshot: copyJson(row.snapshot),
    evidenceKey: row.evidenceKey,
    updatedAt: new Date(row.updatedAt.getTime()),
  };
}

function copyJob(row: JobProjection): JobProjection {
  return {
    id: row.id,
    transcriptJson: copyJson(row.transcriptJson),
    transcriptPartial: row.transcriptPartial,
  };
}

function transactionOptions() {
  return {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    timeout: TRANSACTION_TIMEOUT_MS,
  } as const;
}

export function createPrismaFeedbackLearningRepository(
  client: PrismaClient,
): FeedbackLearningRepository {
  return Object.freeze({
    async captureExportSnapshot(input: SnapshotRequest): Promise<DatabaseSnapshot> {
      const fromMs = dateMilliseconds(input?.updatedFrom);
      const toMs = dateMilliseconds(input?.updatedTo);
      if (fromMs === undefined || toMs === undefined || fromMs >= toMs) return invalidRequest();
      const approvalIds = sortedUniqueIds(input.activeApprovalFeedbackIds);
      const updatedFrom = new Date(fromMs);
      const updatedTo = new Date(toMs);

      return client.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        const feedback = await transaction.clipFeedback.findMany({
          where: {
            verdict: "AS_IS",
            updatedAt: { gte: updatedFrom, lt: updatedTo },
          },
          select: FEEDBACK_SELECT,
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        });
        const jobIds = sortedUniqueIds(feedback.map((row) => row.jobId));
        const jobs = await transaction.job.findMany({
          where: { id: { in: jobIds } },
          select: JOB_SELECT,
          orderBy: { id: "asc" },
        });
        const currentApprovals = await transaction.clipFeedback.findMany({
          where: { id: { in: approvalIds } },
          select: FEEDBACK_SELECT,
          orderBy: { id: "asc" },
        });
        return {
          feedback: feedback.map(copyFeedback),
          jobs: jobs.map(copyJob),
          currentApprovals: currentApprovals.map(copyFeedback),
        };
      }, transactionOptions());
    },

    async captureReviewSnapshot(input: ReviewSnapshotRequest): Promise<ReviewDatabaseSnapshot> {
      if (
        !input ||
        typeof input.candidateFeedbackId !== "string" ||
        input.candidateFeedbackId.length === 0
      ) {
        return invalidRequest();
      }
      const approvalIds = sortedUniqueIds(input.activeApprovalFeedbackIds);
      const candidateFeedbackId = input.candidateFeedbackId;

      return client.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        const candidate = await transaction.clipFeedback.findUnique({
          where: { id: candidateFeedbackId },
          select: FEEDBACK_SELECT,
        });
        const currentApprovals = await transaction.clipFeedback.findMany({
          where: { id: { in: approvalIds } },
          select: FEEDBACK_SELECT,
          orderBy: { id: "asc" },
        });
        return {
          candidate: candidate === null ? null : copyFeedback(candidate),
          currentApprovals: currentApprovals.map(copyFeedback),
        };
      }, transactionOptions());
    },
  });
}
