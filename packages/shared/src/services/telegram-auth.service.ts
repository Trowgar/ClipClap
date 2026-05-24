import { prisma } from "../lib/prisma";
import type { User } from "@prisma/client";

export const TELEGRAM_AUTH_PROVIDER = "telegram";
export const TELEGRAM_AUTH_ACCOUNT_TYPE = "oidc";

export interface TelegramAuthAccountResult {
  userId: string;
  linked: boolean;
}

export interface TelegramUserProfile {
  id: string | number;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  photoUrl?: string | null;
  languageCode?: string | null;
}

export async function findOrCreateTelegramUser(
  profile: TelegramUserProfile
): Promise<User> {
  const telegramId = String(profile.id);
  const existingUser = await prisma.user.findUnique({
    where: { telegramId },
  });

  if (existingUser) {
    await ensureTelegramAuthAccount(telegramId);
    return existingUser;
  }

  const user = await prisma.user.create({
    data: {
      telegramId,
      telegramLocale: profile.languageCode ?? undefined,
      name: getTelegramDisplayName(profile),
      image: profile.photoUrl ?? undefined,
    },
  });

  await prisma.account.create({
    data: {
      userId: user.id,
      type: TELEGRAM_AUTH_ACCOUNT_TYPE,
      provider: TELEGRAM_AUTH_PROVIDER,
      providerAccountId: telegramId,
    },
  });
  return user;
}

export async function ensureTelegramAuthAccount(
  telegramId: string
): Promise<TelegramAuthAccountResult | null> {
  const existingAccount = await prisma.account.findUnique({
    where: {
      provider_providerAccountId: {
        provider: TELEGRAM_AUTH_PROVIDER,
        providerAccountId: telegramId,
      },
    },
    select: { userId: true },
  });

  if (existingAccount) {
    return { userId: existingAccount.userId, linked: false };
  }

  const existingTelegramUser = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });

  if (!existingTelegramUser) return null;

  await prisma.account.create({
    data: {
      userId: existingTelegramUser.id,
      type: TELEGRAM_AUTH_ACCOUNT_TYPE,
      provider: TELEGRAM_AUTH_PROVIDER,
      providerAccountId: telegramId,
    },
  });

  return { userId: existingTelegramUser.id, linked: true };
}

export async function syncUserTelegramId(
  userId: string,
  telegramId: string
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { telegramId },
  });
}

function getTelegramDisplayName(profile: TelegramUserProfile): string {
  const fullName = [profile.firstName, profile.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  return fullName || profile.username || `Telegram ${profile.id}`;
}
