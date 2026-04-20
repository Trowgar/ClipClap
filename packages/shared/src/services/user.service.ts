import { prisma } from "../lib/prisma";
import { getPlanLimits } from "../config/plans";
import type { User, Plan } from "@prisma/client";

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

export async function getWeeklyUsage(userId: string): Promise<number> {
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  return prisma.job.count({
    where: {
      userId,
      createdAt: { gte: oneWeekAgo },
      status: { not: "FAILED" },
    },
  });
}

export async function canCreateJob(userId: string): Promise<{
  allowed: boolean;
  reason?: string;
  usage: number;
  limit: number;
}> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const limits = getPlanLimits(user.plan);
  const usage = await getWeeklyUsage(userId);

  if (usage >= limits.videosPerWeek) {
    return {
      allowed: false,
      reason: `Weekly limit reached (${usage}/${limits.videosPerWeek}). Upgrade your plan for more.`,
      usage,
      limit: limits.videosPerWeek,
    };
  }

  return { allowed: true, usage, limit: limits.videosPerWeek };
}

export async function getUsage(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const limits = getPlanLimits(user.plan);
  const weeklyUsage = await getWeeklyUsage(userId);

  return {
    plan: user.plan,
    videosUsed: weeklyUsage,
    videosLimit: limits.videosPerWeek,
    maxDurationMinutes: limits.maxDurationMinutes,
  };
}
