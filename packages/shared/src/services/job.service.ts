import { prisma } from "../lib/prisma";
import { getStageQueue } from "../lib/queues";
import type { Job, JobStatus, Prisma } from "@prisma/client";
import type { CreateJobInput } from "../types";

/**
 * BullMQ priority for a job running on the free allowance.
 *
 * Verified against the installed bullmq 5 rather than assumed: moveToActive-11
 * does `RPOPLPUSH(wait -> active)` FIRST and only reaches the prioritized set
 * when `wait` comes back empty, and addJob only routes a job into the
 * prioritized set when `opts.priority` is truthy. So a paid job - which passes
 * no priority at all and therefore lands in `wait` - is taken before every free
 * job that is waiting, and a paying user can never queue behind a free one.
 *
 * The exact number does not matter while this is the only priority in the
 * system; it matters that it is > 0, which is what moves the job off the wait
 * list. Left at 10 so a future "slightly less urgent than paid" tier has room
 * underneath it.
 */
const FREE_JOB_PRIORITY = 10;

/**
 * Creates the Job row and, for a free account, its reservation - then enqueues.
 *
 * The transaction is the point. This function is the only place a video job is
 * enqueued, and the download stage can be picked up by a worker the instant the
 * add lands. Charging after the add is therefore a real race, not a theoretical
 * one: the worker can reach TRANSCRIBE - where the money actually leaves - with
 * no ledger row yet written, and a crash between the two leaves free work that
 * was never charged and an allowance that never went down. Row and reservation
 * commit together, and the enqueue happens only once they have.
 *
 * A P2002 from the freeUsage insert is deliberately NOT swallowed here, unlike
 * in chargeFreeSeconds. That function is idempotent because it is called with a
 * jobId that already exists; here the jobId was minted by the line above it
 * inside the same transaction, so a unique-constraint hit on
 * (userId, jobId, kind) means a cuid collided or something is writing rows we
 * do not know about - neither of which should quietly produce an enqueued job.
 * It is also not survivable in place: Postgres aborts the surrounding
 * transaction on the failed statement, so "catch and carry on" would only
 * produce a confusing error at commit instead of a clear one here.
 */
export async function createJob(input: CreateJobInput): Promise<Job> {
  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.job.create({
      data: {
        userId: input.userId,
        sourceUrl: input.sourceUrl,
        sourceKey: input.sourceKey,
        originalFilename: input.originalFilename,
        subtitles: input.subtitles ?? true,
        sourceDurationSec: input.sourceDurationSec,
        status: "PENDING",
      },
    });

    if (input.freeCharge) {
      await tx.freeUsage.create({
        data: {
          userId: input.userId,
          jobId: created.id,
          kind: "CHARGE",
          seconds: input.freeCharge.seconds,
          estimatedCostUsd: input.freeCharge.estimatedCostUsd,
        },
      });
    }

    return created;
  });

  await getStageQueue("download").add(
    "download",
    {
      jobId: job.id,
      userId: job.userId,
    },
    // Only free jobs carry a priority. Passing one for paid jobs would move
    // them OFF the wait list into the prioritized set, which - per the read of
    // moveToActive above - is the slower of the two, so "being explicit" would
    // make paying users worse off.
    input.freeCharge ? { priority: FREE_JOB_PRIORITY } : undefined
  );

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
