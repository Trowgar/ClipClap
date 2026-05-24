import { randomBytes } from "crypto";
import { prisma } from "../lib/prisma";
import {
  TELEGRAM_AUTH_ACCOUNT_TYPE,
  TELEGRAM_AUTH_PROVIDER,
} from "./telegram-auth.service";

const TOKEN_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export interface LinkToken {
  code: string;
  expiresAt: Date;
}

export type LinkRedemptionResult =
  | { status: "linked"; userId: string; mergedJobs: number; mergedClips: number }
  | { status: "already_linked"; userId: string }
  | { status: "invalid_code" }
  | { status: "expired" }
  | { status: "consumed" }
  | { status: "wrong_direction" }
  | { status: "target_already_linked" };

export async function createBotInitiatedLink({
  telegramId,
}: {
  telegramId: string;
}): Promise<LinkToken> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await prisma.telegramLinkToken.create({
    data: { code, telegramId, expiresAt },
  });
  return { code, expiresAt };
}

export async function createBrowserInitiatedLink({
  userId,
}: {
  userId: string;
}): Promise<LinkToken> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await prisma.telegramLinkToken.create({
    data: { code, userId, expiresAt },
  });
  return { code, expiresAt };
}

export async function redeemLinkFromBot({
  code,
  telegramId,
}: {
  code: string;
  telegramId: string;
}): Promise<LinkRedemptionResult> {
  const token = await prisma.telegramLinkToken.findUnique({ where: { code } });
  if (!token) return { status: "invalid_code" };
  if (token.consumedAt) return { status: "consumed" };
  if (token.expiresAt < new Date()) return { status: "expired" };
  if (!token.userId) return { status: "wrong_direction" };

  return linkTelegramToUser({
    code,
    userId: token.userId,
    telegramId,
  });
}

export async function redeemLinkFromBrowser({
  code,
  userId,
}: {
  code: string;
  userId: string;
}): Promise<LinkRedemptionResult> {
  const token = await prisma.telegramLinkToken.findUnique({ where: { code } });
  if (!token) return { status: "invalid_code" };
  if (token.consumedAt) return { status: "consumed" };
  if (token.expiresAt < new Date()) return { status: "expired" };
  if (!token.telegramId) return { status: "wrong_direction" };

  return linkTelegramToUser({
    code,
    userId,
    telegramId: token.telegramId,
  });
}

async function linkTelegramToUser({
  code,
  userId,
  telegramId,
}: {
  code: string;
  userId: string;
  telegramId: string;
}): Promise<LinkRedemptionResult> {
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) return { status: "invalid_code" };

  if (target.telegramId === telegramId) {
    await prisma.telegramLinkToken.update({
      where: { code },
      data: { consumedAt: new Date() },
    });
    return { status: "already_linked", userId };
  }

  if (target.telegramId && target.telegramId !== telegramId) {
    return { status: "target_already_linked" };
  }

  const orphan = await prisma.user.findUnique({ where: { telegramId } });
  const orphanId = orphan && orphan.id !== userId ? orphan.id : null;

  const result = await prisma.$transaction(async (tx) => {
    let mergedJobs = 0;
    let mergedClips = 0;

    if (orphanId) {
      const jobs = await tx.job.updateMany({
        where: { userId: orphanId },
        data: { userId },
      });
      mergedJobs = jobs.count;

      const clips = await tx.clip.updateMany({
        where: { userId: orphanId },
        data: { userId },
      });
      mergedClips = clips.count;

      await tx.telegramDelivery.updateMany({
        where: { userId: orphanId },
        data: { userId },
      });

      await tx.account.deleteMany({
        where: {
          userId: orphanId,
          provider: TELEGRAM_AUTH_PROVIDER,
        },
      });

      await tx.user.update({
        where: { id: orphanId },
        data: { telegramId: null },
      });

      await tx.user.delete({ where: { id: orphanId } });
    }

    await tx.user.update({
      where: { id: userId },
      data: { telegramId },
    });

    const existingAccount = await tx.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: TELEGRAM_AUTH_PROVIDER,
          providerAccountId: telegramId,
        },
      },
    });

    if (!existingAccount) {
      await tx.account.create({
        data: {
          userId,
          type: TELEGRAM_AUTH_ACCOUNT_TYPE,
          provider: TELEGRAM_AUTH_PROVIDER,
          providerAccountId: telegramId,
        },
      });
    } else if (existingAccount.userId !== userId) {
      await tx.account.update({
        where: {
          provider_providerAccountId: {
            provider: TELEGRAM_AUTH_PROVIDER,
            providerAccountId: telegramId,
          },
        },
        data: { userId },
      });
    }

    await tx.telegramLinkToken.update({
      where: { code },
      data: { consumedAt: new Date() },
    });

    return { mergedJobs, mergedClips };
  });

  return {
    status: "linked",
    userId,
    mergedJobs: result.mergedJobs,
    mergedClips: result.mergedClips,
  };
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}
