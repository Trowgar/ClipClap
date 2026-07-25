import { prisma } from "../lib/prisma";

export interface CreateTelegramDeliveryInput {
  jobId: string;
  userId: string;
  chatId: string;
}

export async function createTelegramDelivery(
  input: CreateTelegramDeliveryInput
) {
  return prisma.telegramDelivery.create({
    data: {
      jobId: input.jobId,
      userId: input.userId,
      chatId: input.chatId,
    },
  });
}

/**
 * Rows the poller may act on.
 *
 * PENDING + DONE/FAILED is the normal case: the job reached an answer and the
 * user has not been told anything yet.
 *
 * FAILURE_NOTIFIED + DONE is the recovery case. The worker stages write
 * Job.status FAILED inside their catch on EVERY BullMQ attempt, not only the
 * last one (apps/worker/src/stages/download.ts, analyze.ts, render.ts), so the
 * poller routinely sees FAILED while two retries are still queued. When one of
 * them succeeds the job ends DONE, usage.service bills it (it sums every job
 * that is not FAILED) and the clips exist - so refusing to look at the row
 * again means the user pays for clips the bot never sends. The web app has no
 * such hole: it re-reads the Job row on every mount.
 *
 * What is deliberately NOT here:
 *   - FAILURE_NOTIFIED while the job is still FAILED - that would repeat the
 *     failure message every 10 seconds;
 *   - FAILED, ever - that state now means one thing only: a video is already in
 *     the chat and the delivery then threw, so re-running it would give the
 *     user a second copy. A delivery that threw BEFORE any video was sent is
 *     left in its current status instead (see deliverReadyTelegramJobs), which
 *     is what brings it back here;
 *   - DELIVERED, ever.
 * Every pickup ends in DELIVERED or FAILED (both terminal) or, for a still
 * FAILED job, back in FAILURE_NOTIFIED - which only re-enters this set when
 * Job.status changes to DONE, an event that happens at most once. So a row can
 * be delivered at most twice: one failure notice, one set of clips.
 */
export async function getPendingTelegramDeliveries(take = 20) {
  return prisma.telegramDelivery.findMany({
    where: {
      OR: [
        {
          status: "PENDING",
          job: { status: { in: ["DONE", "FAILED"] } },
        },
        {
          status: "FAILURE_NOTIFIED",
          job: { status: "DONE" },
        },
      ],
    },
    include: {
      job: {
        include: {
          clips: {
            orderBy: [
              { score: { sort: "desc", nulls: "last" } },
              { startTime: "asc" },
            ],
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take,
  });
}

export async function markTelegramDeliverySent(deliveryId: string) {
  return prisma.telegramDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "DELIVERED",
      deliveredAt: new Date(),
      error: null,
    },
  });
}

/**
 * The user has been told the job failed. Use this - never
 * markTelegramDeliveryFailed - whenever the failure being reported is the
 * JOB's: the stage may be on attempt 1 of 3, and a later attempt that heals the
 * job must still be able to deliver the clips.
 */
export async function markTelegramDeliveryFailureNotified(
  deliveryId: string,
  error: string
) {
  return prisma.telegramDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "FAILURE_NOTIFIED",
      error,
    },
  });
}

/**
 * A video had already reached the chat when the delivery threw. Terminal - see
 * getPendingTelegramDeliveries. Only the caller that has actually sent a video
 * may use this: for anything that failed earlier, leaving the row untouched is
 * correct, because nothing was delivered and nothing can be duplicated.
 */
export async function markTelegramDeliveryFailed(
  deliveryId: string,
  error: string
) {
  return prisma.telegramDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "FAILED",
      error,
    },
  });
}
