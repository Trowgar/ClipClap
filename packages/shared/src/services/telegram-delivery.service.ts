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
 *   - FAILED, ever - terminal, and it means either "a video is already in the
 *     chat and the delivery then threw" (re-running would give the user a
 *     second copy) or "this delivery can never succeed";
 *   - DELIVERED, ever.
 *
 * A pass that threw BEFORE anything reached the chat keeps its status, which is
 * what brings it back here - but it costs one of
 * MAX_TELEGRAM_DELIVERY_ATTEMPTS, and the last one moves it to FAILED. That
 * bound is not a nicety: `take` is 20, so a row that stays here for ever holds
 * a twentieth of the whole bot's delivery capacity, and twenty of them hold all
 * of it. Nothing else drains this window - there is no offset, no jitter, no
 * second ordering - so without the bound one blocked user per slot stops every
 * delivery for every other user, indefinitely.
 *
 * Every pickup therefore ends in DELIVERED or FAILED (both terminal), or in
 * FAILURE_NOTIFIED - which only re-enters this set when Job.status changes to
 * DONE, an event that happens at most once - or in a spent attempt. So a row
 * can be delivered at most twice (one failure notice, one set of clips) and can
 * be picked up only a bounded number of times.
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
            // Defensive: a delivery normally runs minutes after render and the
            // shortest retention is 3 days. In a backlog long enough to cross
            // that, the alternative is the bot sending a signed URL for an
            // object the sweep already dropped.
            where: { deletedAt: null },
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

/**
 * How many consecutive PRE-SEND failures a delivery may collect before it is
 * retired.
 *
 * The poller runs once every 10s (apps/bot/src/index.ts), and a row in the
 * window is tried on every poll, so 12 attempts buys a fault about two minutes
 * to heal. That is chosen against what actually fails here:
 *   - a Telegram 429 asks for at most ~60s of backoff, so it heals with 100%
 *     headroom;
 *   - a Postgres pool timeout or a failover is tens of seconds;
 *   - an R2 5xx burst is seconds.
 * Anything still broken after two solid minutes is not a blip, and the cost of
 * waiting longer is not paid by the stuck row - it is paid by everyone behind
 * it, because the pickup window is only 20 rows wide. Two minutes bounds that
 * damage at two minutes; the clips themselves are never lost, they stay in the
 * dashboard.
 */
export const MAX_TELEGRAM_DELIVERY_ATTEMPTS = 12;

/**
 * Telegram errors that will never heal, however long we wait.
 *
 * These do not deserve the attempt budget: a user who blocked the bot yields
 * 403 on every single send, so spending the budget means 12 polls x N clips of
 * doomed API calls, which is also the fastest way to trip the bot's global rate
 * limit and degrade delivery for everyone else. Detection is a string match
 * because that is all the Bot API gives us in the message.
 *
 * Deliberately narrow: only phrases that name the CHAT as unreachable. A bare
 * "Bad Request" or a 400 about the file is not here - those really do heal (a
 * presigned URL that expired mid-flight, a transcoding hiccup), and treating
 * them as permanent would throw away deliverable clips.
 */
const PERMANENT_TELEGRAM_ERRORS = [
  "bot was blocked by the user",
  "bot was kicked",
  "user is deactivated",
  "chat not found",
  "peer_id_invalid",
  "chat_write_forbidden",
  "have no rights to send a message",
];

export function isPermanentTelegramError(message: string): boolean {
  const haystack = message.toLowerCase();
  return PERMANENT_TELEGRAM_ERRORS.some((needle) => haystack.includes(needle));
}

/**
 * A pass threw before ANYTHING reached the chat. Nothing is owed to the chat
 * and nothing can be duplicated, so the row stays re-pickable - but it now
 * costs one attempt, and the last attempt retires it.
 *
 * `attemptsSoFar` is the value read by the same poll that is now failing (the
 * poller is single-threaded, so it is fresh); the write itself increments
 * atomically, so the stored count is right even if that ever stops being true.
 * One write, not two: a second write is a second chance to throw, and a throw
 * here must never be able to leave the row un-counted.
 */
export async function markTelegramDeliveryAttemptFailed(
  deliveryId: string,
  error: string,
  attemptsSoFar: number
): Promise<{ terminal: boolean }> {
  const terminal = attemptsSoFar + 1 >= MAX_TELEGRAM_DELIVERY_ATTEMPTS;
  await prisma.telegramDelivery.update({
    where: { id: deliveryId },
    data: {
      attempts: { increment: 1 },
      error,
      ...(terminal ? { status: "FAILED" as const } : {}),
    },
  });
  return { terminal };
}

export async function markTelegramDeliverySent(deliveryId: string) {
  return prisma.telegramDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "DELIVERED",
      deliveredAt: new Date(),
      attempts: 0,
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
      // This pass ENDED, in a real outcome the user can see. Whatever was
      // flaky before it has healed, so the clips delivery that may follow gets
      // a full budget of its own rather than the remains of this one.
      attempts: 0,
      error,
    },
  });
}

/**
 * Terminal - see getPendingTelegramDeliveries. Two callers may use it:
 *   - one that has actually put a video in the chat and then threw, because
 *     re-running would give the user a second copy;
 *   - one that knows the delivery can never succeed - the attempt budget is
 *     spent, or Telegram says the chat is unreachable for good.
 * A pre-send failure that is merely the latest of a few is NOT one of them:
 * use markTelegramDeliveryAttemptFailed, which keeps the row re-pickable until
 * the budget runs out.
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
