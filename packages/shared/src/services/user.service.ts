import { prisma } from "../lib/prisma";
import type { User } from "@prisma/client";
import { getUsageForUser, canSubmitJob } from "./usage.service";

export async function getUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

export async function getUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

export async function getUserByTelegramId(
  telegramId: string
): Promise<User | null> {
  return prisma.user.findUnique({ where: { telegramId } });
}

export async function getUsage(userId: string) {
  return getUsageForUser(userId);
}

export async function canCreateJob(
  userId: string,
  jobDurationMinutes: number
): Promise<{ allowed: boolean; reason?: string }> {
  return canSubmitJob(userId, jobDurationMinutes);
}
