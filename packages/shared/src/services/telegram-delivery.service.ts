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

export async function getPendingTelegramDeliveries(take = 20) {
  return prisma.telegramDelivery.findMany({
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
