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
  markTelegramDeliveryFailed,
  markTelegramDeliveryFailureNotified,
  markTelegramDeliverySent,
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
        error: "boom",
      },
    });
  });
});
