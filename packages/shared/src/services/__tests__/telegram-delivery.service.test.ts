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

  it("loads pending deliveries with completed or failed jobs", async () => {
    await getPendingTelegramDeliveries(10);

    expect(mocks.telegramDeliveryFindMany).toHaveBeenCalledWith({
      where: {
        status: "PENDING",
        job: { status: { in: ["DONE", "FAILED"] } },
      },
      include: {
        job: {
          include: {
            clips: { orderBy: { startTime: "asc" } },
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
});
