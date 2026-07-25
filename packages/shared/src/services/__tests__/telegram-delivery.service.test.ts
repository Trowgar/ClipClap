import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  telegramDeliveryCreate: vi.fn(),
  telegramDeliveryFindMany: vi.fn(),
  telegramDeliveryUpdate: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    telegramDelivery: {
      create: mocks.telegramDeliveryCreate,
      findMany: mocks.telegramDeliveryFindMany,
      update: mocks.telegramDeliveryUpdate,
    },
  },
}));

import {
  createTelegramDelivery,
  getPendingTelegramDeliveries,
  isPermanentTelegramError,
  markTelegramDeliveryAttemptFailed,
  markTelegramDeliveryFailed,
  markTelegramDeliveryFailureNotified,
  markTelegramDeliverySent,
  MAX_TELEGRAM_DELIVERY_ATTEMPTS,
} from "../telegram-delivery.service";

describe("telegram-delivery.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a pending delivery for a bot-created job", async () => {
    mocks.telegramDeliveryCreate.mockResolvedValue({ id: "delivery1" });

    await createTelegramDelivery({
      jobId: "job1",
      userId: "user1",
      chatId: "12345",
    });

    expect(mocks.telegramDeliveryCreate).toHaveBeenCalledWith({
      data: {
        jobId: "job1",
        userId: "user1",
        chatId: "12345",
      },
    });
  });

  it("loads pending deliveries with completed or failed jobs, and re-picks a notified failure whose job has since healed", async () => {
    // A stage writes Job.status FAILED on EVERY BullMQ attempt, not only the
    // last one, so a delivery can be notified of a failure that attempt 2 then
    // heals. FAILURE_NOTIFIED rows must come back once the job reaches DONE -
    // otherwise the user is billed for clips the bot never sends. They must NOT
    // come back while the job is still FAILED (that would re-notify every 10s),
    // and a terminal FAILED row (the send itself threw) is never re-picked.
    await getPendingTelegramDeliveries(10);

    expect(mocks.telegramDeliveryFindMany).toHaveBeenCalledWith({
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
      take: 10,
    });
  });

  it("marks delivery as sent", async () => {
    await markTelegramDeliverySent("delivery1");

    expect(mocks.telegramDeliveryUpdate).toHaveBeenCalledWith({
      where: { id: "delivery1" },
      data: {
        status: "DELIVERED",
        deliveredAt: expect.any(Date),
        attempts: 0,
        error: null,
      },
    });
  });

  it("marks delivery as failed", async () => {
    await markTelegramDeliveryFailed("delivery1", "send failed");

    expect(mocks.telegramDeliveryUpdate).toHaveBeenCalledWith({
      where: { id: "delivery1" },
      data: {
        status: "FAILED",
        error: "send failed",
      },
    });
  });

  it("marks a delivered failure notice as FAILURE_NOTIFIED, not FAILED", async () => {
    // Two different events used to share the FAILED state: "the job failed and
    // we told the user" (which a retry can still turn into clips) and "our own
    // send threw" (terminal). Only the first may be re-picked.
    await markTelegramDeliveryFailureNotified("delivery1", "boom");

    expect(mocks.telegramDeliveryUpdate).toHaveBeenCalledWith({
      where: { id: "delivery1" },
      data: {
        status: "FAILURE_NOTIFIED",
        // this pass ended in a real outcome, so the clips delivery that may
        // follow it starts from a full budget
        attempts: 0,
        error: "boom",
      },
    });
  });

  describe("the attempt budget", () => {
    // getPendingTelegramDeliveries takes 20 rows and has no other drain, so a
    // pre-send failure that never goes terminal holds a twentieth of the whole
    // bot's delivery capacity for ever.
    it("keeps the row re-pickable while the budget lasts", async () => {
      mocks.telegramDeliveryUpdate.mockResolvedValue({});

      const { terminal } = await markTelegramDeliveryAttemptFailed(
        "delivery1",
        "connection reset",
        0
      );

      expect(terminal).toBe(false);
      expect(mocks.telegramDeliveryUpdate).toHaveBeenCalledWith({
        where: { id: "delivery1" },
        // increment, not a computed absolute: the read and the write are not
        // one transaction
        data: { attempts: { increment: 1 }, error: "connection reset" },
      });
    });

    it("retires the row on the last attempt", async () => {
      mocks.telegramDeliveryUpdate.mockResolvedValue({});

      const { terminal } = await markTelegramDeliveryAttemptFailed(
        "delivery1",
        "connection reset",
        MAX_TELEGRAM_DELIVERY_ATTEMPTS - 1
      );

      expect(terminal).toBe(true);
      expect(mocks.telegramDeliveryUpdate).toHaveBeenCalledWith({
        where: { id: "delivery1" },
        data: {
          attempts: { increment: 1 },
          error: "connection reset",
          status: "FAILED",
        },
      });
    });

    it("spans more than a minute of polling, and stays bounded", () => {
      // The poller runs every 10s. The budget must outlast a Telegram 429
      // backoff (~60s) and a Postgres failover, without letting one dead row
      // hold a window slot for anything like the user's patience.
      expect(MAX_TELEGRAM_DELIVERY_ATTEMPTS * 10).toBeGreaterThanOrEqual(120);
      expect(MAX_TELEGRAM_DELIVERY_ATTEMPTS * 10).toBeLessThanOrEqual(300);
    });
  });

  describe("permanent Telegram errors", () => {
    it("recognises the chats that will never accept a message", () => {
      for (const message of [
        "Forbidden: bot was blocked by the user",
        "Forbidden: bot was kicked from the group chat",
        "Forbidden: user is deactivated",
        "Bad Request: chat not found",
        "Bad Request: PEER_ID_INVALID",
        "Bad Request: CHAT_WRITE_FORBIDDEN",
        "Bad Request: have no rights to send a message",
      ]) {
        expect(isPermanentTelegramError(message)).toBe(true);
      }
    });

    it("does not condemn the faults that really do heal", () => {
      // Spending clips on a false positive is worse than spending 12 polls on
      // a true negative: these all come back.
      for (const message of [
        "429: Too Many Requests: retry after 30",
        "Bad Request: failed to get HTTP URL content",
        "Bad Request: wrong file identifier/HTTP URL specified",
        "Internal Server Error",
        "connection reset by peer",
        "Timed out fetching a new connection from the connection pool",
      ]) {
        expect(isPermanentTelegramError(message)).toBe(false);
      }
    });
  });
});
